import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Internal preflight only: no RPC registration, subscription storage, or network transport.
const fail = (message, code = -32602, reason) => {
  throw Object.assign(Error(message), { code, ...(reason ? { data: { reason } } : {}) });
};
const object = value => value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const name = "codex.message.accepted";

export const acceptedEventDefinition = {
  name, description: "A persisted native host ACK for one previously requested Codex message. Receipt only; recipient read, reply and business completion remain unknown.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: { requestId: { type: "string", format: "uuid" }, threadId: { type: "string", format: "uuid" } },
    required: ["requestId", "threadId"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { requestId: { type: "string", format: "uuid" }, threadId: { type: "string", format: "uuid" },
    deliveryId: { type: "string" }, state: { const: "accepted" }, evidence: { const: "persisted_native_host_ack" } },
    required: ["requestId", "threadId", "deliveryId", "state", "evidence"], additionalProperties: false }
};

function filters(value) {
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.requestId !== "string" || !uuid.test(value.requestId)
    || typeof value.threadId !== "string" || !uuid.test(value.threadId)) fail("invalid_event_arguments");
  // Fixed keys are canonical JSON for this single event; caller key order cannot alter identity.
  return { requestId: value.requestId, threadId: value.threadId };
}

function callbackUrl(value) {
  let url;
  try { if (typeof value !== "string" || value.length > 4096) throw Error(); url = new URL(value); }
  catch { fail("invalid_callback_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("invalid_callback_url");
  // HTTPS syntax is not SSRF protection. The transport must validate and pin DNS at every connection.
  return url.href;
}

function secretBytes(value) {
  if (typeof value !== "string" || value.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) fail("invalid_signing_secret");
  const encoded = value.slice(6), bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== encoded) fail("invalid_signing_secret");
  return bytes;
}

function signedPost(subscription, payload, webhookId, signedAt) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > 262144) fail("event_payload_too_large");
  const seconds = Math.floor(signedAt / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail("invalid_signing_time");
  const signature = createHmac("sha256", secretBytes(subscription.secret)).update(`${webhookId}.${seconds}.${body}`).digest("base64");
  return { url: subscription.url, method: "POST", redirect: "error", body,
    headers: { "Content-Type": "application/json", "webhook-id": webhookId, "webhook-timestamp": String(seconds),
      "webhook-signature": `v1,${signature}`, "X-MCP-Subscription-Id": subscription.id } };
}

export function createMcpEventsCore({ authenticate, authorize, readReceipt } = {}) {
  if (![authenticate, authorize, readReceipt].every(fn => typeof fn === "function")) fail("events_boundary_missing", -32001);
  const prepared = new WeakSet(), verified = new WeakSet();
  async function principal(context) {
    // Only a trusted service adapter may bind this context; never map it from RPC params or _meta.
    const id = await authenticate(context);
    if (typeof id !== "string" || !id || id.length > 512) fail("events_not_authenticated", -32001);
    return id;
  }
  async function permission(principalId, args) {
    if (await authorize(principalId, name, args) !== true) fail("events_not_authorized", -32001);
  }
  async function identity(context, params, subscribe) {
    const allowed = subscribe ? ["name", "arguments", "delivery", "cursor", "ttlMs", "_meta"] : ["name", "arguments", "delivery", "_meta"];
    if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || params.name !== name
      || (params._meta !== undefined && !object(params._meta))) fail("invalid_event_request");
    const args = filters(params.arguments), delivery = params.delivery;
    const deliveryKeys = subscribe ? ["mode", "url", "secret"] : ["mode", "url"];
    if (!object(delivery) || Object.keys(delivery).length !== deliveryKeys.length
      || Object.keys(delivery).some(key => !deliveryKeys.includes(key)) || delivery.mode !== "webhook") fail("invalid_event_delivery");
    const url = callbackUrl(delivery.url);
    if (subscribe) {
      secretBytes(delivery.secret);
      if (params.cursor !== undefined && params.cursor !== null) fail("event_replay_not_supported");
      if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) fail("invalid_event_ttl");
    }
    const principalId = await principal(context);
    await permission(principalId, args);
    const id = `sub_${createHash("sha256").update(JSON.stringify([principalId, url, name, args])).digest("hex")}`;
    return { id, principalId, name, arguments: args, url, ...(subscribe ? { secret: delivery.secret, requestedTtlMs: params.ttlMs } : {}) };
  }
  function candidate(value) {
    if (!prepared.has(value)) fail("events_subscription_not_prepared", -32001);
  }
  return {
    async list(context) {
      const id = await principal(context);
      return { events: await authorize(id, name, null) === true ? [structuredClone(acceptedEventDefinition)] : [] };
    },
    async prepareSubscribe(context, params) {
      const subscription = await identity(context, params, true);
      Object.freeze(subscription.arguments);
      Object.freeze(subscription);
      prepared.add(subscription);
      return subscription; // Internal only: contains secret; never return it as an RPC result or log it.
    },
    prepareUnsubscribe(context, params) { return identity(context, params, false); },
    verification(subscription, now = Date.now()) {
      candidate(subscription);
      const challenge = randomUUID(), request = signedPost(subscription, { type: "verification", challenge }, `verification_${randomUUID()}`, now);
      let used = false;
      return { request, verify(status, response, observedAt = Date.now()) {
        const unavailable = used || !Number.isSafeInteger(observedAt) || observedAt < now || observedAt - now > 10000;
        used = true;
        if (unavailable || !Number.isInteger(status) || status < 200 || status >= 300 || typeof response?.challenge !== "string")
          fail("CallbackEndpointError", -32015, "challenge_failed");
        const actual = Buffer.from(response.challenge), expected = Buffer.from(challenge);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("CallbackEndpointError", -32015, "challenge_failed");
        verified.add(subscription);
        return true; // This is verification evidence only; caller still must persist and activate atomically.
      } };
    },
    async acceptedEvent(subscription) {
      candidate(subscription);
      await permission(subscription.principalId, subscription.arguments);
      const receipt = await readReceipt(subscription.arguments.requestId);
      if (!object(receipt) || receipt.requestId !== subscription.arguments.requestId || receipt.deliveryId !== `codex:${receipt.requestId}`) fail("event_receipt_invalid");
      if (receipt.state === "not_found") return null;
      if (receipt.threadId !== subscription.arguments.threadId) fail("event_receipt_invalid");
      if (receipt.state === "uncertain") return null;
      if (receipt.state !== "accepted" || !iso(receipt.acceptedAt)
        || receipt.acceptance?.provider?.state !== "accepted" || receipt.acceptance.provider.evidence !== "persisted_native_host_ack") fail("event_receipt_invalid");
      return { eventId: `codex_accepted_${receipt.requestId}`, name, timestamp: receipt.acceptedAt,
        data: { requestId: receipt.requestId, threadId: receipt.threadId, deliveryId: receipt.deliveryId,
          state: "accepted", evidence: "persisted_native_host_ack" }, cursor: null };
    },
    async prepareDelivery(subscription, now = Date.now()) {
      if (!verified.has(subscription)) fail("events_callback_not_verified", -32001);
      const event = await this.acceptedEvent(subscription);
      return event ? signedPost(subscription, event, event.eventId, now) : null;
    }
  };
}
