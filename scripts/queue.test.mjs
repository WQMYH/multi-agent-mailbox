import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, marker, validateQueueArgs } from "./message-queue.mjs";
import { tick, dispatch } from "./queue-worker.mjs";
import { normalizeTask, readMany } from "./remote-tools.mjs";
import { messagePage } from "./remote-messages.mjs";

const dir = mkdtempSync(join(tmpdir(), "zcode-queue-test-"));
let queue = new MessageQueue(join(dir, "messages.sqlite"));
try {
  for (const args of [{}, { requestId: "x", taskIds: ["bad"], prompt: "x" },
    { requestId: "x", taskIds: ["sess_a", "sess_a"], prompt: "x" }]) assert.throws(() => validateQueueArgs("zcode_queue_enqueue", args));
  const input = { requestId: "team-first", taskIds: ["sess_a", "sess_b"], prompt: "你好", teamId: "team-1" };
  const first = queue.enqueue(input);
  assert(queue.enqueue(input).deduplicated);
  assert.throws(() => queue.enqueue({ ...input, prompt: "other" }), /different/);
  const second = queue.enqueue({ requestId: "second", taskIds: ["sess_a"], prompt: "second", teamId: "team-1" });
  assert.equal(queue.heads().length, 2);
  assert.equal(queue.worker().desired, 0, "No automatic startup from enqueue or gateway launch");
  queue.close(); queue = new MessageQueue(join(dir, "messages.sqlite"));
  assert.equal(queue.read({ teamId: "team-1" }).messages.length, 3, "Persistence across restart");
  queue.db.prepare("UPDATE worker SET desired=1").run();
  let token = queue.acquire(); assert(token); assert.equal(queue.acquire(), null, "Only one worker");
  const tasks = ["sess_a", "sess_b"].map(taskId => ({ taskId, workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" }));
  const snapshots = new Map(tasks.map(t => [t.taskId, { messages: [{ id: `old-${t.taskId}`, role: "assistant", content: "old", turnIndex: 0 }] }]));
  const sent = []; let loseAck = true;
  const connect = action => { let opens = 0; return action({ list: async () => ({ tasks, workspaces: [] }), open: async () => { assert.equal(++opens, 1, "Reuse one bridge per connection"); },
    snapshot: async id => structuredClone(snapshots.get(id)),
    send: async (id, prompt) => {
      sent.push(id); const task = tasks.find(t => t.taskId === id); task.displayStatus = "running";
      snapshots.get(id).messages.push({ id: `native-${sent.length}`, role: "user", content: prompt, turnIndex: sent.length });
      if (id === "sess_a" && loseAck) throw Error("ACK lost with secret https://example.invalid/credential");
      return { request: { messageId: "rewritten" }, result: { accepted: true } };
    }
  }); };
  await tick(queue, token, connect);
  assert.deepEqual(sent, ["sess_a", "sess_b"], "ACK loss must not block other tasks");
  assert.equal(queue.get(first.messages[0].messageId).state, "uncertain");
  assert.equal(queue.get(first.messages[1].messageId).state, "acknowledged");
  await tick(queue, token, connect); assert.equal(sent.length, 2, "No retry, no same-task overlap");
  assert(!JSON.stringify(queue.read()).includes("credential"));
  // An old completed status and only user echo cannot finish delivery.
  tasks[0].displayStatus = "completed";
  await tick(queue, token, connect); assert.equal(queue.get(first.messages[0].messageId).state, "uncertain");
  snapshots.get("sess_a").messages.push({ id: "reply-a", role: "assistant", content: "准备好了", turnIndex: 1 });
  await tick(queue, token, connect); assert.equal(queue.get(first.messages[0].messageId).state, "completed");
  assert.equal(sent.length, 2);
  loseAck = false; await tick(queue, token, connect); assert.deepEqual(sent, ["sess_a", "sess_b", "sess_a"]);
  const events = queue.read({ teamId: "team-1", limit: 100 });
  assert(events.events.some(e => e.kind === "message" && e.payload.content === "准备好了"));
  assert.equal(queue.read({ teamId: "team-1", after: events.cursor }).events.length, 0);
  assert.equal(queue.read({ teamId: "other" }).events.length, 0);
  assert.throws(() => queue.resolve({ messageId: second.messages[0].messageId, decision: "cancel" }), /Only unsent/);
  // Crash after persisting dispatch intent recovers as uncertain, never queued.
  queue.transaction(() => queue.state(queue.get(second.messages[0].messageId), "dispatching"));
  queue.release(token); token = queue.acquire();
  assert.equal(queue.get(second.messages[0].messageId).state, "uncertain");
  queue.resolve({ messageId: second.messages[0].messageId, decision: "release" });
  assert.equal(queue.get(second.messages[0].messageId).state, "released");
  const pending = queue.enqueue({ requestId: "cancel", taskIds: ["sess_c"], prompt: "never" });
  queue.resolve({ messageId: pending.messages[0].messageId, decision: "cancel" });
  // Snapshot failure occurs before send and must remain safely queued.
  const safe = queue.enqueue({ requestId: "preflight", taskIds: ["sess_a"], prompt: "never" });
  await dispatch(queue, queue.get(safe.messages[0].messageId), token, async () => { throw Error("offline"); });
  assert.equal(queue.get(safe.messages[0].messageId).state, "queued");
  // Failed native turns accept an already-authorized queued continuation. The
  // original durable intent still prevents a second send if its ACK is lost.
  let recoverySerial = 0;
  async function recoveryCase({ status = "error", freshStatus = status, archived = false, loseAck = false, runtime = {} } = {}) {
    const id = `sess_recovery-${++recoverySerial}`;
    const receipt = queue.enqueue({ requestId: id, taskIds: [id], prompt: "Continue authorized work" });
    const messageId = receipt.messages[0].messageId;
    let lists = 0, sends = 0;
    const connection = action => action({
      list: async () => ({ tasks: [{ taskId: id, workspacePath: "workspace", workspaceKind: "local", archived,
        displayStatus: ++lists >= 3 ? freshStatus : status }] }),
      open: async () => {}, snapshot: async () => ({ messages: [], runtime }),
      send: async (taskId, prompt) => {
        sends++; assert.equal(taskId, id); assert(prompt.startsWith(marker(messageId) + "\n"));
        if (loseAck) throw Error("ACK lost");
        return { result: { accepted: true } };
      }
    });
    await dispatch(queue, queue.get(messageId), token, connection);
    await dispatch(queue, queue.get(messageId), token, connection);
    return { sends, state: queue.get(messageId).state };
  }
  assert.deepEqual(await recoveryCase(), { sends: 1, state: "acknowledged" });
  assert.deepEqual(await recoveryCase({ loseAck: true }), { sends: 1, state: "uncertain" });
  for (const status of ["running", "compacting", "waiting_permission", "waiting_input", "interrupted", "cancelled", "unknown"]) {
    assert.deepEqual(await recoveryCase({ status }), { sends: 0, state: "queued" });
  }
  assert.deepEqual(await recoveryCase({ archived: true }), { sends: 0, state: "queued" });
  assert.deepEqual(await recoveryCase({ freshStatus: "running" }), { sends: 0, state: "queued" });
  for (const key of ["pendingPermissions", "pendingElicitations", "pendingCommands"]) {
    assert.deepEqual(await recoveryCase({ runtime: { [key]: [{}] } }), { sends: 0, state: "queued" });
  }
  assert.deepEqual(normalizeTask({ displayStatus: "error", lastError: { code: "E_MODEL",
    attribution: { providerErrorCode: "1308" } } }).nativeExecutionFailure,
    { stage: "native_execution", source: "provider", reason: "rate_limited", code: "1308" });
  assert.deepEqual(normalizeTask({ displayStatus: "error", lastError: { reason: " ",
    attribution: { reason: "rate_limited" } } }).nativeExecutionFailure,
    { stage: "native_execution", source: "provider", reason: "rate_limited" });
  assert.deepEqual(normalizeTask({ displayStatus: "error", lastError: { code: "", reason: " ",
    statusCode: "429", attribution: { providerErrorCode: [], reason: null } } }).nativeExecutionFailure,
    { stage: "native_execution", source: "zcode_native", reason: "unknown" });
  // An ACK plus the native user message proves handoff. A failed model turn is
  // classified separately, preserving provider detail only when ZCode exposes it.
  for (const [suffix, lastError, expected] of [["rate", { code: "1308", attribution: { source: "provider", reason: "rate_limited",
    statusCode: 429, retryable: false, providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3-Flash" } },
    { stage: "native_execution", source: "provider", reason: "rate_limited", code: "1308", statusCode: 429,
      retryable: false, providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3-Flash",
      userMessageObserved: true, assistantTextReturned: false }],
  ["unknown", undefined, { stage: "native_execution", source: "zcode_native", reason: "unknown",
    userMessageObserved: true, assistantTextReturned: false }]]) {
    const taskId = `sess_failure-${suffix}`, messageId = queue.enqueue({ requestId: `failure-${suffix}`, taskIds: [taskId], prompt: "work" }).messages[0].messageId;
    queue.state(queue.get(messageId), "acknowledged");
    const task = normalizeTask({ taskId, workspacePath: "workspace", displayStatus: "error", ...(lastError ? { lastError } : {}) });
    queue.observe(queue.get(messageId), { task, cursor: `cursor-${suffix}`, historyGap: false, messages: [
      { id: `user-${suffix}`, role: "user", turnIndex: 1, content: marker(messageId) + "\nwork", contentOffset: 0 },
      { id: `assistant-${suffix}`, role: "assistant", turnIndex: 1, content: "", contentOffset: 0 }
    ] });
    const view = queue.read({ taskId, limit: 20 });
    assert.equal(queue.get(messageId).state, suffix === "rate" ? "retry_wait" : "needs_attention");
    assert.deepEqual(view.events.find(event => event.kind === "native_execution_failed").payload, expected);
    assert.deepEqual(view.envelopes[0].nativeExecutionFailure, expected);
    if (suffix === "unknown") assert.equal(queue.resolve({ messageId, decision: "release" }).state, "released");
  }
  const competingTaskId = "sess_failure-competing";
  const competingMessageId = queue.enqueue({ requestId: "failure-competing", taskIds: [competingTaskId], prompt: "work" }).messages[0].messageId;
  queue.state(queue.get(competingMessageId), "acknowledged");
  queue.observe(queue.get(competingMessageId), { task: normalizeTask({ taskId: competingTaskId, workspacePath: "workspace", displayStatus: "running" }),
    cursor: "cursor-marker", historyGap: false, messages: [
      { id: "user-marker", role: "user", turnIndex: 1, content: marker(competingMessageId) + "\nwork", contentOffset: 0 }
    ] });
  assert.equal(queue.get(competingMessageId).state, "acknowledged");
  queue.observe(queue.get(competingMessageId), { task: normalizeTask({ taskId: competingTaskId, workspacePath: "workspace", displayStatus: "error",
    lastError: { code: "1308" } }), cursor: "cursor-competing", historyGap: false, messages: [
    { id: "user-manual", role: "user", turnIndex: 2, content: "manual", contentOffset: 0 },
    { id: "assistant-manual", role: "assistant", turnIndex: 2, content: "", contentOffset: 0 }
  ] });
  const competingView = queue.read({ taskId: competingTaskId, limit: 20 });
  assert.equal(queue.get(competingMessageId).state, "needs_attention");
  assert.equal(competingView.events.some(event => event.kind === "native_execution_failed"), false);
  assert.equal(Object.hasOwn(competingView.envelopes[0], "nativeExecutionFailure"), false);
  const pagedTaskId = "sess_failure-paged", pagedMessageId = queue.enqueue({ requestId: "failure-paged",
    taskIds: [pagedTaskId], prompt: "work" }).messages[0].messageId;
  queue.state(queue.get(pagedMessageId), "acknowledged");
  const pagedTask = normalizeTask({ taskId: pagedTaskId, workspacePath: "workspace", displayStatus: "error",
    lastError: { code: "1308" } });
  const pagedSnapshot = { messages: [
    { id: "user-paged-marker", role: "user", turnIndex: 1, content: marker(pagedMessageId) + "\nwork" },
    { id: "user-paged-manual", role: "user", turnIndex: 2, content: "manual" },
    { id: "assistant-paged-manual", role: "assistant", turnIndex: 2, content: "" }
  ] };
  const firstPage = messagePage(pagedSnapshot, pagedTask, { maxChars: marker(pagedMessageId).length + 5 });
  assert(firstPage.hasMore && firstPage.messages.some(message => message.id === "user-paged-marker"));
  queue.observe(queue.get(pagedMessageId), { task: pagedTask, ...firstPage });
  assert.equal(queue.get(pagedMessageId).state, "acknowledged", "A partial failed snapshot must continue paging");
  const finalPage = messagePage(pagedSnapshot, pagedTask, { afterCursor: firstPage.cursor });
  queue.observe(queue.get(pagedMessageId), { task: pagedTask, ...finalPage });
  const pagedView = queue.read({ taskId: pagedTaskId, limit: 20 });
  assert.equal(queue.get(pagedMessageId).state, "needs_attention");
  assert.equal(pagedView.events.some(event => event.kind === "native_execution_failed"), false);
  assert.equal(Object.hasOwn(pagedView.envelopes[0], "nativeExecutionFailure"), false);
  queue.db.prepare("UPDATE worker SET desired=0").run();
  await tick(queue, token, connect); assert.equal(sent.length, 3);
  // A transient failure on a single-task group also gets one fresh connection.
  let singleReads = 0; const singleOpened = [];
  const singleRecovery = await readMany({ taskIds: ["sess_single"] }, action => action({
    list: async () => ({ tasks: [{ ...tasks[0], taskId: "sess_single", workspacePath: "one" }] }),
    open: async task => singleOpened.push(task.workspacePath),
    snapshot: async () => {
      if (++singleReads === 1) throw Error("transient snapshot failure");
      return { messages: [] };
    }
  }));
  assert.equal(singleRecovery.tasks.length, 1, "Retry an isolated read even for one task");
  assert.equal(singleRecovery.errors.length, 0);
  assert.deepEqual(singleOpened, ["one", "one"]);
  // Bounded snapshot concurrency and workspace barrier, including one target error.
  let active = 0, peak = 0; const opened = [];
  const manyTasks = Array.from({ length: 8 }, (_, i) => ({ ...tasks[0], taskId: `sess_${i}`, workspacePath: i < 6 ? "one" : "two" }));
  const many = await readMany({ taskIds: manyTasks.map(t => t.taskId) }, action => action({
    list: async () => ({ tasks: manyTasks }),
    open: async t => { assert.equal(active, 0); opened.push(t.workspacePath); },
    snapshot: async id => {
      active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      if (id === "sess_1") throw Error("unavailable");
      return { messages: [] };
    }
  }));
  assert.equal(peak, 4); assert.deepEqual(opened, ["one", "two", "one"], "One isolated retry for the failed read");
  assert.equal(many.tasks.length, 7); assert.equal(many.errors[0].taskId, "sess_1");
  assert.equal(active, 0);
  // A stalled snapshot must not poison other tasks' completion confirmation.
  const isolated = new MessageQueue(join(dir, "reconcile.sqlite"));
  try {
    const targets = ["sess_good-a", "sess_stalled", "sess_good-b"].map(taskId => ({ taskId,
      workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed", updatedAt: 1 }));
    const receipts = isolated.enqueue({ requestId: "reconcile", taskIds: targets.map(t => t.taskId), prompt: "progress" });
    const snapshots = new Map();
    for (const [i, task] of targets.entries()) {
      const id = receipts.messages[i].messageId;
      const snapshot = { messages: [{ id: `user-${i}`, role: "user", turnIndex: 1, content: marker(id) + "\nprogress" },
        { id: `reply-${i}`, role: "assistant", turnIndex: 1, content: "partial" }] };
      isolated.state(isolated.get(id), "acknowledged");
      isolated.observe(isolated.get(id), { task: { ...task, status: "running" }, ...messagePage(snapshot, task) });
      snapshot.messages[1].content += " final";
      snapshots.set(task.taskId, snapshot);
    }
    const followup = isolated.enqueue({ requestId: "followup", taskIds: [targets[0].taskId], teamId: "another-team", prompt: "next" }).messages[0].messageId;
    isolated.db.exec("UPDATE worker SET desired=1");
    const owner = isolated.acquire(), sends = [];
    const connect = action => {
      let poisoned = false;
      return action({ open: async () => {}, list: async () => ({ tasks: targets }),
        snapshot: async id => {
          await Promise.resolve();
          if (id === "sess_stalled") poisoned = true;
          if (poisoned) throw Error("A stalled snapshot poisoned this connection");
          return structuredClone(snapshots.get(id));
        }, send: async id => { sends.push(id); return { result: { accepted: true } }; } });
    };
    await tick(isolated, owner, connect);
    assert.equal(isolated.get(receipts.messages[0].messageId).state, "completed", "Recover a good task after a shared-connection failure");
    assert.equal(isolated.get(receipts.messages[2].messageId).state, "completed");
    assert.equal(isolated.get(receipts.messages[1].messageId).state, "acknowledged", "No guessed completion for the unavailable task");
    assert.equal(isolated.worker().error, "some_targets_unavailable");
    assert.equal(isolated.get(followup).state, "queued"); assert.deepEqual(sends, []);
    await tick(isolated, owner, connect);
    assert.deepEqual(sends, [targets[0].taskId], "Only the new authorized follow-up sends, never an old request");
  } finally { isolated.close(); }
  assert.equal(marker(first.messages[0].messageId).startsWith("[[zcode-ops:"), true);
  console.log("zcode-ops durable queue: FIFO, teams, no duplicate send, crash recovery, correlation, stop and bounded batch isolation OK");
} finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
