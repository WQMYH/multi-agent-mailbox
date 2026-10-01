import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, LIMITS, assignmentOf, QUEUE_SCHEMA_VERSION } from "./message-queue.mjs";
import { callPublicTool } from "./tools.mjs";
import { tick } from "./queue-worker.mjs";

const legacy = String.raw`identity={instanceId:"FA05-r3",pairedPrimaryInstanceId:"peer"}。writeRoot=E:\audit\FA05-r3。`;
assert.deepEqual(assignmentOf(legacy), { instanceId: "FA05-r3", writeRoot: "e:\\audit\\fa05-r3" });
assert.deepEqual(assignmentOf('pairedPrimaryInstanceId:"peer"; 禁止读取旧 writeRoot'), {});
assert.deepEqual(assignmentOf('identity.instanceId="space"; writeRoot="E:/Audit/My Root/"'), { instanceId: "space", writeRoot: "e:\\audit\\my root" });
assert.deepEqual(assignmentOf(JSON.stringify({ identity: { instanceId: "json" }, writeRoot: "E:\\Audit\\JSON" })), { instanceId: "json", writeRoot: "e:\\audit\\json" });
assert.deepEqual(assignmentOf(JSON.stringify({ identity: { instanceId: "owner", pairedPrimaryInstanceId: "peer" },
  writeRoot: "E:/Audit/Owner", gates: { predecessors: [{ instanceId: "baseline" }] } }, null, 2)), { instanceId: "owner", writeRoot: "e:\\audit\\owner" });
assert.throws(() => assignmentOf("instanceId=one\ninstanceId=two"), /Conflicting/);
assert.throws(() => assignmentOf(String.raw`writeRoot=E:\My Folder`), /Quote/);
assert.throws(() => assignmentOf("", { writeRoot: "relative" }), /absolute/);
assert.throws(() => assignmentOf('identity.instanceId="unfinished'), /Invalid/);
assert.throws(() => assignmentOf("writeRoot="), /Invalid/);

const dir = mkdtempSync(join(tmpdir(), "zcode-assignment-")), path = join(dir, "queue.sqlite");
let q;
try {
  q = new MessageQueue(path);
  const input = { requestId: "first", taskIds: ["sess_first"], prompt: "new assignment",
    context: { instanceId: "first", writeRoot: "E:/Audit/First" } };
  const first = (await callPublicTool("zcode_send", input, { queue: (_name, args) => q.enqueue(args) })).messages[0].messageId;
  q.state(q.get(first), "completed");
  assert.equal(q.enqueue(input).messages[0].messageId, first, "The original request remains idempotent");
  const count = q.db.prepare("SELECT count(*) AS n FROM messages").get().n;
  for (const context of [{ instanceId: "first", writeRoot: "E:/elsewhere" },
    { instanceId: "other", writeRoot: "e:/AUDIT/temp/../FIRST/" }])
    assert.throws(() => q.enqueue({ ...input, requestId: "collision", taskIds: ["sess_other"], context }), /DUPLICATE_ASSIGNMENT/);
  assert.equal(q.db.prepare("SELECT count(*) AS n FROM messages").get().n, count, "Rejected assignments create no partial messages");
  assert.throws(() => q.enqueue({ requestId: "batch", taskIds: ["sess_a", "sess_b"], prompt: legacy }), /exactly one/);
  assert.throws(() => q.enqueue({ ...input, requestId: "disagreement", prompt: 'instanceId="different"' }), /Conflicting/);
  const fresh = q.enqueue({ ...input, requestId: "fresh", context: { instanceId: "fresh", writeRoot: "E:/Audit/Fresh" } }).messages[0].messageId;
  q.state(q.get(fresh), "completed");

  // A genuine schema-5 backlog can contain an older delayed send and a newer sealed fallback.
  const head = q.enqueue({ requestId: "head", taskIds: ["sess_delayed"], prompt: "paused old work" }).messages[0].messageId;
  q.state(q.get(head), "needs_attention");
  const delayed = q.enqueue({ requestId: "delayed", taskIds: ["sess_delayed"], prompt: legacy }).messages[0].messageId;
  const sealed = q.enqueue({ requestId: "sealed", taskIds: ["sess_fallback"], prompt: "legacy placeholder" }).messages[0].messageId;
  q.db.prepare("UPDATE messages SET prompt=? WHERE id=?").run(legacy, sealed);
  q.state(q.get(sealed), "completed");
  q.db.exec("ALTER TABLE messages DROP COLUMN assignment; PRAGMA user_version=5");
  const rows = q.db.prepare("SELECT * FROM messages ORDER BY seq").all(), events = q.db.prepare("SELECT * FROM events ORDER BY seq").all();
  q.close(); q = new MessageQueue(path);
  assert.equal(q.db.prepare("PRAGMA user_version").get().user_version, QUEUE_SCHEMA_VERSION);
  assert.deepEqual(q.db.prepare("SELECT * FROM messages ORDER BY seq").all().map(({ assignment, ...row }) => row), rows.map(row => ({ ...row })));
  assert.deepEqual(q.db.prepare("SELECT * FROM events ORDER BY seq").all(), events, "Migration preserves every existing event");
  q.resolve({ messageId: head, decision: "release" });
  q.db.exec("UPDATE worker SET desired=1");
  const token = q.acquire(); let sends = 0;
  const task = { taskId: "sess_delayed", workspacePath: "workspace", workspaceKind: "local", displayStatus: "completed" };
  await tick(q, token, action => action({ open: async () => {}, list: async () => ({ tasks: [task] }), snapshot: async () => ({ messages: [] }),
    send: async () => { sends++; return { result: { accepted: true } }; } }));
  assert.equal(sends, 0, "Releasing a FIFO head cannot bypass cross-session assignment admission");
  assert.equal(q.get(delayed).state, "needs_attention");
  assert.equal(q.blocking(delayed).blockedReason, "duplicate_assignment");
  assert.equal(q.blocking(delayed).blockedByMessageId, sealed, "A newer accepted fallback blocks the older delayed message too");
  assert.equal(q.get(delayed).prompt, legacy); assert.equal(q.get(sealed).state, "completed");
  q.release(token);

  const page = q.read({ taskId: "sess_first", consumerId: "assignment-test" });
  q.consume(first, page.envelopes[0].receipt.throughEvent, "assignment-test");
  q.maintain(LIMITS.records);
  assert(q.get(first).pruned_at); assert.equal(q.get(first).prompt, "");
  q.close(); q = new MessageQueue(path);
  assert.throws(() => q.enqueue({ ...input, requestId: "after-pruning", taskIds: ["sess_later"] }), /DUPLICATE_ASSIGNMENT/);
  assert(q.enqueue(input).deduplicated, "Pruning keeps both request and assignment deduplication");
  console.log("zcode-ops assignment: cross-session admission, delayed dispatch, schema-5 preservation and retained declarations OK");
} finally { q?.close(); rmSync(dir, { recursive: true, force: true }); }
