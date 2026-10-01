import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, decode, frames, FrameReader, checksum } from "./remote-codec.mjs";
import { RemoteClient, validateRemoteUrl } from "./remote-client.mjs";
import { normalizeTask, callRemoteTool, waitForTask, waitForMessages, readMany, waitForMany } from "./remote-tools.mjs";
import { messagePage } from "./remote-messages.mjs";
import { callConfigTool, readConfig, validateConfig, writeConfig } from "./config.mjs";
import { callPublicTool } from "./tools.mjs";

const bridge = { bridgeSessionId: "test", bridgeGeneration: 1, initialTaskId: "sess_test", workspacePath: "test-workspace" };
assert.equal(checksum(Buffer.from("123456789")), "cbf43926");
const value = [100, 1, "中文", { ok: true, nested: [null, false] }, undefined, Buffer.from([0, 255])];
assert.deepEqual(decode(encode(value)), [value]);
assert.throws(() => decode(Buffer.from([4, 255, 255, 255, 255, 127])));
assert.throws(() => decode(Buffer.from([1, 100, 0])));
const payload = encode("汉字".repeat(100000)), parts = frames(payload, bridge, 1), reader = new FrameReader();
assert(parts.length > 1);
assert.equal(reader.accept(parts[1]), null);
assert.equal(reader.accept(parts[1]), null);
assert.deepEqual(reader.accept(parts[0]), payload);
assert.throws(() => new FrameReader().accept({ ...frames(encode("x"), bridge, 2)[0], checksum: { algorithm: "crc32", value: "00000000" } }));
assert.throws(() => validateRemoteUrl("https://example.com/remote/v4?sid=x&hash=x&mid=x"));
assert.throws(() => validateRemoteUrl("https://zcode.z.ai/remote/v4?sid=x&sid=y&hash=x&mid=x"));
assert.equal(normalizeTask({ displayStatus: "error" }).status, "failed");
assert.deepEqual(normalizeTask({ displayStatus: "error", lastError: "DEVICE_OFFLINE" }).nativeExecutionFailure,
  { stage: "native_execution", source: "zcode_native", reason: "device_offline", code: "DEVICE_OFFLINE" });
assert.equal(normalizeTask({ displayStatus: "__proto__" }).status, "unknown");
assert.equal(normalizeTask({ updatedAt: 1 }).status, "unknown", "Stale time must never infer interruption");

