import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageQueue, startWorker, callQueueTool } from "./message-queue.mjs";
import { callPublicTool, publicTools } from "./tools.mjs";

assert.equal(publicTools.length, 8);
const calls = [];
let events = [], clock = 0;
const deps = {
  remote: async (name, args) => { calls.push({ name, args }); return { tasks: [], errors: [], missing: [], cursors: Object.fromEntries((args.taskIds ?? []).map(id => [id, "native-cursor"])) }; },
  queue: async (name, args) => { calls.push({ name, args }); return { events: events.filter(e => e.cursor > args.after), cursor: events.at(-1)?.cursor ?? args.after ?? 0 }; },
  config: async (name, args) => { calls.push({ name, args }); return { saved: true }; },
  now: () => clock, delay: async n => { clock += n; }
};
for (const taskIds of [["sess_a"], ["sess_a", "sess_b"]]) {
  await callPublicTool("zcode_send", { requestId: "id", taskIds, prompt: "你好" }, deps);
  assert.equal(calls.at(-1).name, "zcode_queue_send");
}
await callPublicTool("zcode_send", { requestId: "new-task", workspace: { path: "test-workspace" }, prompt: "你好" }, deps);
assert.equal(calls.at(-1).name, "zcode_queue_send");
const page = await callPublicTool("zcode_read", { taskIds: ["sess_b", "sess_a"] }, deps);
await callPublicTool("zcode_read", { taskIds: ["sess_a", "sess_b"], cursor: page.cursor, waitMs: 10 }, deps);
assert.equal(calls.at(-1).name, "zcode_remote_wait_many");
await assert.rejects(callPublicTool("zcode_read", { taskIds: ["sess_a"], cursor: page.cursor }, deps), /changed view/);
await assert.rejects(callPublicTool("zcode_read", { view: "inbox", cursor: page.cursor }, deps), /changed view/);
await assert.rejects(callPublicTool("zcode_read", { taskIds: ["sess_a"], waitMs: 1 }, deps), /Read once/);
const inbox = await callPublicTool("zcode_read", { teamId: "team" }, deps);
const waited = await callPublicTool("zcode_read", { teamId: "team", cursor: inbox.cursor, waitMs: 10 }, deps);
assert.equal(waited.changed, false); assert.equal(clock, 10);
events = [{ cursor: 1, payload: "new" }];
const next = await callPublicTool("zcode_read", { teamId: "team", cursor: inbox.cursor }, deps);
assert(next.changed);
assert.equal((await callPublicTool("zcode_read", { teamId: "team", cursor: next.cursor }, deps)).events.length, 0);
for (const action of ["pause", "resume"]) {
  await assert.rejects(callPublicTool("zcode_control", { action }, deps), /affects all teams/);
  await callPublicTool("zcode_control", { action, scope: "all", expectedRevision: 0 }, deps); assert.equal(calls.at(-1).name, "zcode_queue_control");
}
const consumerPage = await callPublicTool("zcode_read", { view: "inbox", consumerId: "reader-a" }, deps);
await assert.rejects(callPublicTool("zcode_read", { view: "inbox", consumerId: "reader-b", cursor: consumerPage.cursor }, deps), /changed view/);
await assert.rejects(callPublicTool("zcode_control", { action: "acknowledge_message", messageId: "m", throughEvent: 1 }, deps), /consumerId/);
await callPublicTool("zcode_control", { action: "stop_task", taskId: "sess_a" }, deps);
assert.equal(calls.at(-1).name, "zcode_remote_cancel");
await assert.rejects(callPublicTool("zcode_control", { action: "stop_task", messageId: "x" }, deps), /requires only taskId/);
await callPublicTool("zcode_control", { action: "cancel_message", messageId: "x" }, deps);
assert.equal(calls.at(-1).args.decision, "cancel");
await callPublicTool("zcode_config_set", { sharingLink: null }, deps); assert.equal(calls.at(-1).name, "zcode_config_clear");
for (const args of [{ prompt: "x" }, { requestId: "r", taskIds: ["bad"], prompt: "x" },
  { requestId: "r", taskIds: ["sess_a", "sess_a"], prompt: "x" },
  { requestId: "r", taskIds: ["sess_a"], workspace: { path: "test-workspace" }, prompt: "x" },
  { requestId: "r", workspace: [{ path: "test-workspace" }], prompt: "x" },
  { requestId: "r", workspace: { path: "test-workspace", extra: true }, prompt: "x" },
  { requestId: "r", workspace: { path: "test-workspace" }, prompt: "" }])
  await assert.rejects(callPublicTool("zcode_send", args, deps));

