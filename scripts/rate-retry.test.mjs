import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, RATE_RETRY } from "./message-queue.mjs";
import { dispatch, tick } from "./queue-worker.mjs";

const dir = mkdtempSync(join(tmpdir(), "zcode-rate-retry-"));
const realNow = Date.now;
let now = realNow(), q;
Date.now = () => now;
function setup(name, count = 1) {
  q?.close(); q = new MessageQueue(join(dir, name + ".sqlite"));
  const tasks = Array.from({ length: count }, (_, i) => ({ taskId: `sess_${name}-${i}`,
    workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" }));
  const ids = q.enqueue({ requestId: name, taskIds: tasks.map(t => t.taskId), prompt: "继续工作",
    context: { goal: "bounded retry test" } }).messages.map(m => m.messageId);
  const snapshots = tasks.map(() => ({ messages: [] })), sends = [];
  q.db.exec("UPDATE worker SET desired=1");
  let token = q.acquire();
  const connect = action => action({ open: async () => {}, list: async () => ({ tasks }),
    snapshot: async id => structuredClone(snapshots[tasks.findIndex(t => t.taskId === id)]),
    send: async (id, prompt) => {
      const i = tasks.findIndex(t => t.taskId === id), turn = sends.length + 1;
      sends.push({ id, prompt, at: now });
      tasks[i].displayStatus = "running"; delete tasks[i].lastError;
      snapshots[i].messages.push({ id: `user-${turn}`, role: "user", turnIndex: turn, content: prompt });
      return { result: { accepted: true } };
    } });
  function reply(i, status = "error") {
    const turn = snapshots[i].messages.at(-1).turnIndex;
    snapshots[i].messages.push({ id: `reply-${turn}`, role: "assistant", turnIndex: turn, content: "partial response" });
    tasks[i].displayStatus = status;
    if (status === "error") tasks[i].lastError = { code: "1308", attribution: { reason: "rate_limited", statusCode: 429 } };
  }
  return { ids, tasks, snapshots, sends, connect, reply,
    run: () => tick(q, token, connect),
    reopen: () => { q.release(token); q.close(); q = new MessageQueue(join(dir, name + ".sqlite")); token = q.acquire(); } };
}
try {
  const single = setup("single");
  await single.run(); assert.equal(single.sends.length, 1);
  single.reply(0); await single.run();
  const id = single.ids[0];
  assert.equal(q.get(id).state, "retry_wait");
  assert.equal(q.envelope(q.get(id)).retry.remainingSeconds, 300);
  for (let attempt = 1; attempt <= 5; attempt++) {
    now += RATE_RETRY.delayMs - 1;
    await single.run(); assert.equal(single.sends.length, attempt, "No early retry");
    now++; single.reopen();
    assert.equal(q.get(id).retry_count, attempt - 1, "Restart preserves budget");
    await single.run();
    assert.equal(single.sends.length, attempt + 1);
    assert.equal(q.get(id).retry_count, attempt, "ACK cannot reset budget");
    assert.equal(single.sends.at(-1).prompt, single.sends[0].prompt, "Same prompt, context and correlation marker");
    single.reply(0); await single.run();
    assert.equal(q.get(id).retry_count, attempt, "Assistant text cannot reset budget");
    assert.equal(q.get(id).state, attempt < 5 ? "retry_wait" : "needs_attention");
  }
  const blocked = q.read({ limit: 100 }).events.find(e => e.kind === "temporarily_blocked");
  assert.equal(blocked.payload.retries, 5); assert.match(blocked.payload.message, /暂时堵塞/);
  now += 10 * RATE_RETRY.delayMs; single.reopen(); await single.run();
  assert.equal(single.sends.length, 6, "Initial attempt plus five retries, never seven");

  const many = setup("many", 3);
  await many.run(); many.reply(0); many.reply(1); await many.run();
  assert.equal(many.sends.length, 3);
  const followup = q.enqueue({ requestId: "later-team", taskIds: ["sess_new"], teamId: "another-team", prompt: "new work" }).messages[0].messageId;
  assert.equal(q.ready(q.get(followup)), false, "New teams share cooldown too");
  // Reads still collect an unrelated running task's completion during cooldown.
  many.reply(2, "completed"); await many.run();
  assert.equal(q.get(many.ids[2]).state, "completed");
  assert(q.worker().rate_until > now, "An older completion cannot clear a newer cooldown");
  now += RATE_RETRY.delayMs;
  await many.run(); assert.equal(many.sends.length, 4, "One recovery send, not a simultaneous burst");
  const retriedIndex = many.ids.findIndex(mid => q.get(mid).retry_count === 1);
  const otherIndex = 1 - retriedIndex;
  assert.equal(q.get(many.ids[otherIndex]).state, "retry_wait");
  await many.run();
  assert(q.worker().rate_until > now, "Other retries keep shared recovery pacing");
  now += RATE_RETRY.delayMs; await many.run(); assert.equal(many.sends.length, 5);
  many.reply(otherIndex, "completed"); await many.run();
  assert(q.worker().rate_until > now, "An earlier in-flight retry still needs a result");
  many.reply(retriedIndex, "completed"); await many.run();
  assert.equal(q.worker().rate_until, 0, "Successful last recovery restores normal scheduling");
  assert.equal(q.get(many.ids[otherIndex]).retry_count, 1);

  const recoveryOrder = setup("recovery-order");
  await recoveryOrder.run(); recoveryOrder.reply(0); await recoveryOrder.run();
  recoveryOrder.tasks.push({ ...recoveryOrder.tasks[0], taskId: "sess_fresh-recovery", displayStatus: "completed" });
  recoveryOrder.snapshots.push({ messages: [] });
  const freshRecovery = q.enqueue({ requestId: "fresh-recovery", taskIds: ["sess_fresh-recovery"], prompt: "new authorized work" }).messages[0].messageId;
  assert.equal(q.worker().last_task, recoveryOrder.tasks[0].taskId, "Retain the real rotation cursor after rate limiting");
  now += RATE_RETRY.delayMs;
  await recoveryOrder.run();
  assert.equal(q.get(recoveryOrder.ids[0]).retry_count, 1, "Fresh-send priority must not overtake a retry's selected recovery slot");
  assert.equal(q.get(freshRecovery).state, "queued"); assert.equal(recoveryOrder.sends.length, 2);

  const wideRecovery = setup("wide-recovery");
  await wideRecovery.run(); wideRecovery.reply(0); await wideRecovery.run();
  const freshHeads = [];
  for (let i = 0; i < 9; i++) {
    const taskId = `sess_fresh-wide-${i}`;
    wideRecovery.tasks.push({ ...wideRecovery.tasks[0], taskId, displayStatus: "completed" });
    wideRecovery.snapshots.push({ messages: [] });
    freshHeads.push(q.enqueue({ requestId: `fresh-wide-${i}`, taskIds: [taskId], prompt: "new authorized work" }).messages[0].messageId);
  }
  assert.equal(q.worker().last_task, wideRecovery.tasks[0].taskId);
  now += RATE_RETRY.delayMs;
  const recoveryDue = q.worker().rate_until;
  await dispatch(q, q.get(freshHeads[0]), q.worker().token, wideRecovery.connect);
  assert.equal(wideRecovery.sends.length, 1, "Direct dispatch cannot take a due retry's recovery slot");
  assert.equal(q.claim(q.get(freshHeads[0]), q.worker().token, "unused-cursor"), false, "The transactional claim shares the same guard");
  await wideRecovery.run();
  assert.equal(wideRecovery.sends.length, 1, "A due retry outside the first eight heads retains the slot");
  assert.equal(q.worker().rate_until, recoveryDue, "Fresh heads cannot extend the expired cooldown");
  await wideRecovery.run();
  assert.equal(q.get(wideRecovery.ids[0]).retry_count, 1);
  assert.equal(wideRecovery.sends.length, 2, "Rotation reaches the retry without a fresh-send burst");
  assert(freshHeads.every(mid => q.get(mid).state === "queued"));

  const missingRecovery = setup("missing-recovery");
  await missingRecovery.run(); missingRecovery.reply(0); await missingRecovery.run();
  now += RATE_RETRY.delayMs;
  missingRecovery.tasks.splice(0, 1);
  missingRecovery.tasks.push({ taskId: "sess_after-missing", workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" });
  missingRecovery.snapshots.push({ messages: [] });
  const afterMissing = q.enqueue({ requestId: "after-missing", taskIds: ["sess_after-missing"], prompt: "new authorized work" }).messages[0].messageId;
  await missingRecovery.run();
  assert.equal(q.get(missingRecovery.ids[0]).state, "needs_attention", "A missing retry target releases the global recovery slot without replay");
  await missingRecovery.run();
  assert.equal(q.get(afterMissing).state, "acknowledged");
  assert.equal(missingRecovery.sends.length, 2, "Only the existing fresh message sends after the missing retry is isolated");

  const lateMissing = setup("late-missing");
  await lateMissing.run(); lateMissing.reply(0); await lateMissing.run();
  now += RATE_RETRY.delayMs;
  const lateTask = lateMissing.tasks[0];
  lateMissing.tasks.push({ taskId: "sess_after-late-missing", workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" });
  lateMissing.snapshots.push({ messages: [] });
  const afterLateMissing = q.enqueue({ requestId: "after-late-missing", taskIds: ["sess_after-late-missing"], prompt: "new authorized work" }).messages[0].messageId;
  let listCalls = 0;
  const lateMissingConnect = action => lateMissing.connect(client => action({ ...client, list: async () => ({
    tasks: ++listCalls < 3 ? lateMissing.tasks : lateMissing.tasks.filter(task => task.taskId !== lateTask.taskId)
  }) }));
  await dispatch(q, q.get(lateMissing.ids[0]), q.worker().token, lateMissingConnect);
  assert.equal(q.get(lateMissing.ids[0]).state, "needs_attention", "A target lost at the final inventory check releases its recovery slot");
  assert.equal(lateMissing.sends.length, 1, "The missing retry is not replayed");
  await dispatch(q, q.get(afterLateMissing), q.worker().token, lateMissing.connect);
  assert.equal(q.get(afterLateMissing).state, "acknowledged");

  const changed = setup("changed");
  await changed.run(); changed.reply(0); await changed.run();
  const following = q.enqueue({ requestId: "after-manual", taskIds: [changed.tasks[0].taskId], prompt: "new authorized message" }).messages[0].messageId;
  changed.snapshots[0].messages.push({ id: "manual", role: "user", content: "new direction", turnIndex: 2 });
  await changed.run();
  assert.equal(changed.sends.length, 1); assert.equal(q.get(changed.ids[0]).state, "released");
  assert(q.read({ limit: 100 }).events.some(e => e.kind === "retry_stopped"));
  assert(q.read({ limit: 100 }).events.some(e => e.kind === "message" && e.payload.id === "manual"), "Do not discard new incoming messages");
  now += RATE_RETRY.delayMs; await changed.run();
  assert.equal(changed.sends.length, 2, "External input retires the old retry without blocking a new queued message");
  assert.equal(q.get(following).retry_count, 0);

  const resumed = setup("resumed");
  await resumed.run(); resumed.reply(0); await resumed.run();
  now += RATE_RETRY.delayMs; await resumed.run();
  resumed.reply(0); await resumed.run();
  assert.equal(q.get(resumed.ids[0]).retry_count, 1);
  const waiting = q.enqueue({ requestId: "after-success", taskIds: [resumed.tasks[0].taskId], prompt: "follow-up" }).messages[0].messageId;
  // A late response resumes before the retry timer expires, then completes normally.
  resumed.snapshots[0].messages.at(-1).content += " resumed";
  resumed.tasks[0].displayStatus = "running";
  await resumed.run(); assert.equal(q.get(resumed.ids[0]).state, "acknowledged");
  assert(q.read({ limit: 100 }).events.some(e => e.kind === "message" && e.payload.content.includes("resumed")));
  resumed.tasks[0].displayStatus = "completed";
  await resumed.run(); assert.equal(q.get(resumed.ids[0]).state, "completed");
  assert.equal(q.get(resumed.ids[0]).retry_count, 1, "Success retains audit count but terminates retries");
  assert.equal(q.get(resumed.ids[0]).retry_at, null);
  now += RATE_RETRY.delayMs; await resumed.run();
  assert.equal(resumed.sends.length, 3); assert(resumed.sends.at(-1).prompt.endsWith("follow-up"));
  assert.equal(q.get(waiting).retry_count, 0, "Same conversation's new message has its own budget");
  resumed.reply(0); await resumed.run(); now += RATE_RETRY.delayMs; await resumed.run();
  assert.equal(q.get(waiting).retry_count, 1);
  assert.equal(q.get(resumed.ids[0]).retry_count, 1);

  const offline = setup("offline");
  await offline.run(); offline.reply(0); await offline.run(); now += RATE_RETRY.delayMs;
  await dispatch(q, q.get(offline.ids[0]), q.worker().token, async () => { throw Error("offline"); });
  assert.equal(q.get(offline.ids[0]).retry_count, 0, "Preflight failure does not spend a send attempt");
  q.db.exec("UPDATE worker SET desired=0"); await offline.run(); assert.equal(offline.sends.length, 1);
  q.db.exec("UPDATE worker SET desired=1");
  await dispatch(q, q.get(offline.ids[0]), q.worker().token, action => offline.connect(client => action({ ...client,
    send: async (...args) => { await client.send(...args); throw Error("ACK lost"); } })));
  assert.equal(q.get(offline.ids[0]).state, "uncertain");
  assert.equal(q.get(offline.ids[0]).retry_count, 1);
  now += RATE_RETRY.delayMs; await offline.run(); assert.equal(offline.sends.length, 2, "No replay of ambiguous transport failure");

  const migration = setup("migration");
  const previous = q.read().events;
  q.release(q.worker().token);
  q.db.exec("ALTER TABLE messages DROP COLUMN retry_count; ALTER TABLE messages DROP COLUMN retry_at; ALTER TABLE worker DROP COLUMN rate_until; ALTER TABLE worker DROP COLUMN rate_probe; PRAGMA user_version=4");
  q.close(); q = new MessageQueue(join(dir, "migration.sqlite"));
  assert.equal(q.get(migration.ids[0]).retry_count, 0); assert.equal(q.worker().rate_until, 0);
  assert.deepEqual(q.read().events, previous, "Schema-4 migration preserves messages and events");
  console.log("zcode-ops rate retry: 300s, five attempts, durable budget, shared cooldown, read continuity and manual-change guard OK");
} finally { Date.now = realNow; q?.close(); rmSync(dir, { recursive: true, force: true }); }
