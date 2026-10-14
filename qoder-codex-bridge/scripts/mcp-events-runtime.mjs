import { createHmac, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadReadPolicy, verifyReadSession } from "./codex-read.mjs";
import { createMcpEventsCore } from "./mcp-events.mjs";
import { createMcpEventsTransport } from "./mcp-events-transport.mjs";
import { writeManagedAtomicIf, writeManagedExclusive } from "./store-budget.mjs";

const fail = (message, code = -32001, reason) => { throw Object.assign(Error(message), { code, ...(reason ? { data: { reason } } : {}) }); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const subscriptionId = /^sub_[0-9a-f]{64}$/;
const fileName = /^events-subscription-([0-9a-f]{64})\.json$/;
const secret = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const DEFAULT_TTL_MS = 300_000, MAX_ATTEMPTS = 3, ROTATION_MS = 30_000;
const scope = policy => JSON.stringify([policy.mode, policy.sessionId, policy.ownerPid, policy.ownerUrl,
  [...policy.workspaceRoots].sort()]);

export function privateConnectionFromEnv(env = process.env) {
  if (env.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION === undefined) return null;
  let connection;
  try { connection = JSON.parse(env.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION); } catch { fail("events_connection_invalid"); }
  if (!object(connection) || Object.keys(connection).length !== 4 || connection.schemaVersion !== 1 || connection.kind !== "privateConnection"
    || typeof connection.principalId !== "string" || !connection.principalId.trim() || connection.principalId.length > 512
    || typeof connection.readSessionId !== "string" || !uuid.test(connection.readSessionId)) fail("events_connection_invalid");
  return Object.freeze({ ...connection });
}

// This is the user's private-connection delegation, not a platform-authenticated Dot identity.
// Only the trusted launcher supplies connection/environment; RPC params and _meta never select it.
export function createMcpEventsRuntime({ dataDir, readPolicyPath, connection, readReceipt, env = process.env,
  transport = createMcpEventsTransport(), now = Date.now, pause = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (!connection || privateConnectionFromEnv({ CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: JSON.stringify(connection) }) === null
    || typeof readReceipt !== "function") fail("events_connection_invalid");
  connection = privateConnectionFromEnv({ CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: JSON.stringify(connection) });
  const initial = loadReadPolicy(readPolicyPath, { env });
  if (initial.mode !== "temporary" || initial.sessionId !== connection.readSessionId) fail("events_not_authorized");
  const grantScope = scope(initial), root = realpathSync.native(resolve(dataDir));
  const context = Object.freeze({ privateConnection: connection.principalId });
  const candidates = new Map(), running = new Map();

  async function permitted(principal, _name, args) {
    try {
      if (principal !== connection.principalId) return false;
      const policy = loadReadPolicy(readPolicyPath, { env });
      if (scope(policy) !== grantScope || policy.sessionId !== connection.readSessionId) return false;
      if (args && !policy.threadIds.includes(args.threadId)) return false;
      await verifyReadSession(policy, env);
      // A still-live old supervisor cannot certify a policy revoked/retargeted while we awaited it.
      const latest = loadReadPolicy(readPolicyPath, { env });
      return scope(latest) === grantScope && latest.sessionId === connection.readSessionId
        && (!args || latest.threadIds.includes(args.threadId));
    } catch { return false; }
  }
  const core = createMcpEventsCore({ authenticate: input => input === context ? connection.principalId : null,
    authorize: permitted, readReceipt });
  const pathFor = id => { if (!subscriptionId.test(id)) fail("events_record_invalid"); return join(root, `events-subscription-${id.slice(4)}.json`); };

  function stored(id) {
    const path = pathFor(id);
    let fd;
    try {
      if (realpathSync.native(path) !== path) fail("events_record_invalid");
      const expected = statSync(path);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 16384 || before.dev !== expected.dev || before.ino !== expected.ino) fail("events_record_invalid");
      const buffer = Buffer.alloc(16385), length = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) fail("events_record_invalid");
      const raw = buffer.subarray(0, length).toString("utf8");
      let record;
      try { record = JSON.parse(raw); } catch { fail("events_record_invalid"); }
      if (!object(record) || record.schemaVersion !== 1 || record.id !== id || record.principalId !== connection.principalId
        || record.readSessionId !== connection.readSessionId || record.name !== "codex.message.accepted"
        || !object(record.arguments) || typeof record.arguments.requestId !== "string" || !uuid.test(record.arguments.requestId)
        || typeof record.arguments.threadId !== "string" || !uuid.test(record.arguments.threadId)
        || typeof record.url !== "string" || typeof record.secret !== "string" || !secret.test(record.secret)
        || !iso(record.refreshBefore) || typeof record.generation !== "string" || !uuid.test(record.generation)
        || !["pending", "active", "inactive"].includes(record.state)
        || !object(record.delivery) || record.delivery.eventId !== `codex_accepted_${record.arguments.requestId}`
        || !["pending", "in_flight", "received", "stopped", "exhausted"].includes(record.delivery.state)
        || !Number.isSafeInteger(record.delivery.attempts) || record.delivery.attempts < 0 || record.delivery.attempts > MAX_ATTEMPTS
        || (record.delivery.state === "in_flight" && (!iso(record.delivery.retryAfter) || !uuid.test(record.delivery.attemptId ?? "")))
        || (record.previousSecret !== undefined && (typeof record.previousSecret !== "string" || !secret.test(record.previousSecret) || !iso(record.overlapUntil))))
        fail("events_record_invalid");
      return { raw, record };
    } catch (error) { if (error.code === "ENOENT") return null; if (typeof error.code === "number") throw error; fail("events_record_invalid"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function save(id, previous, record) {
    if (Buffer.byteLength(JSON.stringify(record)) > 16384) fail("events_record_invalid");
    if (previous === null) writeManagedExclusive(root, pathFor(id), record);
    else if (!writeManagedAtomicIf(root, pathFor(id), previous.raw, record)) fail("events_subscription_superseded");
    const current = stored(id);
    if (!current || current.record.generation !== record.generation || current.record.state !== record.state) fail("events_subscription_superseded");
    return current;
  }
  async function current(id, generation, states = ["active"]) {
    const saved = stored(id);
    if (!saved || saved.record.generation !== generation || !states.includes(saved.record.state) || Date.parse(saved.record.refreshBefore) <= now()
      || await permitted(connection.principalId, saved.record.name, saved.record.arguments) !== true) fail("events_not_authorized");
    // Permission checks await the supervisor; a concurrent unsubscribe/rotation must still win.
    const latest = stored(id);
    if (!latest || latest.raw !== saved.raw) fail("events_subscription_superseded");
    // After every await, recheck the latest grant/target and TTL as well as the unchanged generation/state.
    const policy = loadReadPolicy(readPolicyPath, { env });
    if (scope(policy) !== grantScope || policy.sessionId !== connection.readSessionId
      || !policy.threadIds.includes(latest.record.arguments.threadId) || Date.parse(latest.record.refreshBefore) <= now()) fail("events_not_authorized");
    return latest;
  }
  async function verify(candidate, generation, states) {
    const attempt = core.verification(candidate, now());
    try {
      const response = await transport(attempt.request, { assertActive: async () => { await current(candidate.id, generation, states); return true; } });
      let body;
      try { body = JSON.parse(response.body); } catch { fail("CallbackEndpointError", -32015, "challenge_failed"); }
      attempt.verify(response.status, body, now());
      await current(candidate.id, generation, states);
    } catch (error) {
      if (error.code === -32015) throw error;
      fail("CallbackEndpointError", -32015, error.code === "webhook_timeout" ? "timeout" : "challenge_failed");
    }
  }
  const asParams = record => ({ name: record.name, arguments: record.arguments,
    delivery: { mode: "webhook", url: record.url, secret: record.secret }, cursor: null });

  async function candidateFor(record) {
    const cached = candidates.get(record.id);
    if (cached?.generation === record.generation) return cached.candidate;
    const candidate = await core.prepareSubscribe(context, asParams(record));
    if (candidate.id !== record.id) fail("events_record_invalid");
    await verify(candidate, record.generation, ["active"]); // Rebuild capability after restart; never renew the stored TTL.
    candidates.set(record.id, { generation: record.generation, candidate });
    return candidate;
  }
  async function deliver(id) {
    let saved = stored(id);
    if (!saved || saved.record.state !== "active" || ["received", "stopped", "exhausted"].includes(saved.record.delivery.state)) return;
    const generation = saved.record.generation;
    saved = await current(id, generation);
    const candidate = await candidateFor(saved.record);
    if (!await core.acceptedEvent(candidate)) return;
    while (true) {
      saved = await current(id, generation);
      if (["received", "stopped", "exhausted"].includes(saved.record.delivery.state)) return;
      if (saved.record.delivery.state === "in_flight" && Date.parse(saved.record.delivery.retryAfter) > now()) {
        await pause(Math.min(10000, Date.parse(saved.record.delivery.retryAfter) - now())); continue;
      }
      if (saved.record.delivery.attempts >= MAX_ATTEMPTS) {
        save(id, saved, { ...saved.record, delivery: { ...saved.record.delivery, state: "exhausted" } }); return;
      }
      const packet = await core.prepareDelivery(candidate, now());
      if (!packet) return;
      saved = await current(id, generation);
      const record = saved.record;
      if (record.previousSecret && Date.parse(record.overlapUntil) > now()) {
        const signature = createHmac("sha256", Buffer.from(record.previousSecret.slice(6), "base64"))
          .update(`${packet.headers["webhook-id"]}.${packet.headers["webhook-timestamp"]}.${packet.body}`).digest("base64");
        packet.headers["webhook-signature"] += ` v1,${signature}`;
      }
      const attemptId = randomUUID();
      saved = save(id, saved, { ...record, delivery: { ...record.delivery, state: "in_flight", attempts: record.delivery.attempts + 1,
        attemptId, retryAfter: new Date(now() + 10000).toISOString() } });
      let response;
      try { response = await transport(packet, { assertActive: async () => {
        const latest = await current(id, generation); return latest.record.delivery.attemptId === attemptId;
      } }); }
      catch (error) { if (error.code === "webhook_grant_inactive") return; }
      saved = await current(id, generation);
      if (saved.record.delivery.attemptId !== attemptId) return;
      const received = response?.status >= 200 && response.status < 300;
      const stopped = [410, 413].includes(response?.status);
      const transient = !response || response.status === 408 || response.status === 429 || response.status >= 500;
      const state = received ? "received" : stopped || !transient ? "stopped" : saved.record.delivery.attempts >= MAX_ATTEMPTS ? "exhausted" : "pending";
      save(id, saved, { ...saved.record, delivery: { ...saved.record.delivery, state } });
      if (state !== "pending") return;
      await pause(1000 * 2 ** (saved.record.delivery.attempts - 1));
    }
  }
  function run(id) {
    const key = `${id}:${stored(id)?.record.generation}`;
    if (running.has(key)) return running.get(key);
    const task = deliver(id).finally(() => running.delete(key));
    running.set(key, task); return task;
  }
  function ids() { return readdirSync(root).flatMap(name => { const match = fileName.exec(name); return match ? [`sub_${match[1]}`] : []; }); }

  return {
    async discover() { if (await permitted(connection.principalId, "codex.message.accepted", null) !== true) fail("events_not_authorized");
      return { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } }; },
    async assertGrantActive() { if (await permitted(connection.principalId, "codex.message.accepted", null) !== true) fail("read_not_authorized");
      return loadReadPolicy(readPolicyPath, { env }); },
    async list(params = {}) {
      if (!object(params) || Object.keys(params).some(key => !["cursor", "_meta"].includes(key))
        || (params.cursor !== undefined && params.cursor !== null && params.cursor !== "")
        || (params._meta !== undefined && !object(params._meta))) fail("invalid_event_request", -32602);
      // Single-page catalog; transport metadata never selects a principal or changes the private grant.
      return core.list(context);
    },
    async subscribe(params) {
      const candidate = await core.prepareSubscribe(context, params), previous = stored(candidate.id), timestamp = now();
      const refreshBefore = new Date(timestamp + Math.min(params.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS)).toISOString();
      const record = { schemaVersion: 1, id: candidate.id, principalId: candidate.principalId, readSessionId: connection.readSessionId,
        name: candidate.name, arguments: candidate.arguments, url: candidate.url, secret: candidate.secret,
        generation: randomUUID(), state: "pending", refreshBefore,
        delivery: previous?.record.delivery.state === "stopped" && previous.record.state === "inactive"
          ? { ...previous.record.delivery, state: "pending" }
          : previous?.record.delivery ?? { eventId: `codex_accepted_${candidate.arguments.requestId}`, state: "pending", attempts: 0 },
        ...(previous?.record.state === "active" && previous.record.secret !== candidate.secret ? {
          previousSecret: previous.record.secret, overlapUntil: new Date(Math.min(timestamp + ROTATION_MS, Date.parse(refreshBefore))).toISOString() } : {}) };
      const pending = save(candidate.id, previous, record);
      await verify(candidate, record.generation, ["pending"]);
      await current(candidate.id, record.generation, ["pending"]);
      save(candidate.id, pending, { ...record, state: "active" });
      candidates.set(candidate.id, { generation: record.generation, candidate });
      return { id: candidate.id, refreshBefore, cursor: null, truncated: false };
    },
    async unsubscribe(params) {
      const identity = await core.prepareUnsubscribe(context, params), previous = stored(identity.id);
      if (previous && previous.record.state !== "inactive") save(identity.id, previous, {
        ...previous.record, generation: randomUUID(), state: "inactive", delivery: { ...previous.record.delivery, state: "stopped" } });
      candidates.delete(identity.id);
      return {};
    },
    async notifyAccepted(requestId) {
      for (const id of ids()) { try { const saved = stored(id); if (saved?.record.arguments.requestId === requestId) await run(id); }
        catch { /* One invalid, expired or superseded subscription cannot activate or block another. */ } }
    },
    async resume() { for (const id of ids()) { try { await run(id); } catch { /* Expired, revoked or conflicting subscriptions never restart delivery. */ } } }
  };
}
