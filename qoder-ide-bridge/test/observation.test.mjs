import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { observeMessages as observeClient } from "../../modules/agent-qoder-ide/client.mjs";
import { validateMessageObservation, decodeMessageObserveCursor } from "../../modules/agent-core/src/contracts.mjs";

const require = createRequire(import.meta.url);
const { observeMessages, ownerIdForStateDir, claimMutation, collectHook, reserveMessage, wireContent } = require("../extension/message-store.cjs");
const { startBridge } = require("../extension/extension.cjs");
const root = mkdtempSync(join(tmpdir(), "ide-observation-"));
const dir = join(root, "message-reservations");
mkdirSync(dir);
const ownerId = ownerIdForStateDir(root);
const instanceId = "11111111-1111-4111-8111-111111111111";
const requestId = index => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
const snapshot = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? snapshot(join(path, entry.name)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])
  : [[entry.name, readFileSync(join(path, entry.name)).toString("base64")]]);
const committed = (index, extra = {}) => {
  const record = { schemaVersion: 3, requestId: requestId(index), deliveryId: `delivery-${index}`, ownerId,
    allocatedBytes: 10_000_000, instanceId, workspace: root, retrySafe: false,
    reservedAt: "2026-10-02T00:00:00.000Z", correlation: "fixture", command: { state: "returned_delivery_unobserved" },
    content: '<script>alert("XSS")</script>' + "x".repeat(600), ...extra };
  const text = JSON.stringify(record);
  writeFileSync(join(dir, `${record.requestId}.json`), text);
  const capacity = 65536 + (typeof record.content === "string" ? Buffer.byteLength(JSON.stringify(record.content)) : 0);
  writeFileSync(join(dir, `${record.requestId}.headroom`), Buffer.alloc(2 * capacity - Buffer.byteLength(text)));
};
const observe = args => validateMessageObservation(observeMessages(root, args));
try {
  for (let i = 1; i <= 4; i++) committed(i);
  committed(1, { provider: { observedAt: "2026-10-02T00:00:01.000Z", sessionId: "private-session",
    transcriptPath: join(root, "do-not-open-transcript"), requestSetId: "private-request" },
    reply: { state: "observed", preview: '<img src=x onerror="alert(1)">', observedAt: "2026-10-02T00:00:02.000Z",
      stopHookActive: false, truncated: true, businessAcceptance: "unobserved" } });
  committed(4, { content: undefined });
  const before = snapshot(root);
  const first = observe({ view: "items", limit: 2, correlation: "fixture" });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].content.text.length, 512);
  assert.equal(first.items[0].content.truncated, true);
  assert.equal(first.items[0].evidence.providerAccepted, true);
  assert.equal(first.items[0].evidence.consumerConfirmed, "unknown");
  assert.equal(first.items[0].evidence.businessAccepted, "unknown");
  assert.equal(first.items[0].reply.stopHookActive, false);
  assert.equal(first.items[0].reply.content.truncated, true);
  assert.equal(first.hasMore, true);
  assert.equal(decodeMessageObserveCursor(first.nextCursor, { moduleId: "agent-qoder-ide", ownerId,
    view: "items", filters: { correlation: "fixture" } }), requestId(2));
  const next = observe({ view: "items", limit: 2, correlation: "fixture", cursor: first.nextCursor });
  assert.equal(next.items.length, 2);
  assert.equal(next.items[1].content.reason, "not_recorded");
  assert.equal(next.hasMore, false);
  assert.equal(observe({ view: "stats", limit: 1 }).stats.total, 4);
  assert.equal(observe({ view: "stats", limit: 1 }).stats.byState.returned_delivery_unobserved, 3);
  const detail = observe({ view: "detail", requestId: requestId(1), deliveryId: "delivery-1" });
  assert.equal(detail.item.content.text, '<script>alert("XSS")</script>' + "x".repeat(600));
  assert.equal(detail.item.content.truncated, false);
  assert.equal(detail.item.trace.events.length, 3);
  const serialized = JSON.stringify(detail);
  assert(!serialized.includes(root));
  assert(!serialized.includes("private-session"));
  assert(!serialized.includes("private-request"));
  assert(serialized.includes("<script>"));
  assert.equal(observe({ view: "detail", deliveryId: "pruned-or-unknown" }).item, null);
  assert.equal(observe({ view: "items", requestId: requestId(1), correlation: "not-fixture" }).items.length, 0);
  assert.throws(() => observe({ view: "detail" }), /Invalid/);
  assert.throws(() => observe({ view: "items", limit: 0 }), /Invalid/);
  assert.throws(() => observe({ view: "items", cursor: first.nextCursor, correlation: "changed" }), /changed filters/);
  assert.deepEqual(observeClient({ view: "stats" }, { stateDir: root }).stats, observe({ view: "stats" }).stats);
  assert.deepEqual(snapshot(root), before);
  rmSync(join(dir, `${requestId(2)}.json`));
  rmSync(join(dir, `${requestId(2)}.headroom`));
  const pruned = snapshot(root);
  assert.deepEqual(observe({ view: "items", correlation: "fixture", cursor: first.nextCursor }).items
    .map(item => item.requestId), [requestId(3), requestId(4)]);
  assert.equal(observe({ view: "detail", requestId: requestId(2) }).item, null);
  assert.deepEqual(snapshot(root), pruned);
  committed(2);
  const modulePath = require.resolve("../extension/message-store.cjs");
  const child = spawnSync(process.execPath, ["-e", `const fs = require('node:fs');
    for (const key of ['mkdirSync','unlinkSync','writeFileSync','renameSync','ftruncateSync','fsyncSync']) fs[key] = () => { throw Error('read attempted mutation: ' + key); };
    const originalOpen = fs.openSync; fs.openSync = (path, flag, ...args) => { if (typeof flag !== 'number' || flag & 3) throw Error('write open'); return originalOpen(path, flag, ...args); };
    require('node:worker_threads').Worker = class { constructor() { throw Error('read entered recovery lock'); } };
    const store = require(${JSON.stringify(modulePath)});
    for (const key of ['readMessage','collectHook','reserveMessage','claimMutation']) store[key] = () => { throw Error('read called ' + key); };
    const result = store.observeMessages(${JSON.stringify(root)}, {view:'stats'});
    require('node:assert/strict').equal(result.stats.total, 4);`], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(snapshot(root), before);
  const configPath = join(root, "fixture-config.json"), token = "offline-fixture-token-0123456789-abcdefgh";
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, stateDir: root, token,
    allowedCommands: ["workbench.action.aichat.sendText"], timeoutMs: 100 }));
  const bridge = await startBridge({ env: { uriScheme: "qoder-cn" }, workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => ({ get: () => configPath }) },
    commands: { getCommands: () => assert.fail("observation queried live commands"),
      executeCommand: () => assert.fail("observation dispatched a command") } }, { subscriptions: [] },
    { randomUUID: () => instanceId });
  try {
    const beforeRoute = snapshot(root), endpoint = `${bridge.record.endpoint}v1/message/observe`;
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ view: "stats", limit: 1 }) });
    assert.equal(response.status, 200);
    assert.equal(validateMessageObservation(await response.json()).stats.total, 4);
    const rejected = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ view: "items", consumerId: "must-not-confirm" }) });
    assert.equal(rejected.status, 400);
    const unauthorized = await fetch(endpoint, { method: "POST", body: JSON.stringify({ view: "stats" }) });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(snapshot(root), beforeRoute);
  } finally { await bridge.dispose(); rmSync(configPath); }
  for (const name of [".owner.lock", "transaction.tmp", "orphan.headroom"]) {
    writeFileSync(join(dir, name), "preserve-me");
    const damaged = snapshot(root);
    const result = observe({ view: "stats" });
    assert.equal(result.stats.total, "unknown");
    assert.equal(result.coverage.complete, false);
    assert(result.coverage.limitations.includes("recovery_required"));
    assert.deepEqual(snapshot(root), damaged);
    rmSync(join(dir, name));
  }
  const missing = join(root, "missing");
  const unavailable = observeMessages(missing, { view: "stats" });
  assert.equal(unavailable.stats.total, "unknown");
  assert.equal(unavailable.coverage.complete, false);
  assert(!readdirSync(root).includes("missing"));
  // New send reservation stores its body in the original owner record; allocated headroom bounds it.
  const id = requestId(5);
  claimMutation({ stateDir: root, ownerId, allocatedBytes: 10_000_000, requestId: id,
    instanceId, workspace: root, command: "workbench.action.aichat.sendText" });
  reserveMessage({ stateDir: root, ownerId, allocatedBytes: 10_000_000, requestId: id, deliveryId: "new-body",
    instanceId, workspace: root, content: "new reserved content", correlation: "new" });
  assert.equal(observe({ view: "detail", requestId: id }).item.content.text, "new reserved content");
  const largeId = requestId(6), largeContent = "测".repeat(16000), allocatedBytes = 10_000_000;
  claimMutation({ stateDir: root, ownerId, allocatedBytes, requestId: largeId, instanceId,
    workspace: root, command: "workbench.action.aichat.sendText" });
  reserveMessage({ stateDir: root, ownerId, allocatedBytes, requestId: largeId, deliveryId: "large-body",
    instanceId, workspace: root, content: largeContent, correlation: "large" });
  const largePath = join(dir, `${largeId}.json`), roomPath = join(dir, `${largeId}.headroom`);
  const admitted = readFileSync(largePath).length + readFileSync(roomPath).length;
  assert.equal(admitted, 2 * (65536 + Buffer.byteLength(JSON.stringify(largeContent))));
  const largeConfig = join(root, "large-config.json");
  writeFileSync(largeConfig, JSON.stringify({ schemaVersion: 1, stateDir: root }));
  const hook = { session_id: "fixture-native-session", cwd: root, transcript_path: join(root, "no-real-transcript"),
    request_set_id: "fixture-native-request" };
  assert.equal(collectHook(JSON.stringify({ ...hook, hook_event_name: "UserPromptSubmit",
    prompt: wireContent(largeContent, largeId) }), largeConfig), "recorded");
  assert.equal(collectHook(JSON.stringify({ ...hook, hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: "\u0000".repeat(8000) }), largeConfig), "recorded");
  assert(readFileSync(largePath).length > 65536, "body must not consume legal Hook update capacity");
  assert.equal(readFileSync(largePath).length + readFileSync(roomPath).length, admitted);
  const fullDetail = observe({ view: "detail", requestId: largeId });
  assert.equal(fullDetail.item.content.text, largeContent);
  assert.equal(fullDetail.item.reply.content.text.length, 4096);
  assert(Buffer.byteLength(JSON.stringify(fullDetail)) < 131072);
  assert(Buffer.byteLength(JSON.stringify(fullDetail)) > 65536);
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, stateDir: root, token,
    allowedCommands: ["workbench.action.aichat.sendText"], timeoutMs: 100 }));
  const largeBridge = await startBridge({ env: { uriScheme: "qoder-cn" }, workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => ({ get: () => configPath }) },
    commands: { getCommands: () => assert.fail("detail queried commands"), executeCommand: () => assert.fail("detail sent") } },
    { subscriptions: [] }, { randomUUID: () => instanceId });
  try {
    const beforeLargeRoute = snapshot(root);
    const response = await fetch(`${largeBridge.record.endpoint}v1/message/observe`, { method: "POST",
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ view: "detail", requestId: largeId }) });
    assert.equal(response.status, 200);
    assert.equal(validateMessageObservation(await response.json()).item.content.text, largeContent);
    assert.deepEqual(snapshot(root), beforeLargeRoute);
  } finally { await largeBridge.dispose(); rmSync(configPath); }
  const smallOwner = join(root, "small-owner"); mkdirSync(smallOwner);
  const smallOwnerId = ownerIdForStateDir(smallOwner);
  claimMutation({ stateDir: smallOwner, ownerId: smallOwnerId, allocatedBytes: 140_000,
    requestId: largeId, instanceId, workspace: root, command: "workbench.action.aichat.sendText" });
  const beforeRefusal = snapshot(smallOwner);
  assert.throws(() => reserveMessage({ stateDir: smallOwner, ownerId: smallOwnerId, allocatedBytes: 140_000,
    requestId: largeId, deliveryId: "large-body", instanceId, workspace: root, content: largeContent,
    correlation: "large" }), /budget exceeded/);
  assert.deepEqual(snapshot(smallOwner), beforeRefusal, "body bytes must be admitted before reservation writes");
  const moduleRoot = fileURLToPath(new URL("../../modules/agent-qoder-ide/", import.meta.url));
  assert.deepEqual(readFileSync(join(moduleRoot, "runtime/message-observe.cjs")),
    readFileSync(fileURLToPath(new URL("../extension/message-observe.cjs", import.meta.url))));
  assert.deepEqual(readFileSync(join(moduleRoot, "runtime/core-contracts.mjs")),
    readFileSync(fileURLToPath(new URL("../../modules/agent-core/src/contracts.mjs", import.meta.url))));
  const isolatedModule = join(root, "isolated-module");
  cpSync(moduleRoot, isolatedModule, { recursive: true });
  const isolated = await import(pathToFileURL(join(isolatedModule, "adapter.mjs")));
  assert.equal((await isolated.describe()).find(operation => operation.name === "message_observe").annotations.readOnlyHint, true);
  const beforeIsolated = snapshot(root);
  const detached = await isolated.call("message_observe", { view: "detail", requestId: largeId }, { config: { stateDir: root } });
  assert.equal(detached.item.content.text, largeContent);
  assert.deepEqual(snapshot(root), beforeIsolated, "independent module revision must observe without repo dependencies or writes");
  console.log("IDE retained message observation tests passed (offline, no application)");
} finally { rmSync(root, { recursive: true, force: true }); }