const configDir = mkdtempSync(join(tmpdir(), "zcode-ops-"));
const previousConfig = process.env.ZCODE_OPS_CONFIG;
process.env.ZCODE_OPS_CONFIG = join(configDir, "config.json");
try {
  assert.throws(() => validateConfig({ schemaVersion: 1, promptOnStartup: true, sharingLink: null, extra: true }));
  writeConfig({ sharingLink: null });
  assert.equal(readConfig().sharingLink, null);
  const invalidPath = join(configDir, "invalid.json");
  process.env.ZCODE_OPS_CONFIG = invalidPath; writeFileSync(invalidPath, "not json");
  assert.equal((await callConfigTool("zcode_config_status")).valid, false);
  process.env.ZCODE_OPS_CONFIG = join(configDir, "config.json");
  const set = await callConfigTool("zcode_config_set", { sharingLink: "not-prevalidated-secret" });
  assert.equal(set.configured, true); assert(!JSON.stringify(set).includes("secret"));
  const status = await callConfigTool("zcode_config_status"); assert.equal(status.valid, true); assert(!JSON.stringify(status).includes("secret"));
  await callConfigTool("zcode_config_clear"); assert.equal(readConfig().sharingLink, null);
} finally {
  if (previousConfig === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = previousConfig;
  rmSync(configDir, { recursive: true, force: true });
}

const calls = [];
let bridgeOpen, createdTaskId = "sess_created";
let currentModel = "builtin:bigmodel-coding-plan/GLM-5.3-Flash";
const modelOptions = [
  { value: "builtin:bigmodel-coding-plan/GLM-5.3-Flash", name: "GLM-5.3-Flash" },
  { value: "custom/deepseek-v4-flash-vision-exp", name: "deepseek-v4-flash-vision-exp" }
];
const configOptions = () => [{ id: "model", category: "model", currentValue: currentModel, options: modelOptions },
  { id: "thoughtLevel", category: "thought_level", currentValue: "max", options: [] }];
const snapshot = () => ({ messages: [{ id: "answer", role: "assistant", content: "你好" }], runtime: {}, history: { totalMessages: 1 },
  meta: { model: currentModel, thoughtLevel: "max" }, configOptions: configOptions() });
class FakeSocket extends EventTarget {
  readyState = 0;
  awaitingAck = null;
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  send(raw) {
    const m = JSON.parse(raw);
    queueMicrotask(() => {
      if (m.type === "auth_init") this.message({ type: "auth_challenge", nonce: "test-nonce" });
      else if (m.type === "auth_response") this.message({ type: "auth_ack", pair_status: "matched" });
      else if (m.payload?.zcode_type === "workspace-list-request") this.message({ type: "data", payload: { zcode_type: "workspace-list-response", requestId: m.payload.requestId, result: { workspaces: [{ kind: "local", workspacePath: "test-workspace", connectionState: "connected" }], tasks: [{ taskId: "sess_test" }] } } });
      else if (m.payload?.zcode_type === "workspace-bridge-open") {
        bridgeOpen = m.payload;
        Object.assign(bridge, { bridgeSessionId: m.payload.bridgeSessionId });
        if (m.payload.taskId) bridge.initialTaskId = m.payload.taskId; else delete bridge.initialTaskId;
        this.message({ type: "data", payload: { zcode_type: "workspace-bridge-ready", bridgeSessionId: bridge.bridgeSessionId, bridge } });
      } else if (m.payload?.zcode_type === "rpc-frame-ack") {
        if (m.payload.bridgeSessionId === bridge.bridgeSessionId && m.payload.bridgeGeneration === bridge.bridgeGeneration &&
            m.payload.ackMessageSeq === this.awaitingAck) this.awaitingAck = null;
      } else if (m.payload?.zcode_type === "rpc-frame") {
        // Saturated native bridges resume only after an identity-matching ACK.
        if (this.awaitingAck !== null) return;
        const [header, args] = decode(new FrameReader().accept(m.payload));
        calls.push({ header, args });
        if (header[3] === "getTaskSnapshot" && args[0].resumeModelPolicy !== "ui-resolved-only") {
          const bytes = Buffer.concat([encode([202, header[1]]), encode("Historical model unavailable")]);
          this.message({ type: "data", payload: frames(bytes, bridge, header[1])[0] }); return;
        }
        if (header[3] === "setConfigOption") currentModel = args[0].value;
        const body = header[3] === "getTaskSnapshot" ? snapshot() : header[3] === "getTaskConfigOptions" ? configOptions() :
          header[3] === "createTask" ? { taskId: createdTaskId } : { accepted: true };
        const bytes = Buffer.concat([encode([201, header[1]]), encode(body)]);
        this.awaitingAck = header[1];
        this.message({ type: "data", payload: frames(bytes, bridge, header[1])[0] });
      }
    });
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const url = "https://zcode.z.ai/remote/v4?sid=test-session&hash=test-password&mid=test-device";
// Desktop-sized incoming fragments must pass the full receive/decode path.
// Synthetic data reproduces the observed 2,395,800-byte / four-fragment snapshot.
const largeBody = "x".repeat(2395788);
const largeBytes = Buffer.concat([encode([201, 99]), encode(largeBody)]);
assert.equal(largeBytes.length, 2395800);
const desktopChunkSize = 786177;
const desktopParts = Array.from({ length: Math.ceil(largeBytes.length / desktopChunkSize) }, (_, i) => ({
  ...frames(encode("metadata"), bridge, 99)[0], fragmentIndex: i,
  fragmentCount: Math.ceil(largeBytes.length / desktopChunkSize), messageBytes: largeBytes.length,
  checksum: { algorithm: "crc32", value: checksum(largeBytes) },
  dataBase64: largeBytes.subarray(i * desktopChunkSize, (i + 1) * desktopChunkSize).toString("base64")
}));
const receiver = new RemoteClient(url);
receiver.bridge = bridge;
const acknowledgments = [];
receiver.payload = value => acknowledgments.push(value);
let received;
receiver.deliver = value => { received = value; };
for (const part of [...desktopParts].reverse()) {
  const raw = JSON.stringify({ type: "data", payload: part });
  assert(raw.length < 1024 * 1024);
  await receiver.receive(raw);
}
assert.equal(received.body, largeBody);
assert.equal(acknowledgments.length, 1);
assert.deepEqual(acknowledgments[0], { zcode_type: "rpc-frame-ack", bridgeSessionId: bridge.bridgeSessionId,
  bridgeGeneration: bridge.bridgeGeneration, ackMessageSeq: 99 }, "ACK must match the native bridge generation to drain large replies");
assert.equal(receiver.reader.pending.size, 0);
assert.throws(() => new FrameReader().accept({ ...desktopParts[0], dataBase64: "A".repeat(1024 * 1024 + 4) }), /Invalid remote frame/);
assert.throws(() => new FrameReader().accept({ ...desktopParts[0], messageBytes: 16 * 1024 * 1024 + 1 }), /Invalid remote frame/);
await assert.rejects(receiver.receive(" ".repeat(1024 * 1024 + 1)), /physical frame exceeds limit/);
const client = new RemoteClient(url, { WebSocketClass: FakeSocket, timeoutMs: 200 });
await client.connect(); assert.equal((await client.list()).tasks[0].taskId, "sess_test");
await client.open({ taskId: "sess_test", workspacePath: "test-workspace", workspaceKind: "local" });
assert.equal((await client.snapshot("sess_test")).messages[0].content, "你好");
await client.setModel("sess_test", "model", "custom/deepseek-v4-flash-vision-exp");
assert.equal((await client.snapshot("sess_test")).meta.model, "custom/deepseek-v4-flash-vision-exp");
assert.equal((await client.send("sess_test", "自述进展")).result.accepted, true);
assert.equal(calls.at(-1).args[0].content, "自述进展");
assert.equal(calls.at(-1).args[0].clientMode, "web-remote-replayable");
assert(!("model" in calls.at(-1).args[0])); assert(!("permissionPolicy" in calls.at(-1).args[0]));
await client.stop({ taskId: "sess_test", workspacePath: "test-workspace" });
assert.equal(calls.at(-1).header[3], "stopGeneration");
assert.deepEqual(calls.at(-1).args[0], { taskId: "sess_test", workspacePath: "test-workspace" });
await client.openWorkspace({ workspacePath: "test-workspace", kind: "local" });
assert.equal(Object.hasOwn(bridgeOpen, "taskId"), false, "New-task bridge must omit taskId");
assert.equal((await client.createTask({ workspacePath: "test-workspace" })).taskId, "sess_created");
assert.deepEqual(calls.at(-1).args[0], { workspacePath: "test-workspace", deferPersistenceUntilFirstPrompt: true });
await client.openWorkspace({ workspacePath: "test-workspace", workspaceIdentity: "remote-identity", kind: "remote", connectionState: "connected" });
assert.equal(bridgeOpen.workspaceKey, "remote-identity");
assert.equal(Object.hasOwn(bridgeOpen, "taskId"), false);
assert.equal((await client.createTask({ workspacePath: "test-workspace", workspaceIdentity: "remote-identity" })).taskId, "sess_created");
assert.deepEqual(calls.at(-1).args[0], { workspacePath: "test-workspace", workspaceIdentity: "remote-identity",
  deferPersistenceUntilFirstPrompt: true });
await assert.rejects(client.createTask({ workspacePath: "other-workspace" }), /differs from the attached workspace/);
createdTaskId = "made-up";
await assert.rejects(client.createTask({ workspacePath: "test-workspace" }), /invalid created task ID/);
createdTaskId = "sess_created";
await assert.rejects(client.rpc("deleteTask", {}), /not allowed/);
assert(!client.sanitized(Error("test-password")).message.includes("test-password"));
for (const code of ["ZCODE_TASK_NOT_FOUND", "DEVICE_OFFLINE"]) {
  const safe = client.sanitized(Object.assign(Error(`test-password ${url}`), { code, details: "test-password" }));
  assert.equal(client.sanitized(safe).code, code, "Nested sanitization preserves recognized failure codes");
  assert(!safe.message.includes("test-password")); assert(!safe.message.includes("https://"));
  assert.equal(safe.details, undefined);
}
assert.equal(client.sanitized(Object.assign(Error("failure"), { code: "test-password" })).code, undefined);
assert.equal(client.sanitized(Object.assign(Error("native rejected"), { rpcRejected: true })).rpcRejected, true);
const waiting = client.wait(() => false); await client.close(); await assert.rejects(waiting, /ended/);
const offline = new RemoteClient(url, { timeoutMs: 5 });
await assert.rejects(offline.wait(() => false), /timed out/);

const task = { taskId: "sess_test", workspaceKind: "local", workspacePath: "test-workspace", displayStatus: "completed" };
let sends = 0;
currentModel = modelOptions[0].value;
const connect = action => action({ list: async () => ({ workspaces: [], tasks: [task, { ...task, taskId: "sess_archive", archived: true }] }),
  open: async () => {}, snapshot: async () => snapshot(), configOptions: async () => configOptions(), setModel: async (_taskId, _configId, value) => { currentModel = value; },
  send: async () => { sends++; throw Error("timeout"); } });
const list = await callRemoteTool("zcode_remote_tasks", {}, connect);
assert.equal(list.total, 1); assert.equal(list.summary.completed, 1);
const models = await callRemoteTool("zcode_remote_models", { taskId: "sess_test" }, connect);
assert.equal(models.currentModel, modelOptions[0].value); assert.equal(models.models.length, 2);
let invalidCurrentModel = true;
const unavailableConnect = action => action({ list: async () => ({ workspaces: [], tasks: [task, { ...task, taskId: "sess_anchor" }] }),
  open: async () => {}, configOptions: async taskId => { if (taskId === task.taskId && invalidCurrentModel) throw Error("model unavailable"); return configOptions(); },
  setModel: async () => { throw Error("Session is not active: sess_test"); },
  resume: async (_task, value) => { currentModel = value; invalidCurrentModel = false; } });
const recovered = await callRemoteTool("zcode_remote_set_model", { taskId: "sess_test", model: "deepseek-v4-flash-vision-exp" }, unavailableConnect);
assert.equal(recovered.recoveredUnavailableModel, true); assert.equal(recovered.optionsSourceTaskId, "sess_anchor");
currentModel = modelOptions[0].value;
const opened = [];
const fallbackConnect = action => action({ list: async () => ({ workspaces: [], tasks: [task, { ...task, taskId: "sess_anchor" }] }),
  open: async candidate => { opened.push(candidate.taskId); if (candidate.taskId === task.taskId) throw Error("superseded"); }, configOptions: async () => configOptions() });
await callRemoteTool("zcode_remote_models", { taskId: "sess_test" }, fallbackConnect);
assert.deepEqual(opened, ["sess_test", "sess_anchor"]);
const switched = await callRemoteTool("zcode_remote_set_model", { taskId: "sess_test", model: "deepseek-v4-flash-vision-exp" }, connect);
assert.equal(switched.currentModel, modelOptions[1].value); assert.equal(switched.changed, true);
const runningConnect = action => action({ list: async () => ({ workspaces: [], tasks: [{ ...task, displayStatus: "running" }] }), open: async () => { throw Error("must not open"); } });
await assert.rejects(callRemoteTool("zcode_remote_set_model", { taskId: "sess_test", model: "deepseek-v4-flash-vision-exp" }, runningConnect), /running turn/);
await assert.rejects(callRemoteTool("zcode_remote_send", { taskId: "sess_test", workspace: "wrong", prompt: "x" }, connect), /not found/);
await assert.rejects(callRemoteTool("zcode_remote_send", { taskId: "sess_archive", prompt: "x" }, connect), /Unarchive/);
await assert.rejects(callRemoteTool("zcode_remote_send", { taskId: "sess_test", prompt: "x" }, connect), /delivery is unknown/);
assert.equal(sends, 1, "Never retry a send automatically");
await assert.rejects(callRemoteTool("zcode_remote_tasks", { includeArchived: "false" }, connect), /Invalid/);
const read = await callRemoteTool("zcode_remote_read", { taskId: "sess_test" }, connect);
assert.equal(read.messages[0].content, "你好");
let inconsistentLists = 0;
const inconsistentStatuses = ["error", "completed", "completed"];
const inconsistent = await callRemoteTool("zcode_remote_read", { taskId: task.taskId }, action => action({
  list: async () => ({ tasks: [{ ...task, displayStatus: inconsistentStatuses[inconsistentLists++] }] }),
  open: async () => {}, snapshot: async () => ({ messages: [] })
}));
assert.equal(inconsistentLists, 3);
assert.equal(inconsistent.task.status, "failed");
assert.equal(inconsistent.observedLatestTask.status, "completed");
assert.equal(inconsistent.assistantTextReturned, false);
assert.equal(inconsistent.completionConfirmed, false);
const conflictStatuses = ["error", "completed", "completed", "completed", "completed", "completed"];
function sequencedRead(statuses) {
  const state = { statuses, lists: 0 };
  return { state, connect: action => action({
    list: async () => ({ tasks: [{ ...task, displayStatus: state.statuses[Math.min(state.lists++, state.statuses.length - 1)] }] }),
    open: async () => {}, snapshot: async () => ({ messages: [] })
  }) };
}
const publicSequence = sequencedRead(["completed", "completed", "completed"]);
const publicRemote = (name, args) => callRemoteTool(name, args, publicSequence.connect);
const publicBaseline = await callPublicTool("zcode_read", { view: "conversation", taskIds: [task.taskId] }, { remote: publicRemote });
publicSequence.state.statuses = conflictStatuses; publicSequence.state.lists = 0;
const publicConflict = await callPublicTool("zcode_read", { view: "conversation", taskIds: [task.taskId],
  cursor: publicBaseline.cursor, waitMs: 100 }, { remote: publicRemote });
assert.equal(publicSequence.state.lists, 3);
assert.equal(publicConflict.tasks[0].task.status, "failed");
assert.equal(publicConflict.tasks[0].completionConfirmed, false);
assert.equal(publicConflict.changed, true); assert.equal(publicConflict.reason, "changed");
const remoteSequence = sequencedRead(["completed", "completed", "completed"]);
const remoteBaseline = await callRemoteTool("zcode_remote_read", { taskId: task.taskId }, remoteSequence.connect);
remoteSequence.state.statuses = conflictStatuses; remoteSequence.state.lists = 0;
const remoteConflict = await callRemoteTool("zcode_remote_wait", { taskId: task.taskId, mode: "messages",
  afterCursor: remoteBaseline.cursor, timeoutMs: 100 }, remoteSequence.connect);
assert.equal(remoteSequence.state.lists, 3);
assert.equal(remoteConflict.task.status, "failed");
assert.equal(remoteConflict.completionConfirmed, false);
assert.equal(remoteConflict.changed, true); assert.equal(remoteConflict.reason, "state_changed");

// Batch reads use one bridge and run same-workspace snapshots concurrently.
const batchTask = { taskId: "sess_batch", workspaceKind: "local", workspacePath: "test-workspace", displayStatus: "running" };
const batchOther = { taskId: "sess_batch_other", workspaceKind: "local", workspacePath: "test-workspace", displayStatus: "running" };
let batchActive = 0, batchPeak = 0, batchOpens = 0;
const batchSnapshots = new Map([
  [batchTask.taskId, { messages: [{ id: "a", role: "assistant", content: "a" }] }],
  [batchOther.taskId, { messages: [{ id: "b", role: "assistant", content: "b" }] }]
]);
const batchConnect = action => action({
  list: async () => ({ workspaces: [], tasks: [batchTask, batchOther] }),
  open: async () => { batchOpens++; },
  snapshot: async taskId => { batchActive++; batchPeak = Math.max(batchPeak, batchActive); await new Promise(resolve => setTimeout(resolve, 5)); batchActive--; return batchSnapshots.get(taskId); }
});
const batched = await readMany({ taskIds: [batchTask.taskId, batchOther.taskId], maxChars: 1000 }, batchConnect);
assert.equal(batched.tasks.length, 2); assert.equal(batchOpens, 1); assert.equal(batchPeak, 2);
const deviceOffline = await readMany({ taskIds: [batchTask.taskId] }, action => action({
  list: async () => ({ tasks: [batchTask] }), open: async () => {}, snapshot: async () => { throw Error("DEVICE_OFFLINE"); }
}));
assert.deepEqual(deviceOffline.errors, [{ taskId: batchTask.taskId, error: "device_offline", code: "DEVICE_OFFLINE" }]);
assert.equal(deviceOffline.tasks.length, 0);
const batchCursors = Object.fromEntries(batched.tasks.map(row => [row.task.taskId, row.cursor]));
const batchWait = await waitForMany({ taskIds: [batchTask.taskId, batchOther.taskId], afterCursors: batchCursors, timeoutMs: 0 }, batchConnect);
assert.equal(batchWait.reason, "timeout"); assert.equal(batchWait.changed, false);
await assert.rejects(waitForMany({ taskIds: [batchTask.taskId], afterCursors: {}, timeoutMs: 0 }, batchConnect), /Missing afterCursor/);
await assert.rejects(callRemoteTool("zcode_remote_read_many", { taskIds: ["bad"] }, batchConnect), /native sess_/);
await assert.rejects(callRemoteTool("zcode_remote_wait_many", { taskIds: [batchTask.taskId], afterCursors: { "sess_other": "x" }, timeoutMs: 0 }, batchConnect), /Missing afterCursor/);

// Stateless continuation covers long text, empty messages, streaming edits and gaps.
const longText = "中😀文".repeat(15000);
const longSnapshot = { messages: [{ id: "long", role: "assistant", content: longText },
  { id: "empty", role: "assistant", content: "" }, { id: "next", role: "assistant", content: "末尾" }], history: { totalMessages: 3, truncatedBefore: false } };
let page = messagePage(longSnapshot, task, { maxChars: 257 }), reconstructed = "", iterations = 0;
for (;;) {
  for (const m of page.messages) {
    assert(!/[\uD800-\uDBFF]$/.test(m.content));
    assert(!/^[\uDC00-\uDFFF]/.test(m.content));
    if (m.id === "long") { assert.equal(m.contentOffset, reconstructed.length); reconstructed += m.content; }
  }
  if (!page.hasMore) break;
  assert(++iterations < 500);
  page = messagePage(longSnapshot, task, { maxChars: 257, afterCursor: page.cursor });
}
assert.equal(reconstructed, longText);
assert.equal(messagePage(longSnapshot, task, { afterCursor: page.cursor }).messageCount, 0);
assert.equal(page.cursor, messagePage(longSnapshot, task, { afterCursor: page.cursor }).cursor);
assert.throws(() => messagePage(longSnapshot, { ...task, taskId: "sess_other" }, { afterCursor: page.cursor }), /another task/);
assert.throws(() => messagePage(longSnapshot, { ...task, workspacePath: "other" }, { afterCursor: page.cursor }), /another task/);
assert.throws(() => messagePage(longSnapshot, task, { afterCursor: "malformed" }), /Invalid message cursor/);
assert.throws(() => messagePage({ messages: [{ id: "same" }, { id: "same" }] }, task), /duplicate/);
const tailSnapshot = { messages: [{ id: "stream", role: "assistant", content: "你好" }] };
const initialTail = messagePage(tailSnapshot, task).cursor;
tailSnapshot.messages[0].content += "，世界";
const appended = messagePage(tailSnapshot, task, { afterCursor: initialTail });
assert.equal(appended.messages[0].content, "，世界"); assert.equal(appended.messages[0].contentOffset, 2);
tailSnapshot.messages[0].content = "修订";
const replaced = messagePage(tailSnapshot, task, { afterCursor: appended.cursor });
assert.equal(replaced.messages[0].replace, true); assert.equal(replaced.messages[0].content, "修订");
tailSnapshot.messages[0].content = "";
assert.equal(messagePage(tailSnapshot, task, { afterCursor: replaced.cursor }).messages[0].replace, true);
const gap = messagePage({ messages: [], history: { truncatedBefore: true } }, task, { afterCursor: initialTail });
assert.equal(gap.historyGap, true); assert.equal(gap.messageCount, 0); assert.equal(gap.cursor, initialTail);
assert.equal(messagePage(longSnapshot, task).historyGap, false);
assert.equal(messagePage({ ...longSnapshot, history: { truncatedBefore: true } }, task).history.truncatedBefore, true);
const emptyCursor = messagePage({ messages: [] }, task).cursor;
assert.equal(messagePage({ ...longSnapshot, history: { truncatedBefore: true } }, task, { afterCursor: emptyCursor }).historyGap, true);

// Fast reply may arrive before send ACK: the returned cursor must still precede it.
const flow = { messages: [{ id: "old", role: "assistant", content: "旧答案", turnIndex: 0 }] };
const flowConnect = action => action({ list: async () => ({ tasks: [task] }), open: async () => {}, snapshot: async () => flow,
  send: async () => { flow.messages.push({ id: "request", role: "user", content: "新问题", turnIndex: 1 },
    { id: "reply", role: "assistant", content: "新答案", turnIndex: 1 }); return { request: { messageId: "request" }, result: { accepted: true } }; } });
const sentFlow = await callRemoteTool("zcode_remote_send", { taskId: task.taskId, prompt: "新问题" }, flowConnect);
assert.equal(sentFlow.delivery, "acknowledged");
const replyFlow = await callRemoteTool("zcode_remote_wait", { taskId: task.taskId, mode: "messages", afterCursor: sentFlow.cursor,
  requestMessageId: sentFlow.request.messageId, timeoutMs: 0 }, flowConnect);
assert.deepEqual(replyFlow.messages.map(m => m.id), ["request", "reply"]);
assert.equal(replyFlow.correlation.status, "assistant_reply_observed");
assert.equal(replyFlow.assistantTextReturned, true);
assert.deepEqual(replyFlow.correlation.assistantMessageIds, ["reply"]);
assert.equal(messagePage(flow, task, { requestMessageId: "unknown" }).correlation.status, "unconfirmed");
assert.equal(messagePage({ messages: flow.messages.slice(0, 2) }, task, { requestMessageId: "request" }).correlation.status, "user_message_observed");
const rewrittenId = { messages: flow.messages.map(m => m.id === "request" ? { ...m, id: "native-request" } : m) };
const rewrittenPage = messagePage(rewrittenId, task, { afterCursor: sentFlow.cursor, requestMessageId: "request" });
assert.equal(rewrittenPage.correlation.status, "unconfirmed"); assert.equal(rewrittenPage.assistantTextReturned, true);
const sameTurn = { messages: [{ id: "old-reply", role: "assistant", content: "old", turnIndex: 0 },
  { id: "user", role: "user", content: "question", turnIndex: 0 },
  { id: "later-user", role: "user", content: "another", turnIndex: 0 },
  { id: "later-reply", role: "assistant", content: "later", turnIndex: 0 }] };
assert.equal(messagePage(sameTurn, task, { requestMessageId: "user" }).correlation.status, "user_message_observed");
let preflightSends = 0;
await assert.rejects(callRemoteTool("zcode_remote_send", { taskId: task.taskId, prompt: "x" }, action => action({
  list: async () => ({ tasks: [task] }), open: async () => {}, snapshot: async () => { throw Error("snapshot offline"); },
  send: async () => { preflightSends++; } })), /snapshot offline/);
assert.equal(preflightSends, 0);
await assert.rejects(callRemoteTool("zcode_remote_wait", { taskId: task.taskId, mode: "messages" }, connect), /requires afterCursor/);
await assert.rejects(callRemoteTool("zcode_remote_wait", { taskId: task.taskId, mode: "unknown" }, connect), /Invalid mode/);
await assert.rejects(callRemoteTool("zcode_remote_wait", { taskId: task.taskId, afterCursor: sentFlow.cursor }, connect), /Invalid status cursor/);
await assert.rejects(callRemoteTool("zcode_remote_read", { taskId: task.taskId, maxChars: 25000 }, connect), /Invalid maxChars/);

// Waiting must not hold the shared connection/lock while sleeping or infer interruption from age.
let tick = 0, held = false, poll = 0;
const states = ["running", "running", "waiting_permission"];
const waitConnect = action => {
  assert.equal(held, false); held = true;
  return Promise.resolve(action({ list: async () => ({ tasks: [{ ...task, displayStatus: states[Math.min(poll++, states.length - 1)], updatedAt: poll }] }) }))
    .finally(() => { held = false; });
};
const clock = { now: () => tick, delay: async ms => { assert.equal(held, false); tick += ms; } };
const attention = await waitForTask({ taskId: task.taskId, timeoutMs: 10000 }, waitConnect, clock);
assert.equal(attention.reason, "status_changed"); assert.equal(attention.task.status, "waiting_permission");
assert.equal(poll, 3, "updatedAt alone must not wake a status wait");
const noChange = await waitForTask({ taskId: task.taskId, timeoutMs: 3000 }, action => action({ list: async () => ({ tasks: [{ ...task, displayStatus: "running", updatedAt: 1 }] }) }), clock);
assert.equal(noChange.timedOut, true); assert.equal(noChange.task.status, "running");
const ended = await callRemoteTool("zcode_remote_wait", { taskId: task.taskId, afterCursor: noChange.cursor, timeoutMs: 0 }, connect);
assert.equal(ended.changed, true); assert.equal(ended.task.turnEnded, true);
const missing = await callRemoteTool("zcode_remote_wait", { taskId: "sess_missing", timeoutMs: 0 }, connect);
assert.equal(missing.reason, "not_found"); assert.equal(missing.task, null);
await assert.rejects(callRemoteTool("zcode_remote_wait", { taskId: task.taskId, timeoutMs: 30001 }, connect), /Invalid timeoutMs/);
await assert.rejects(callRemoteTool("zcode_remote_wait", { taskId: task.taskId }, async () => { throw Error("offline"); }), /offline/);

// A stale completed status must not masquerade as a new reply. Release lock before delay.
let messagePolls = 0, messageLock = false, messageTick = 0;
const messageConnect = action => {
  assert.equal(messageLock, false); messageLock = true; messagePolls++;
  return Promise.resolve(action({ list: async () => ({ tasks: [task] }), open: async () => {}, snapshot: async () => flow }))
    .finally(() => { messageLock = false; });
};
const messageClock = { now: () => messageTick, delay: async ms => { assert.equal(messageLock, false); messageTick += ms; } };
const noReply = await waitForMessages({ taskId: task.taskId, afterCursor: replyFlow.cursor, timeoutMs: 3000 }, messageConnect, messageClock);
assert.equal(noReply.timedOut, true); assert.equal(noReply.messageCount, 0); assert(messagePolls > 1);
assert.equal(noReply.assistantTextReturned, false);
const messagesArrive = await waitForMessages({ taskId: task.taskId, afterCursor: replyFlow.cursor, timeoutMs: 3000 }, messageConnect,
  { now: () => messageTick, delay: async ms => { assert.equal(messageLock, false); messageTick += ms;
    flow.messages.at(-1).content += "（续）"; } });
assert.equal(messagesArrive.reason, "messages"); assert.equal(messagesArrive.messages[0].content, "（续）");
flow.runtime = { pendingPermissions: [{}] };
const pendingInput = await waitForMessages({ taskId: task.taskId, afterCursor: messagesArrive.cursor, timeoutMs: 0 }, messageConnect);
assert.equal(pendingInput.reason, "state_changed"); assert.equal(pendingInput.pendingPermissions, 1);

// Recheck after attaching; a completed turn must not receive a late stop. Never retry an uncertain stop.
let stops = 0, stopLists = 0, stopStatus = "running", stopFails = false;
const stopConnect = action => action({ list: async () => ({ tasks: [{ ...task, displayStatus: ++stopLists === 1 ? "running" : stopStatus }] }),
  open: async () => {}, stop: async target => { assert.equal(target.taskId, task.taskId); stops++; if (stopFails) throw Error("timeout"); } });
const stopped = await callRemoteTool("zcode_remote_cancel", { taskId: task.taskId }, stopConnect);
assert.equal(stopped.cancellation, "cancel_requested"); assert.equal(stopped.task.turnEnded, false); assert.equal(stops, 1);
stopLists = 0; stopStatus = "completed";
assert.equal((await callRemoteTool("zcode_remote_cancel", { taskId: task.taskId }, stopConnect)).requested, false);
assert.equal(stops, 1);
assert.equal((await callRemoteTool("zcode_remote_cancel", { taskId: task.taskId }, connect)).cancellation, "not_running");
await assert.rejects(callRemoteTool("zcode_remote_cancel", { taskId: "sess_archive" }, connect), /Unarchive/);
await assert.rejects(callRemoteTool("zcode_remote_cancel", { taskId: task.taskId, workspace: "wrong" }, stopConnect), /not found/);
stopLists = 0; stopStatus = "running"; stopFails = true;
await assert.rejects(callRemoteTool("zcode_remote_cancel", { taskId: task.taskId }, stopConnect), /delivery is unknown/);
assert.equal(stops, 2);
console.log("ZCode remote framing, snapshot recovery, model switch, wait/cancel and no-retry checks: OK");
