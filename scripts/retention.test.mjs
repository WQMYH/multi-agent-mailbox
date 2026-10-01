import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, LIMITS, normalizeContext, QUEUE_SCHEMA_VERSION } from "./message-queue.mjs";
import { callPublicTool } from "./tools.mjs";
import { tick } from "./queue-worker.mjs";

const dir = mkdtempSync(join(tmpdir(), "zcode-retention-test-"));
let q;
const enqueue = (i, context = {}) => q.enqueue({ requestId: `r-${i}`, taskIds: [`sess_${i}`], prompt: "消息", teamId: `team-${i}`, context }).messages[0].messageId;
const finish = (id, received = false) => {
  q.transaction(() => q.state(q.get(id), "completed"));
  if (received) {
    const page = q.read({ taskId: q.get(id).task_id, consumerId: "retention-test" });
    q.consume(id, page.envelopes[0].receipt.throughEvent, "retention-test");
  }
};
try {
  q = new MessageQueue(join(dir, "retention.sqlite"));
  assert.equal(q.db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  const first = enqueue(0, { goal: "独立理解任务", sourceAgent: "codex", references: ["repo:README.md"] });
  assert.throws(() => q.consume(first, 1), /terminal/);
  finish(first);
  assert.throws(() => q.consume(first, 1), /Receipt changed/);
  const firstEvent = q.envelope(q.get(first)).lastEvent;
  q.read({ taskId: "sess_0", consumerId: "retention-test" });
  q.consume(first, firstEvent, "retention-test");
  const protectedId = enqueue(1); finish(protectedId); // Finished is NOT received.
  for (let i = 2; i < LIMITS.records; i++) { const id = enqueue(i); finish(id, true); }
  const last = enqueue(500); // Reclaim the oldest eligible whole body, not the previous item.
  assert(q.get(first).pruned_at); assert.equal(q.get(first).prompt, "");
  assert(!q.get(protectedId).pruned_at); assert(!q.get(last).pruned_at);
  assert.equal(q.read().storage.fullRecords, 500);
  assert(q.read({ after: 1 }).historyGap);
  assert(q.enqueue({ requestId: "r-0", taskIds: ["sess_0"], prompt: "消息", teamId: "team-0",
    context: { references: ["repo:README.md"], sourceAgent: "codex", goal: "独立理解任务" } }).deduplicated);
  assert.throws(() => q.enqueue({ requestId: "r-0", taskIds: ["sess_0"], prompt: "different", teamId: "team-0" }), /different/);
  const page = q.read({ taskId: "sess_1", consumerId: "retention-test" });
  assert.equal(page.envelopes[0].destination.taskId, "sess_1");
  assert.equal(page.envelopes[0].prompt, "消息");
  const deps = { queue: async (name, args) => {
    assert.equal(name, "zcode_queue_resolve"); assert.equal(args.decision, "received");
    return q.consume(args.messageId, args.throughEvent, args.consumerId);
  } };
  assert((await callPublicTool("zcode_control", { action: "acknowledge_message", messageId: protectedId, consumerId: "retention-test", throughEvent: page.envelopes[0].receipt.throughEvent }, deps)).received);
  await assert.rejects(callPublicTool("zcode_control", { action: "pause", throughEvent: 2 }, deps));
  assert.throws(() => normalizeContext({ arbitrary: "no" }));
  assert.throws(() => normalizeContext({ goal: [] }));
  assert.throws(() => q.enqueue({ requestId: "oversize", taskIds: ["sess_x"], prompt: "中".repeat(20000) }), /40000/);
  q.close(); q = new MessageQueue(join(dir, "retention.sqlite"));
  assert(q.get(first).pruned_at); assert(q.get(protectedId).consumed_at);
  q.db.prepare("UPDATE messages SET pruned_at=? WHERE id=?").run(Date.now() - 8 * 86400000, first);
  q.maintain(); assert.equal(q.get(first), undefined, "Only expired whole-request tombstones may disappear");
  q.close();

  // All 500 unconsumed results stay intact: reject entry 501, no automatic 'read' acknowledgement.
  q = new MessageQueue(join(dir, "protected.sqlite"));
  for (let i = 0; i < 500; i++) { const id = enqueue(i); finish(id); }
  assert.throws(() => enqueue(501), /capacity/);
  assert.equal(q.db.prepare("SELECT count(*) AS n FROM messages WHERE pruned_at IS NOT NULL").get().n, 0);
  q.close();

  // A real schema-2 WAL database migrates to the current schema without changing old event bodies/ids.
  const oldPath = join(dir, "old.sqlite"), old = new DatabaseSync(oldPath);
  old.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=2;
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,request_id TEXT NOT NULL,
      task_id TEXT NOT NULL,team_id TEXT,prompt TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',cursor TEXT,native_id TEXT,
      turn_index INTEGER,reply_seen INTEGER NOT NULL DEFAULT 0,native_status TEXT,created_at INTEGER NOT NULL,UNIQUE(request_id,task_id));
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL,task_id TEXT NOT NULL,team_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE worker(id INTEGER PRIMARY KEY,token TEXT,pid INTEGER,desired INTEGER NOT NULL DEFAULT 0,heartbeat INTEGER,error TEXT,last_task TEXT,paused INTEGER NOT NULL DEFAULT 0);
    INSERT INTO worker(id,paused) VALUES(1,1);
    INSERT INTO messages(id,request_id,task_id,prompt,state,created_at) VALUES('old-id','old-request','sess_old','旧正文','completed',1);
    INSERT INTO events(message_id,task_id,kind,payload,created_at) VALUES('old-id','sess_old','message','{"content":"旧回复"}',2);`);
  old.close(); q = new MessageQueue(oldPath);
  assert.equal(q.db.prepare("PRAGMA user_version").get().user_version, QUEUE_SCHEMA_VERSION);
  assert.equal(q.read().events[0].payload.content, "旧回复");
  assert.equal(q.get("old-id").consumed_at, null); assert(q.worker().paused);
  assert(q.enqueue({ requestId: "old-request", taskIds: ["sess_old"], prompt: "旧正文" }).deduplicated);
  q.close();

  // Schema 3 confirmations lacked per-reader delivery proof: preserve bodies and reset them.
  const v3Path = join(dir, "schema3.sqlite"); q = new MessageQueue(v3Path);
  const v3Message = enqueue("v3"); finish(v3Message, true);
  const v3Events = q.read().events; q.close();
  const v3 = new DatabaseSync(v3Path);
  v3.exec(`DROP TABLE readers; DROP TABLE remote_requests;
    ALTER TABLE worker DROP COLUMN starting_token; ALTER TABLE worker DROP COLUMN starting_pid;
    ALTER TABLE worker DROP COLUMN starting_at; ALTER TABLE worker DROP COLUMN control_revision;
    PRAGMA user_version=3;`);
  v3.close(); q = new MessageQueue(v3Path);
  assert.deepEqual(q.read().events, v3Events); assert.equal(q.get(v3Message).consumed_at, null);
  assert.equal(q.get(v3Message).prompt, "消息"); q.close();

  // SQLite itself refuses oversized writes; measure main+rollback journal while transaction is open.
  const capPath = join(dir, "cap.sqlite"); q = new MessageQueue(capPath);
  const disk = () => ["", "-journal", "-wal", "-shm"].reduce((n, suffix) => {
    try { return n + statSync(capPath + suffix).size; } catch (e) { if (e.code === "ENOENT") return n; throw e; }
  }, 0);
  q.db.exec("CREATE TABLE capacity_probe(payload BLOB)");
  q.transaction(() => { for (let i = 0; i < 100; i++) q.db.exec("INSERT INTO capacity_probe VALUES(zeroblob(64000))"); });
  q.transaction(() => { q.db.exec("UPDATE capacity_probe SET payload=randomblob(64000)"); assert(disk() < LIMITS.diskBytes); });
  assert.throws(() => q.transaction(() => q.db.exec("INSERT INTO capacity_probe VALUES(zeroblob(12000000))")), /full/);
  assert.equal(q.db.prepare("SELECT count(*) AS n FROM capacity_probe").get().n, 100);
  assert(disk() < LIMITS.diskBytes);
  const id = enqueue("paused-for-capacity");
  q.transaction(() => q.state(q.get(id), "acknowledged"));
  q.observe(q.get(id), { messages: [{ content: "x".repeat(1_000_000) }], task: { status: "completed" } });
  assert(q.worker().paused); assert.equal(q.get(id).state, "acknowledged"); assert.equal(q.get(id).cursor, null);
  assert.equal(q.worker().error, "storage_capacity_reached");
  q.close();

  // Twelve separate teams can be active; 8 is a per-cycle task budget, not a global team cap.
  q = new MessageQueue(join(dir, "teams.sqlite"));
  for (let i = 0; i < 12; i++) enqueue(i);
  q.db.exec("UPDATE worker SET desired=1"); const token = q.acquire();
  const tasks = Array.from({ length: 12 }, (_, i) => ({ taskId: `sess_${i}`, workspacePath: "same", workspaceKind: "local", displayStatus: "completed" }));
  const sent = [], connect = action => action({ list: async () => ({ tasks }), open: async () => {}, snapshot: async () => ({ messages: [] }),
    send: async id => { sent.push(id); tasks.find(t => t.taskId === id).displayStatus = "running"; return { result: { accepted: true } }; } });
  await tick(q, token, connect); assert.equal(sent.length, 8);
  await tick(q, token, connect); assert.equal(new Set(sent).size, 12);
  assert.equal(q.db.prepare("SELECT count(DISTINCT team_id) AS n FROM messages WHERE state='acknowledged'").get().n, 12);
  console.log("zcode-ops retention: 500 records, protected unread results, UTF-8 bounds, tombstones, schema-2 migration, <20MB journal-inclusive writes and 12 teams OK");
} finally { q?.close(); rmSync(dir, { recursive: true, force: true }); }