const dir = mkdtempSync(join(tmpdir(), "zcode-public-test-"));
const original = process.env.ZCODE_OPS_CONFIG;
let q;
try {
  process.env.ZCODE_OPS_CONFIG = join(dir, "config.json");
  let launches = 0;
  const launch = async () => { launches++; };
  const sendDeps = { queue: (name, args) => callQueueTool(name, args, { launch }) };
  const input = { requestId: "new", taskIds: ["sess_a"], prompt: "saved" };
  const sent = await callPublicTool("zcode_send", input, sendDeps);
  assert.equal(launches, 1); assert.equal(sent.messages[0].state, "queued"); assert(!sent.worker.paused);
  await callPublicTool("zcode_control", { action: "pause", scope: "all", expectedRevision: sent.worker.controlRevision }, sendDeps);
  const paused = await callPublicTool("zcode_send", { ...input, requestId: "paused" }, sendDeps);
  assert(paused.worker.paused); assert.equal(launches, 1);
  const retry = await callPublicTool("zcode_send", input, sendDeps);
  assert(retry.deduplicated); assert.equal(launches, 1);
  const batchInbox = await callPublicTool("zcode_read", { view: "inbox", taskIds: ["sess_a", "sess_b"] }, sendDeps);
  assert.equal(batchInbox.messages.length, 2);
  await assert.rejects(callPublicTool("zcode_control", { action: "resume", scope: "all", expectedRevision: sent.worker.controlRevision }, sendDeps), /control changed/);
  await callPublicTool("zcode_control", { action: "resume", scope: "all", expectedRevision: paused.worker.controlRevision }, sendDeps); assert.equal(launches, 2);
  q = new MessageQueue(); q.db.exec("UPDATE worker SET starting_token=NULL"); q.close(); q = null; // Simulated launcher never acquired its reservation.
  const fail = await callQueueTool("zcode_queue_send", { ...input, requestId: "spawn-fail" }, { launch: async () => { throw Error("spawn unavailable"); } });
  assert(fail.startupError); assert.equal(fail.messages[0].state, "queued", "Saved receipt survives startup failure");

  // Recreate the real old schema, reopen it, preserve messages/events and a stopped worker.
  q = new MessageQueue(join(dir, "old.sqlite"));
  q.enqueue({ ...input, requestId: "old" }); const before = q.read(); q.close(); q = null;
  const old = new DatabaseSync(join(dir, "old.sqlite"));
  old.exec("ALTER TABLE worker DROP COLUMN paused; PRAGMA user_version=0"); old.close();
  q = new MessageQueue(join(dir, "old.sqlite"));
  assert.deepEqual(q.read().events, before.events); assert.deepEqual(q.read().messages, before.messages);
  assert(q.read().worker.paused); assert.equal(q.db.prepare("PRAGMA user_version").get().user_version, 9);
  assert.equal(q.db.prepare("SELECT target_kind FROM messages WHERE request_id='old'").get().target_kind, "task");
  await startWorker(q, { launch }); assert.equal(launches, 2, "Old stopped worker stays paused after migration");
  q.close(); q = new MessageQueue(join(dir, "old.sqlite")); assert(q.worker().paused); q.close(); q = null;
  const future = new DatabaseSync(join(dir, "future.sqlite")); future.exec("PRAGMA user_version=99"); future.close();
  assert.throws(() => new MessageQueue(join(dir, "future.sqlite")), /newer/);
  q = new MessageQueue(join(dir, "idle.sqlite")); q.db.exec("UPDATE worker SET desired=1");
  const token = q.acquire(); assert(!q.continueOrRelease(token)); assert.equal(q.worker().token, null);
  q.enqueue(input); await startWorker(q, { launch }); assert.equal(launches, 3, "New sends can wake an idle worker");
  const running = q.acquire(q.worker().starting_token); assert(running); assert(q.continueOrRelease(running), "Do not lose a queued send at idle exit");
  console.log("zcode-ops simplified tools: unified send/read, cursor binding, pause semantics, old-schema reopen and startup failure OK");
} finally {
  q?.close();
  if (original === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = original;
  rmSync(dir, { recursive: true, force: true });
}
