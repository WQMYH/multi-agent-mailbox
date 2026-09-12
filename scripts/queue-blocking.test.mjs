import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, callQueueTool, marker } from "./message-queue.mjs";
import { callPublicTool } from "./tools.mjs";
import { tick } from "./queue-worker.mjs";
import { messagePage } from "./remote-messages.mjs";

const dir = mkdtempSync(join(tmpdir(), "zcode-blocking-"));
const original = process.env.ZCODE_OPS_CONFIG;
let q;
try {
  process.env.ZCODE_OPS_CONFIG = join(dir, "config.json");
  q = new MessageQueue();
  const old = q.enqueue({ requestId: "old", taskIds: ["sess_blocked"], teamId: "old-team", prompt: "private old body" }).messages[0].messageId;
  q.state(q.get(old), "needs_attention");
  const input = { requestId: "new", taskIds: ["sess_blocked"], teamId: "new-team", prompt: "new authorized work" };
  const expected = { blockedReason: "same_task_fifo", blockedByMessageId: old, blockedByState: "needs_attention" };
  const blockedFields = value => Object.fromEntries(Object.keys(expected).map(k => [k, value[k]]));
  let launches = 0, token;
  const deps = { queue: (name, args) => callQueueTool(name, args, { launch: async reservation => {
    launches++; token = q.acquire(reservation); return process.pid;
  } }) };
  const sent = await callPublicTool("zcode_send", input, deps), nextId = sent.messages[0].messageId;
  assert.deepEqual(blockedFields(sent.messages[0]), expected, "First receipt reveals a different team's blocking head");
  const duplicate = await callPublicTool("zcode_send", input, deps);
  assert(duplicate.deduplicated); assert.equal(duplicate.messages[0].messageId, nextId);
  assert.deepEqual(blockedFields(duplicate.messages[0]), expected);
  const inbox = await callPublicTool("zcode_read", { view: "inbox", teamId: "new-team" }, deps);
  assert.deepEqual(blockedFields(inbox.envelopes[0]), expected);
  assert.deepEqual(blockedFields(inbox.messages[0]), expected);
  assert(!JSON.stringify(inbox).includes("private old body"), "Only blocker ID/state cross the team filter");
  const consumedEvents = await callPublicTool("zcode_read", { view: "inbox", teamId: "new-team", cursor: inbox.cursor }, deps);
  assert.equal(consumedEvents.events.length, 0);
  assert.deepEqual(blockedFields(consumedEvents.messages[0]), expected, "Cursor reads still show current blocking reason");

  const sends = [], tasks = ["sess_blocked", "sess_other"].map(taskId => ({ taskId, workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" }));
  const connect = action => action({ open: async () => {}, list: async () => ({ tasks }), snapshot: async () => ({ messages: [] }),
    send: async (task, prompt) => { sends.push({ task, prompt }); return { result: { accepted: true } }; } });
  const other = q.enqueue({ requestId: "other", taskIds: ["sess_other"], prompt: "independent" }).messages[0].messageId;
  await tick(q, token, connect);
  assert.deepEqual(sends.map(s => s.task), ["sess_other"], "A blocked head does not stall another task");
  q.state(q.get(other), "completed");
  assert.equal(q.continueOrRelease(token), false, "All remaining heads need attention; worker retires");
  assert.equal(q.worker().token, null);
  const released = await callPublicTool("zcode_control", { action: "release_message", messageId: old }, deps);
  assert.equal(released.state, "released"); assert.equal(launches, 2, "Release wakes an already requested worker for its existing follower");
  const after = await callPublicTool("zcode_read", { view: "inbox", teamId: "new-team", cursor: inbox.cursor }, deps);
  assert.equal(after.messages[0].blockedByMessageId, null, "Blocker cleared even without new events in this team");
  await tick(q, token, connect); await tick(q, token, connect);
  assert.equal(sends.length, 2); assert(sends[1].prompt.endsWith(input.prompt));
  assert.equal(q.get(nextId).state, "acknowledged");

  // Pausing is authoritative even if release would otherwise wake the worker.
  q.state(q.get(nextId), "needs_attention");
  const tail = q.enqueue({ ...input, requestId: "tail" }).messages[0].messageId;
  await callPublicTool("zcode_control", { action: "pause", scope: "all", expectedRevision: q.worker().control_revision }, deps);
  assert.equal(q.continueOrRelease(token), false);
  await callPublicTool("zcode_control", { action: "release_message", messageId: nextId }, deps);
  assert.equal(launches, 2); assert(q.worker().paused); assert.equal(q.get(tail).state, "queued");
  await callPublicTool("zcode_control", { action: "resume", scope: "all", expectedRevision: q.worker().control_revision }, deps);
  assert.equal(launches, 3);
  tasks[0].displayStatus = "running"; await tick(q, token, connect); assert.equal(sends.length, 2);
  tasks[0].displayStatus = "completed"; await tick(q, token, connect);
  assert.equal(sends.length, 3, "A previously running task is reconsidered on the next tick");
  assert.equal(q.get(tail).state, "acknowledged");
  q.state(q.get(tail), "needs_attention");
  const saved = q.enqueue({ ...input, requestId: "after-start-failure" }).messages[0].messageId;
  assert.equal(q.continueOrRelease(token), false);
  const launchFailure = await callPublicTool("zcode_control", { action: "release_message", messageId: tail }, {
    queue: (name, args) => callQueueTool(name, args, { launch: async () => { throw Error("launcher offline"); } })
  });
  assert.equal(launchFailure.state, "released", "Committed release survives a worker startup failure");
  assert.match(launchFailure.startupError, /Resume explicitly/);
  assert.equal(q.get(saved).state, "queued"); assert.equal(sends.length, 3);

  // Reproduce a persisted ACK whose empty assistant tail was already consumed.
  const empty = new MessageQueue(join(dir, "empty-reply.sqlite"));
  try {
    const targets = Array.from({ length: 5 }, (_, i) => ({ taskId: `sess_empty-${i}`,
      workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed", updatedAt: 1 }));
    const old = empty.enqueue({ requestId: "empty-old", taskIds: [targets[0].taskId], prompt: "old" }).messages[0].messageId;
    const snapshot = { messages: [
      { id: "native-old", role: "user", turnIndex: 2, content: marker(old) + "\nold" },
      { id: "empty-assistant", role: "assistant", turnIndex: 2, content: "" }
    ] };
    empty.state(empty.get(old), "acknowledged");
    empty.observe(empty.get(old), { task: { ...targets[0], status: "running" }, ...messagePage(snapshot, targets[0]) });
    assert.equal(empty.get(old).reply_seen, 0);
    assert.equal(messagePage(snapshot, targets[0], { afterCursor: empty.get(old).cursor }).messages.length, 0);
    const next = empty.enqueue({ requestId: "five-current", taskIds: targets.map(t => t.taskId), prompt: "authorized next" });
    empty.db.exec("UPDATE worker SET desired=1");
    const owner = empty.acquire(), delivered = [];
    const connect = action => action({ open: async () => {}, list: async () => ({ tasks: targets }),
      snapshot: async id => id === targets[0].taskId ? snapshot : { messages: [] },
      send: async (id, prompt) => { delivered.push({ id, prompt }); targets.find(t => t.taskId === id).displayStatus = "running";
        return { result: { accepted: true } }; } });
    await tick(empty, owner, connect);
    assert.equal(empty.get(old).state, "needs_attention", "Stable completed plus owned empty assistant must not remain ACKed forever");
    assert.equal(delivered.length, 4, "The blocked head does not impose a three-task concurrency cap");
    const failure = empty.read({ taskId: targets[0].taskId }).envelopes.find(e => e.messageId === old).nativeExecutionFailure;
    assert.equal(failure.reason, "empty_response"); assert.equal(failure.assistantTextReturned, false);
    assert.equal(empty.get(next.messages[0].messageId).state, "queued", "Do not automatically release or restart old sessions");
    empty.resolve({ messageId: old, decision: "release" });
    await tick(empty, owner, connect);
    assert.equal(targets.filter(t => t.displayStatus === "running").length, 5);
    assert.equal(delivered.length, 5);
    assert(delivered.every(s => !s.prompt.includes(marker(old))), "Only existing authorized followers send, never the old request");

    for (const [name, patch] of [
      ["unconfirmed", { completionConfirmed: false }], ["paged", { hasMore: true }],
      ["permission", { pendingPermissions: 1 }], ["question", { pendingQuestions: 1 }],
      ["command", { pendingCommands: 1 }], ["other-turn", { tailMessage: { role: "assistant", turnIndex: 99, totalCharacters: 0 } }],
      ["user-only", { tailMessage: { role: "user", turnIndex: 2, totalCharacters: 0 } }],
      ["no-tail", { tailMessage: null }], ["nonempty", { tailMessage: { role: "assistant", turnIndex: 2, totalCharacters: 1 } }]
    ]) {
      const id = empty.enqueue({ requestId: name, taskIds: [`sess_${name}`], prompt: "guard" }).messages[0].messageId;
      empty.state(empty.get(id), "acknowledged");
      empty.db.prepare("UPDATE messages SET native_id='owned',turn_index=2 WHERE id=?").run(id);
      empty.observe(empty.get(id), { task: { status: "completed" }, cursor: name, messages: [], completionConfirmed: true,
        tailMessage: { role: "assistant", turnIndex: 2, totalCharacters: 0 }, ...patch });
      assert.equal(empty.get(id).state, "acknowledged", name);
    }
    const unowned = empty.enqueue({ requestId: "unowned", taskIds: ["sess_unowned"], prompt: "guard" }).messages[0].messageId;
    empty.state(empty.get(unowned), "acknowledged");
    empty.observe(empty.get(unowned), { task: { status: "completed" }, cursor: "unowned", messages: [], completionConfirmed: true,
      tailMessage: { role: "assistant", turnIndex: 2, totalCharacters: 0 } });
    assert.equal(empty.get(unowned).state, "acknowledged", "An uncorrelated empty turn is not our failure");
  } finally { empty.close(); }
  const refill = new MessageQueue(join(dir, "refill.sqlite"));
  try {
    const targets = Array.from({ length: 5 }, (_, i) => ({ taskId: `sess_refill-${i}`,
      workspacePath: i < 4 ? "workspace" : "other-workspace", workspaceKind: "local", displayStatus: i < 4 ? "running" : "completed", updatedAt: 1 }));
    const ids = refill.enqueue({ requestId: "refill", taskIds: targets.map(t => t.taskId), prompt: "authorized" }).messages.map(m => m.messageId);
    const snapshots = new Map();
    for (const [i, task] of targets.slice(0, 4).entries()) {
      const snapshot = { messages: [{ id: `owned-${i}`, role: "user", turnIndex: 1, content: marker(ids[i]) + "\nauthorized" }] };
      refill.state(refill.get(ids[i]), "acknowledged");
      refill.observe(refill.get(ids[i]), { task: { ...task, status: "running" }, ...messagePage(snapshot, task) });
      snapshots.set(task.taskId, snapshot);
    }
    refill.db.exec("UPDATE worker SET desired=1");
    const owner = refill.acquire(), delivered = [];
    const observing = Promise.withResolvers(), unblock = Promise.withResolvers();
    const connect = action => action({ open: async () => {}, list: async () => ({ tasks: targets }),
      snapshot: async id => {
        if (snapshots.has(id)) { observing.resolve(); await unblock.promise; }
        return snapshots.get(id) ?? { messages: [] };
      },
      send: async id => { delivered.push(id); targets.find(t => t.taskId === id).displayStatus = "running";
        return { result: { accepted: true } }; } });
    const runningTick = tick(refill, owner, connect);
    try {
      await observing.promise;
      assert.deepEqual([...delivered], [targets[4].taskId], "An idle fifth target must dispatch before unrelated slow reply snapshots finish");
    } finally { unblock.resolve(); await runningTick; }
    assert.equal(refill.get(ids[4]).state, "acknowledged");
    assert.equal(delivered.length, 1, "Neither running tasks nor the fresh send may be replayed");
    const cooling = { taskId: "sess_refill-cooling", workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" };
    targets.push(cooling);
    const waiting = refill.enqueue({ requestId: "cooling", taskIds: [cooling.taskId], prompt: "wait" }).messages[0].messageId;
    refill.db.prepare("UPDATE worker SET rate_until=?").run(Date.now() + 300000);
    await tick(refill, owner, connect);
    assert.equal(refill.get(waiting).state, "queued"); assert.equal(delivered.length, 1, "Priority dispatch must honor the shared cooldown");
  } finally { refill.close(); }
  console.log("zcode-ops blocking: FIFO receipts, release wakeup, empty replies, prompt refill, shared cooldown and pause/start failure OK");
} finally {
  q?.close();
  if (original === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = original;
  rmSync(dir, { recursive: true, force: true });
}
