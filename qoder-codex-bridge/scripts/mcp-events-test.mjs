import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let moduleUrl = new URL("./mcp-events.mjs", import.meta.url);
if (process.env.MCP_EVENTS_TEST_MUTATION === "bypass_authorization") {
  const source = readFileSync(moduleUrl, "utf8");
  const broken = source.replace('if (await authorize(principalId, name, args) !== true)', 'if (false)');
  assert.notEqual(broken, source, "mutation must change the disposable module");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(broken).toString("base64")}`;
}
const { createMcpEventsCore, acceptedEventDefinition } = await import(moduleUrl);
const requestId = "11111111-2222-3333-4444-555555555555", threadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const context = Object.freeze({ serviceIdentity: "test-only-owner" });
const secret = `whsec_${Buffer.alloc(32, 66).toString("base64")}`;
const params = { name: "codex.message.accepted", arguments: { requestId, threadId },
  delivery: { mode: "webhook", url: "https://receiver.example/callback", secret }, cursor: null };
let permitted = true, receiptReads = 0;
let receipt = { requestId, threadId, deliveryId: `codex:${requestId}`, state: "accepted", acceptedAt: "2026-10-10T00:00:00Z",
  acceptance: { provider: { state: "accepted", evidence: "persisted_native_host_ack" } },
  message: "must never leave the persisted receipt projection", businessAcceptance: { state: "unknown" } };
const core = createMcpEventsCore({ authenticate: input => input === context ? "owner-A" : null,
  authorize: (principal, event, args) => permitted && principal === "owner-A" && event === params.name && (args === null || args.requestId === requestId && args.threadId === threadId),
  readReceipt: id => { assert.equal(id, requestId); receiptReads++; return structuredClone(receipt); } });
const code = expected => error => error.code === expected;

assert.throws(() => createMcpEventsCore(), code(-32001));
await assert.rejects(core.list({ principalId: "owner-A" }), code(-32001));
await assert.rejects(core.prepareSubscribe({}, params), code(-32001));
await assert.rejects(core.prepareSubscribe(context, { ...params, principalId: "owner-A" }), code(-32602));
const listing = await core.list(context);
assert.equal(listing.events[0].name, params.name);
listing.events[0].name = "tampered";
assert.equal(acceptedEventDefinition.name, params.name);
const subscription = await core.prepareSubscribe(context, params);
assert(Object.isFrozen(subscription) && Object.isFrozen(subscription.arguments));
const reordered = await core.prepareSubscribe(context, { ...params, arguments: { threadId, requestId }, delivery: { ...params.delivery, secret: `whsec_${Buffer.alloc(24, 77).toString("base64")}` } });
assert.equal(reordered.id, subscription.id, "key order and key rotation must not create a new identity");
const stopped = await core.prepareUnsubscribe(context, { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } });
assert.equal(stopped.id, subscription.id);
assert.equal(stopped.secret, undefined);
const metadata = { progressToken: "metadata-must-not-propagate", principalId: "forged-owner", id: "forged-subscription",
  arguments: { requestId: threadId, threadId: requestId }, url: "https://metadata.example/ignored", secret: "forged-secret", ttlMs: 1 };
const metaParams = { ...params, _meta: metadata }, stopParams = { name: params.name, arguments: params.arguments,
  delivery: { mode: "webhook", url: params.delivery.url }, _meta: metadata };
const metaAttempts = await Promise.allSettled([core.prepareSubscribe(context, metaParams), core.prepareUnsubscribe(context, stopParams)]);
assert.deepEqual(metaAttempts.map(attempt => attempt.status), ["fulfilled", "fulfilled"], "both subscription methods must accept standard transport metadata");
const metaSubscription = metaAttempts[0].value;
assert.deepEqual(metaSubscription, subscription);
assert.deepEqual(metaAttempts[1].value, stopped);
await assert.rejects(core.prepareSubscribe({ _meta: { principalId: "owner-A" } }, metaParams), code(-32001));
await assert.rejects(core.prepareUnsubscribe({ _meta: { principalId: "owner-A" } }, stopParams), code(-32001));
for (const invalidMeta of [null, [], "metadata", 1, true]) {
  await assert.rejects(core.prepareSubscribe(context, { ...metaParams, _meta: invalidMeta }), code(-32602));
  await assert.rejects(core.prepareUnsubscribe(context, { ...stopParams, _meta: invalidMeta }), code(-32602));
}
await assert.rejects(core.prepareSubscribe(context, { ...metaParams, principalId: "owner-A" }), code(-32602));
await assert.rejects(core.prepareUnsubscribe(context, { ...stopParams, principalId: "owner-A" }), code(-32602));
for (const size of [24, 64]) await core.prepareSubscribe(context, { ...params, delivery: { ...params.delivery, secret: `whsec_${Buffer.alloc(size).toString("base64")}` } });
for (const bad of ["whsec_%%%", `whsec_${Buffer.alloc(23).toString("base64")}`, `whsec_${Buffer.alloc(65).toString("base64")}`, "whsec_AA"]) {
  await assert.rejects(core.prepareSubscribe(context, { ...params, delivery: { ...params.delivery, secret: bad } }), code(-32602));
}
for (const url of ["http://receiver.example/callback", "https://user:pass@receiver.example/", "https://receiver.example/#fragment"]) {
  await assert.rejects(core.prepareSubscribe(context, { ...params, delivery: { ...params.delivery, url } }), code(-32602));
}
await assert.rejects(core.prepareSubscribe(context, { ...params, cursor: "pretend-replay" }), code(-32602));
await assert.rejects(core.prepareSubscribe(context, { ...params, ttlMs: -1 }), code(-32602));
await assert.rejects(core.prepareSubscribe(context, { ...params, arguments: { ...params.arguments, owner: "forged" } }), code(-32602));

const now = 1791590400000;
await assert.rejects(core.prepareDelivery(subscription, now), /events_callback_not_verified/);
const verification = core.verification(subscription, now);
const challenge = JSON.parse(verification.request.body).challenge;
assert.equal(verification.request.redirect, "error");
assert.equal(verification.verify(200, { challenge }, now + 1), true);
assert.throws(() => verification.verify(200, { challenge }, now + 2), code(-32015));
for (const [status, response, delay] of [[200, { challenge: "forged" }, 1], [302, { challenge }, 1], [200, { challenge }, 10001]]) {
  const attempt = core.verification(subscription, now);
  assert.throws(() => attempt.verify(status, response, now + delay), code(-32015));
}
assert.throws(() => core.verification({ ...subscription }, now), code(-32001));

const event = await core.acceptedEvent(subscription);
assert.equal(event.timestamp, receipt.acceptedAt);
assert.equal(event.cursor, null);
assert.equal(event.data.evidence, "persisted_native_host_ack");
assert(!JSON.stringify(event).includes(receipt.message));
assert.equal(event.data.businessAcceptance, undefined);
const packet = await core.prepareDelivery(subscription, now);
assert.deepEqual(JSON.parse(packet.body), event);
assert.equal(packet.headers["webhook-id"], event.eventId);
assert.equal(packet.headers["webhook-signature"], "v1,gFuc0aXxwJlK/NdnS6QOCFohlevEOHMW/XM/Zpzb1Fw=");
const metaVerification = core.verification(metaSubscription, now);
assert.equal(metaVerification.request.url, params.delivery.url);
assert.deepEqual(Object.keys(JSON.parse(metaVerification.request.body)).sort(), ["challenge", "type"]);
metaVerification.verify(200, { challenge: JSON.parse(metaVerification.request.body).challenge }, now + 1);
assert.deepEqual(await core.prepareDelivery(metaSubscription, now), packet, "metadata cannot change callback URL, secret, identity or payload");
const retry = await core.prepareDelivery(subscription, now + 1000);
assert.equal(retry.headers["webhook-id"], packet.headers["webhook-id"]);
assert.notEqual(retry.headers["webhook-signature"], packet.headers["webhook-signature"]);
assert.equal(retry.body, packet.body);
receipt.acceptance.provider = { state: "unknown" };
await assert.rejects(core.prepareDelivery(subscription, now), /event_receipt_invalid/);
receipt.acceptance.provider = { state: "accepted", evidence: "persisted_native_host_ack" };

permitted = false;
const before = receiptReads;
assert.deepEqual(await core.list(context), { events: [] });
await assert.rejects(core.prepareSubscribe(context, params), code(-32001));
await assert.rejects(core.prepareSubscribe(context, metaParams), code(-32001));
await assert.rejects(core.prepareUnsubscribe(context, stopParams), code(-32001));
await assert.rejects(core.prepareDelivery(metaSubscription, now), code(-32001));
await assert.rejects(core.prepareUnsubscribe(context, { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } }), code(-32001));
await assert.rejects(core.prepareDelivery(subscription, now), code(-32001));
assert.equal(receiptReads, before, "revoked permission must block receipt read as well as delivery");
permitted = true;
receipt = { requestId, state: "not_found", deliveryId: `codex:${requestId}` };
assert.equal(await core.prepareDelivery(subscription, now), null, "missing receipts do not imply acceptance or non-delivery");
receipt = { requestId, threadId, state: "uncertain", deliveryId: `codex:${requestId}` };
assert.equal(await core.prepareDelivery(subscription, now), null);
receipt = { requestId, threadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", deliveryId: `codex:${requestId}`, state: "accepted", acceptedAt: "2026-10-10T00:00:00Z" };
await assert.rejects(core.prepareDelivery(subscription, now), /event_receipt_invalid/);
console.log("mcp-events SOURCE_OFFLINE preflight checks passed; no transport, persistence or Dot acceptance tested");
