import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMessageBudget, validateMessageReceipt } from "../modules/agent-core/src/contracts.mjs";
import { callQueueTool, MessageQueue, queueOwnerId, marker } from "./message-queue.mjs";
import { dispatch } from "./queue-worker.mjs";
import { RemoteClient } from "./remote-client.mjs";

const root = mkdtempSync(join(tmpdir(), "zcode-phase2b-"));
const previous = process.env.ZCODE_OPS_CONFIG;
let serial = 0;
function scenario() {
  const queue = new MessageQueue(join(root, `case-${++serial}.sqlite`));
  queue.db.exec("UPDATE worker SET desired=1");
  const token = queue.acquire();
  const input = { requestId: `create-${serial}`, workspace: { path: "workspace" },
    prompt: "First message", context: { instanceId: `phase2b-${serial}` } };
  const receipt = queue.enqueue(input), id = receipt.messages[0].messageId;
  const saved = queue.get(id), sendIds = { traceId: saved.send_trace_id, queryId: saved.send_query_id,
    messageId: saved.send_message_id };
  assert.equal(receipt.messages[0].taskId, undefined);
  assert.equal(receipt.messages[0].createdTaskId, null);
  assert.equal(receipt.messages[0].targetAddress, `workspace:create:${id}`);
  const workspace = { workspacePath: "workspace", kind: "local", connectionState: "connected" };
  const tasks = [];
  const effects = { creates: 0, sends: 0, opens: 0 };
  const client = {
    list: async () => ({ workspaces: [workspace], tasks }),
    openWorkspace: async () => { effects.opens++; },
    open: async () => { effects.opens++; },
    createTask: async () => { effects.creates++; const taskId = `sess_created-${serial}`;
      tasks.push({ taskId, workspacePath: "workspace", displayStatus: "completed" }); return { taskId }; },
    snapshot: async () => ({ messages: [] }),
    send: async (_taskId, content, ids) => { effects.sends++; assert(content.startsWith("[[zcode-ops:"));
      if (content.startsWith(marker(id) + "\n")) assert.deepEqual(ids, sendIds);
      return { result: { accepted: true } }; }
  };
  return { queue, token, input, id, tasks, effects, client, connect: action => action(client) };
}
async function run() {
  try {
    const remote = new RemoteClient("https://zcode.z.ai/remote/v4?sid=offline&hash=offline&mid=offline", { WebSocketClass: class {} });
    remote.bridge = { workspacePath: "workspace", bridgeSessionId: "offline", bridgeGeneration: 1 };
    remote.payload = () => {};
    const nativeTask = { taskId: "sess_native", traceId: "trace", workspacePath: "workspace", initialSlashCommands: [] };
    let code = 201, body = nativeTask;
    remote.wait = async (match, send) => {
      send();
      const response = { kind: "rpc", header: [code, remote.serial], body };
      assert(match(response));
      return response;
    };
    assert.deepEqual(await remote.createTask({ workspacePath: "workspace" }), nativeTask, "native 201 body is direct task metadata");
    code = 202; body = "native rejects create";
    await assert.rejects(remote.createTask({ workspacePath: "workspace" }), error => {
      const safe = remote.sanitized(error);
      assert.equal(safe.rpcRejected, true);
      assert.match(safe.message, /native rejects create/);
      return true;
    });
    code = 201; body = { result: nativeTask };
    await assert.rejects(remote.createTask({ workspacePath: "workspace" }), /invalid created task ID/);

    const budgetPath = join(root, "budget", "messages.sqlite");
    process.env.ZCODE_OPS_CONFIG = join(root, "budget", "config.json");
    const ownerId = queueOwnerId(budgetPath), config = { schemaVersion: 1, totalBytes: 200_000_000,
      allocations: [{ ownerId, bytes: 1 }, { ownerId: "other-owner", bytes: 199_999_999 }] };
    let nativeCalls = 0;
    await assert.rejects(callQueueTool("zcode_queue_send", { requestId: "budget-block", workspace: { path: "workspace" }, prompt: "first" }, {
      messageBudget: { status: () => config, check: input => checkMessageBudget(config, input) }, validateMessageReceipt,
      launch: async () => { nativeCalls++; }
    }), error => error.code === "ZCODE_BUDGET_BLOCKED");
    assert.equal(existsSync(budgetPath), false, "tight Core allocation creates zero queue rows");
    assert.equal(nativeCalls, 0, "budget rejection starts no native effect");

    const first = scenario();
    try {
      const initial = first.queue.read().envelopes.find(row => row.messageId === first.id);
      assert.equal(initial.destination.taskId, undefined);
      assert.equal(initial.destination.target.address, first.queue.get(first.id).target_address);
      const conflict = first.queue.assignmentConflict({ instanceId: "phase2b-1" });
      assert.equal(conflict.conflictingTaskId, null);
      assert.equal(conflict.conflictingTargetAddress, `workspace:create:${first.id}`);
      await dispatch(first.queue, first.queue.get(first.id), first.token, async () => { throw Error("local preflight offline"); });
      assert.equal(first.queue.get(first.id).state, "queued"); assert.equal(first.effects.creates, 0);
      await dispatch(first.queue, first.queue.get(first.id), first.token, first.connect);
      const bound = first.queue.get(first.id);
      assert.equal(bound.create_state, "created"); assert.equal(bound.state, "queued");
      assert.equal(bound.task_id, "sess_created-1"); assert.equal(first.effects.creates, 1);
      const retry = first.queue.enqueue(first.input);
      assert(retry.deduplicated); assert.equal(retry.messages[0].messageId, first.id);
      assert.equal(retry.messages[0].targetAddress, `workspace:create:${first.id}`);
      assert.equal(retry.messages[0].createdTaskId, bound.task_id);
      assert.equal(retry.messages[0].ownerId, first.queue.ownerId);
      const follower = first.queue.enqueue({ requestId: "same-real-id", taskIds: [bound.task_id], prompt: "Continue" });
      await dispatch(first.queue, first.queue.get(follower.messages[0].messageId), first.token, first.connect);
      assert.equal(first.effects.sends, 0, "real-ID FIFO blocks follower");
      first.queue.release(first.token); first.queue.close();
      first.queue = new MessageQueue(join(root, "case-1.sqlite"));
      const resumed = first.queue.acquire(); assert(resumed);
      await dispatch(first.queue, first.queue.get(first.id), resumed, first.connect);
      assert.equal(first.queue.get(first.id).state, "acknowledged"); assert.equal(first.effects.sends, 1);
      await dispatch(first.queue, first.queue.get(first.id), resumed, first.connect);
      assert.equal(first.effects.sends, 1);
      first.queue.transaction(() => first.queue.state(first.queue.get(first.id), "completed"));
      await dispatch(first.queue, first.queue.get(follower.messages[0].messageId), resumed, first.connect);
      assert.equal(first.effects.sends, 2, "follower sends only after first turn is terminal");
    } finally { first.queue.close(); }

    const unknown = scenario();
    try {
      unknown.client.createTask = async () => { unknown.effects.creates++; throw Error("ACK lost"); };
      await dispatch(unknown.queue, unknown.queue.get(unknown.id), unknown.token, unknown.connect);
      assert.equal(unknown.queue.get(unknown.id).create_state, "unknown");
      assert.equal(unknown.queue.get(unknown.id).state, "needs_attention");
      assert.equal(unknown.queue.read().messages.find(row => row.messageId === unknown.id).blockedReason, "create_unknown");
      assert(unknown.queue.enqueue(unknown.input).deduplicated);
      await dispatch(unknown.queue, unknown.queue.get(unknown.id), unknown.token, unknown.connect);
      assert.equal(unknown.effects.creates, 1);
      assert.equal(unknown.effects.sends, 0, "unknown create neither replays nor sends first message");
    } finally { unknown.queue.close(); }

    const rejected = scenario();
    try {
      rejected.client.createTask = async () => { rejected.effects.creates++; throw Object.assign(Error("native rejection"), { rpcRejected: true }); };
      await dispatch(rejected.queue, rejected.queue.get(rejected.id), rejected.token, rejected.connect);
      assert.equal(rejected.queue.get(rejected.id).create_state, "failed");
      assert.equal(rejected.queue.read().messages.find(row => row.messageId === rejected.id).blockedReason, "create_failed");
    } finally { rejected.queue.close(); }

    const crash = scenario();
    try {
      const bind = crash.queue.bindCreatedTask;
      crash.queue.bindCreatedTask = () => { throw Error("crash before binding ACK"); };
      await dispatch(crash.queue, crash.queue.get(crash.id), crash.token, crash.connect);
      crash.queue.bindCreatedTask = bind;
      assert.equal(crash.queue.get(crash.id).create_state, "unknown");
      await dispatch(crash.queue, crash.queue.get(crash.id), crash.token, crash.connect);
      assert.equal(crash.effects.creates, 1);
    } finally { crash.queue.close(); }

    const restart = scenario();
    try {
      assert(restart.queue.claimCreate(restart.queue.get(restart.id), restart.token));
      restart.queue.release(restart.token);
      assert(restart.queue.acquire());
      assert.equal(restart.queue.get(restart.id).create_state, "unknown");
      assert.equal(restart.queue.get(restart.id).state, "needs_attention");
      assert.equal(restart.effects.creates, 0);
    } finally { restart.queue.close(); }

    const sendUnknown = scenario();
    try {
      await dispatch(sendUnknown.queue, sendUnknown.queue.get(sendUnknown.id), sendUnknown.token, sendUnknown.connect);
      sendUnknown.client.send = async () => { sendUnknown.effects.sends++; throw Error("send ACK lost"); };
      await dispatch(sendUnknown.queue, sendUnknown.queue.get(sendUnknown.id), sendUnknown.token, sendUnknown.connect);
      assert.equal(sendUnknown.queue.get(sendUnknown.id).state, "uncertain");
      await dispatch(sendUnknown.queue, sendUnknown.queue.get(sendUnknown.id), sendUnknown.token, sendUnknown.connect);
      assert.equal(sendUnknown.effects.sends, 1);
      assert.equal(sendUnknown.effects.creates, 1);
    } finally { sendUnknown.queue.close(); }

    console.log("ZCode Phase2B first-message create/bind/send, crash boundaries, dedup, FIFO and budget: OK");
  } finally {
    if (previous === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
await run();
