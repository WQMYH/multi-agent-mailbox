import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.mjs";

export const queuePath = () => join(dirname(configPath()), "messages.sqlite");
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const terminal = "'completed','released','cancelled'";
export const marker = id => `[[zcode-ops:${id}]]`;
export const RATE_RETRY = Object.freeze({ delayMs: 300_000, maxRetries: 5 });
export const LIMITS = Object.freeze({ diskBytes: 20_000_000, databaseBytes: 9_000_000,
  workingBytes: 7_000_000, records: 500, pending: 100, requestBytes: 40_000, dedupDays: 7, readers: 16 });
const startupMs = 30000;
const startupLive = w => w.starting_token && alive(w.starting_pid) && Date.now() - w.starting_at < startupMs;
const busy = e => [5, 6].includes(e.errcode & 255);
const retryBusy = fn => {
  const deadline = performance.now() + 5000;
  for (;;) {
    try { return fn(); }
    catch (e) {
      if (!busy(e) || performance.now() >= deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
};
const finished = state => ["completed", "released", "cancelled"].includes(state);
const bytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const contextFields = ["sourceAgent", "sourceTaskId", "sourceWorkspace", "replyTo", "goal", "background", "constraints", "expectedReply"];
export const contextSchema = { type: "object", additionalProperties: false, properties: {
  ...Object.fromEntries(contextFields.map(key => [key, { type: "string", minLength: 1, maxLength: 2048 }])),
  references: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 2048 } }
} };
export function normalizeContext(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid context");
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(contextSchema.properties, key)) throw Error(`Unexpected context.${key}`);
    const valid = s => typeof s === "string" && s.trim() && s.length <= 2048;
    if (key === "references" ? !Array.isArray(item) || item.length > 10 || !item.every(valid) : !valid(item)) throw Error(`Invalid context.${key}`);
  }
  const result = Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  if (bytes(result) > 8000) throw Error("Context exceeds 8000 UTF-8 bytes");
  return result;
}
const fingerprint = (taskIds, prompt, teamId, context) => createHash("sha256")
  .update(JSON.stringify([[...taskIds].sort(), prompt, teamId, context])).digest("hex");
const diskSize = path => ["", "-journal", "-wal", "-shm"].reduce((sum, suffix) => {
  try { return sum + statSync(path + suffix).size; } catch (e) { if (e.code === "ENOENT") return sum; throw e; }
}, 0);

// ponytail: one local SQLite journal, not a distributed broker. Split hosts only when needed.
export class MessageQueue {
  constructor(path = queuePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
    // Set the busy handler BEFORE the first read, including a cold concurrent open.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 5) throw Error("Queue schema is newer than this plugin");
    if (version < 5 && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='worker'").get()) {
      const w = this.worker();
      if (w.token && alive(w.pid)) throw Error("Stop the old queue worker before upgrading");
    }
    this.pageSize = this.db.prepare("PRAGMA page_size").get().page_size;
    const maxPages = Math.floor(LIMITS.databaseBytes / this.pageSize);
    if (this.db.prepare("PRAGMA page_count").get().page_count > maxPages || diskSize(path) > LIMITS.diskBytes ||
      LIMITS.databaseBytes + diskSize(path) - statSync(path).size > LIMITS.diskBytes) throw Error("Existing queue exceeds storage budget; preserve it and resolve manually");
    // ponytail: DELETE journal + capped main file bounds disk without a WAL manager.
    // Cache spilling is disabled so each original page is journalled at most once.
    if (this.db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete") retryBusy(() => this.db.exec("PRAGMA journal_mode=DELETE"));
    this.db.exec(`PRAGMA synchronous=FULL; PRAGMA cache_spill=OFF;
      PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA max_page_count=${maxPages};`);
    if (this.db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete") throw Error("Cannot switch queue journal; close old clients first");
    if (version < 4) this.transaction(() => {
    if (this.db.prepare("PRAGMA user_version").get().user_version >= 4) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, request_id TEXT NOT NULL,
        task_id TEXT NOT NULL, team_id TEXT, prompt TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        cursor TEXT, native_id TEXT, turn_index INTEGER, reply_seen INTEGER NOT NULL DEFAULT 0,
        native_status TEXT, created_at INTEGER NOT NULL, UNIQUE(request_id, task_id));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, task_id TEXT NOT NULL,
        team_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, pid INTEGER,
        desired INTEGER NOT NULL DEFAULT 0, heartbeat INTEGER, error TEXT, last_task TEXT, paused INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO worker(id) VALUES(1);`);
        if (!this.db.prepare("PRAGMA table_info(worker)").all().some(c => c.name === "paused")) {
          const w = this.worker();
          if (w.token && alive(w.pid)) throw Error("Stop the old queue worker before upgrading");
          this.db.exec("ALTER TABLE worker ADD COLUMN paused INTEGER NOT NULL DEFAULT 0; UPDATE worker SET paused=CASE WHEN desired=0 THEN 1 ELSE 0 END");
        }
        const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(c => c.name));
        for (const [name, type] of Object.entries({ context: "TEXT NOT NULL DEFAULT '{}'", request_hash: "TEXT", consumed_at: "INTEGER", pruned_at: "INTEGER" })) {
          if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS retention (id INTEGER PRIMARY KEY CHECK(id=1), through_event INTEGER NOT NULL DEFAULT 0,
          pruned_count INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO retention(id) VALUES(1);
          CREATE INDEX IF NOT EXISTS events_message ON events(message_id,seq);`);
        for (const { request_id } of this.db.prepare("SELECT DISTINCT request_id FROM messages WHERE request_hash IS NULL").all()) {
          const rows = this.db.prepare("SELECT * FROM messages WHERE request_id=? ORDER BY task_id").all(request_id), first = rows[0];
          this.db.prepare("UPDATE messages SET request_hash=? WHERE request_id=?").run(fingerprint(rows.map(r => r.task_id), first.prompt, first.team_id, normalizeContext(JSON.parse(first.context))), request_id);
        }
        const workerColumns = new Set(this.db.prepare("PRAGMA table_info(worker)").all().map(c => c.name));
        for (const [name, type] of Object.entries({ starting_token: "TEXT", starting_pid: "INTEGER", starting_at: "INTEGER", control_revision: "INTEGER NOT NULL DEFAULT 0" })) {
          if (!workerColumns.has(name)) this.db.exec(`ALTER TABLE worker ADD COLUMN ${name} ${type}`);
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS readers (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, consumer_id TEXT NOT NULL,
          through_event INTEGER NOT NULL DEFAULT 0, acknowledged_event INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(message_id,consumer_id));
          CREATE TABLE IF NOT EXISTS remote_requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, pid INTEGER NOT NULL);
          UPDATE messages SET consumed_at=NULL WHERE pruned_at IS NULL;
          PRAGMA user_version=4;`);
      });
    if (version < 5) this.transaction(() => {
      if (this.db.prepare("PRAGMA user_version").get().user_version === 5) return;
      const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(c => c.name));
      for (const [name, type] of Object.entries({ retry_count: "INTEGER NOT NULL DEFAULT 0", retry_at: "INTEGER" })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      if (!this.db.prepare("PRAGMA table_info(worker)").all().some(c => c.name === "rate_until"))
        this.db.exec("ALTER TABLE worker ADD COLUMN rate_until INTEGER NOT NULL DEFAULT 0; ALTER TABLE worker ADD COLUMN rate_probe TEXT");
      this.db.exec("PRAGMA user_version=5");
    });
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    // Only local, fully rolled-back transactions are retried; never remote actions.
    return retryBusy(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); this.db.exec("COMMIT"); return result; }
      catch (e) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw e; }
    });
  }
  usedBytes() { return (this.db.prepare("PRAGMA page_count").get().page_count - this.db.prepare("PRAGMA freelist_count").get().freelist_count) * this.pageSize; }
  maintain(extraRecords = 0, extraBytes = 0) {
    return this.transaction(() => {
      const expired = Date.now() - LIMITS.dedupDays * 86400000;
      this.db.prepare(`DELETE FROM messages WHERE request_id IN (SELECT request_id FROM messages GROUP BY request_id
        HAVING count(*)=count(pruned_at) AND max(pruned_at)<?)`).run(expired);
      let removed = 0;
      while (this.db.prepare("SELECT count(*) AS n FROM messages WHERE pruned_at IS NULL").get().n + extraRecords > LIMITS.records || this.usedBytes() + extraBytes > LIMITS.workingBytes) {
        const row = this.db.prepare(`SELECT * FROM messages WHERE state IN (${terminal}) AND consumed_at IS NOT NULL AND pruned_at IS NULL ORDER BY created_at,seq LIMIT 1`).get();
        if (!row) break;
        const end = this.db.prepare("SELECT coalesce(max(seq),0) AS n FROM events WHERE message_id=?").get(row.id).n;
        this.db.prepare("UPDATE retention SET through_event=max(through_event,?),pruned_count=pruned_count+1 WHERE id=1").run(end);
        this.db.prepare("DELETE FROM events WHERE message_id=?").run(row.id);
        this.db.prepare("UPDATE messages SET prompt='',context='{}',cursor=NULL,pruned_at=? WHERE id=?").run(Date.now(), row.id);
        removed++;
      }
      return removed;
    });
  }
  envelope(row) {
    const failure = this.db.prepare("SELECT payload FROM events WHERE message_id=? AND kind='native_execution_failed' ORDER BY seq DESC LIMIT 1").get(row.id);
    return { schemaVersion: 1, messageId: row.id, requestId: row.request_id, teamId: row.team_id,
      source: { agent: JSON.parse(row.context).sourceAgent ?? "unspecified", declaredBySender: true },
      destination: { agent: "zcode", taskId: row.task_id }, createdAt: row.created_at,
      prompt: row.pruned_at ? null : row.prompt, context: row.pruned_at ? null : JSON.parse(row.context),
      state: row.state, ...this.blocking(row.id), nativeStatus: row.native_status, nativeMessageId: row.native_id, turnIndex: row.turn_index,
      retry: { count: row.retry_count, maxRetries: RATE_RETRY.maxRetries, nextAttemptAt: row.retry_at,
        remainingSeconds: row.state === "retry_wait" ? Math.max(0, Math.ceil((Math.max(row.retry_at, this.worker().rate_until) - Date.now()) / 1000)) : null },
      ...(failure ? { nativeExecutionFailure: JSON.parse(failure.payload) } : {}),
      consumedAt: row.consumed_at, bodyPruned: !!row.pruned_at,
      lastEvent: this.db.prepare("SELECT coalesce(max(seq),0) AS n FROM events WHERE message_id=?").get(row.id).n };
  }
  consume(messageId, throughEvent, consumerId) {
    return this.transaction(() => {
      const row = this.get(messageId);
      if (!row || !finished(row.state)) throw Error("Only a terminal message can be marked received");
      if (!Number.isSafeInteger(throughEvent) || throughEvent < 1) throw Error("A read lastEvent is required");
      if (!row.pruned_at && throughEvent !== this.envelope(row).lastEvent) throw Error("Receipt changed; read the complete result before confirming");
      const reader = this.db.prepare("SELECT * FROM readers WHERE message_id=? AND consumer_id=?").get(messageId, consumerId ?? "");
      if (!reader || reader.through_event !== throughEvent) throw Error("This consumer has not read the complete result; continue its inbox cursor first");
      this.db.prepare("UPDATE readers SET acknowledged_event=? WHERE message_id=? AND consumer_id=?").run(throughEvent, messageId, consumerId);
      const remaining = this.db.prepare("SELECT count(*) AS n FROM readers WHERE message_id=? AND acknowledged_event<>?").get(messageId, throughEvent).n;
      if (!remaining) this.db.prepare("UPDATE messages SET consumed_at=coalesce(consumed_at,?) WHERE id=?").run(Date.now(), messageId);
      return { messageId, consumerId, received: true, businessAccepted: false, eligibleForPruning: !remaining, pendingConsumers: remaining };
    });
  }
  event(row, kind, payload) {
    this.db.prepare("INSERT INTO events(message_id,task_id,team_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)")
      .run(row.id, row.task_id, row.team_id, kind, JSON.stringify(payload), Date.now());
  }
  get(id) { return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id); }
  blocking(id) {
    return this.db.prepare(`SELECT 'same_task_fifo' AS blockedReason, prior.id AS blockedByMessageId,
      prior.state AS blockedByState FROM messages current JOIN messages prior
      ON prior.task_id=current.task_id AND prior.seq<current.seq
      WHERE current.id=? AND current.state IN ('queued','retry_wait') AND prior.state NOT IN (${terminal})
      ORDER BY prior.seq LIMIT 1`).get(id) ?? { blockedReason: null, blockedByMessageId: null, blockedByState: null };
  }
  state(row, state) {
    this.db.prepare("UPDATE messages SET state=? WHERE id=?").run(state, row.id);
    this.event(row, "delivery", { state });
  }
  enqueue({ requestId, taskIds, prompt, teamId = null, context = {} }) {
    validateQueueArgs("zcode_queue_enqueue", { requestId, taskIds, prompt, ...(teamId === null ? {} : { teamId }), context });
    context = normalizeContext(context);
    const hash = fingerprint(taskIds, prompt, teamId, context);
    if (bytes(prompt) + bytes(context) > LIMITS.requestBytes) throw Error("Request exceeds 40000 UTF-8 bytes; provide a bounded summary and references");
    if (!this.db.prepare("SELECT 1 FROM messages WHERE request_id=?").get(requestId)) this.maintain(taskIds.length, taskIds.length * (bytes(prompt) + bytes(context) + 16000));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM messages WHERE request_id=? ORDER BY task_id").all(requestId);
      if (existing.length) {
        if (existing.length !== taskIds.length || existing.some(r => !taskIds.includes(r.task_id) || r.request_hash !== hash)) throw Error("requestId already exists with different content or recipients");
        return { deduplicated: true, messages: existing.map(r => ({ messageId: r.id, taskId: r.task_id, state: r.state, ...this.blocking(r.id) })) };
      }
      if (this.db.prepare(`SELECT count(*) AS n FROM messages WHERE state NOT IN (${terminal})`).get().n + taskIds.length > LIMITS.pending) throw Error("Queue full: resolve pending entries first (limit 100)");
      if (this.db.prepare("SELECT count(*) AS n FROM messages WHERE pruned_at IS NULL").get().n + taskIds.length > LIMITS.records || this.usedBytes() + taskIds.length * (bytes(prompt) + bytes(context) + 16000) > LIMITS.workingBytes) throw Error("Storage capacity reached; confirm received terminal results first. Nothing sent.");
      const messages = taskIds.map(taskId => {
        const id = randomUUID();
        this.db.prepare("INSERT INTO messages(id,request_id,task_id,team_id,prompt,context,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, requestId, taskId, teamId, prompt, JSON.stringify(context), hash, Date.now());
        this.event(this.get(id), "delivery", { state: "queued" });
        return { messageId: id, taskId, state: "queued", ...this.blocking(id) };
      });
      return { deduplicated: false, messages };
    });
  }
  heads() {
    return this.db.prepare(`SELECT * FROM messages WHERE seq IN
      (SELECT min(seq) FROM messages WHERE state NOT IN (${terminal}) GROUP BY task_id) ORDER BY seq`).all();
  }
  worker() { return this.db.prepare("SELECT * FROM worker WHERE id=1").get(); }
  acquire(reservation = process.env.ZCODE_OPS_WORKER_RESERVATION) {
    return this.transaction(() => {
      const old = this.worker();
      if (!old.desired || old.paused || (old.token && alive(old.pid))) return null;
      if (reservation ? reservation !== old.starting_token : startupLive(old)) return null;
      const token = randomUUID();
      this.db.prepare("UPDATE worker SET token=?,pid=?,heartbeat=?,error=NULL,starting_token=NULL,starting_pid=NULL,starting_at=NULL WHERE id=1").run(token, process.pid, Date.now());
      for (const row of this.db.prepare("SELECT * FROM messages WHERE state='dispatching'").all()) this.state(row, "uncertain");
      return token;
    });
  }
  running(token) { const w = this.worker(); return w.desired === 1 && w.token === token; }
  heartbeat(token, error = null) {
    this.db.prepare("UPDATE worker SET heartbeat=?,error=? WHERE id=1 AND token=?").run(Date.now(), error, token);
  }
  release(token) { this.db.prepare("UPDATE worker SET token=NULL,pid=NULL WHERE id=1 AND token=?").run(token); }
  continueOrRelease(token) {
    return this.transaction(() => {
      if (this.running(token) && this.heads().some(row => row.state !== "needs_attention")) return true;
      this.release(token); return false;
    });
  }
  remoteTicket() {
    return this.transaction(() => {
      this.cleanRemoteTickets();
      if (this.db.prepare("SELECT count(*) AS n FROM remote_requests").get().n >= 128) throw Error("Remote wait queue full; no remote action started");
      const token = randomUUID();
      this.db.prepare("INSERT INTO remote_requests(token,pid) VALUES(?,?)").run(token, process.pid);
      return token;
    });
  }
  cleanRemoteTickets() {
    for (const row of this.db.prepare("SELECT DISTINCT pid FROM remote_requests").all()) {
      if (!alive(row.pid)) this.db.prepare("DELETE FROM remote_requests WHERE pid=?").run(row.pid);
    }
  }
  remoteTurn(token) {
    return this.transaction(() => {
      this.cleanRemoteTickets();
      return this.db.prepare("SELECT token FROM remote_requests ORDER BY seq LIMIT 1").get()?.token === token;
    });
  }
  remoteDone(token) { this.transaction(() => this.db.prepare("DELETE FROM remote_requests WHERE token=?").run(token)); }
  ready(row, now = Date.now()) {
    const rateUntil = this.worker().rate_until;
    if (!["queued", "retry_wait"].includes(row.state) || now < rateUntil ||
        row.state === "retry_wait" && now < row.retry_at) return false;
    // Reserve recovery capacity for due retries, including heads outside this
    // tick's batch. claim() repeats this guard inside the ownership transaction.
    return row.state !== "queued" || rateUntil === 0 || !this.heads().some(head =>
      head.state === "retry_wait" && now >= head.retry_at && head.retry_count < RATE_RETRY.maxRetries);
  }
  claim(row, token, cursor) {
    return this.transaction(() => {
      row = this.get(row.id);
      if (!this.running(token) || !this.ready(row) || !this.heads().some(r => r.id === row.id)) return false;
      if (row.state === "retry_wait") {
        if (row.retry_count >= RATE_RETRY.maxRetries) return false;
        this.db.prepare("UPDATE messages SET retry_count=retry_count+1,retry_at=NULL,native_id=NULL,turn_index=NULL,reply_seen=0 WHERE id=?").run(row.id);
        this.event(row, "rate_limit_retry_started", { attempt: row.retry_count + 1 });
      }
      // ponytail: queue-wide cooldown; split by account only when reliable quota identity exists.
      if (this.worker().rate_until) this.db.prepare("UPDATE worker SET rate_until=?,rate_probe=? WHERE id=1").run(Date.now() + RATE_RETRY.delayMs, row.id);
      this.db.prepare("UPDATE messages SET cursor=? WHERE id=?").run(cursor, row.id);
      this.state(row, "dispatching"); return true;
    });
  }
  observe(row, page) {
    const incoming = bytes(page.messages) + 32000;
    this.maintain(0, incoming);
    this.transaction(() => {
      row = this.get(row.id);
      if (!["acknowledged", "uncertain", "retry_wait"].includes(row.state)) return;
      const retrying = row.state === "retry_wait";
      if (this.usedBytes() + incoming > LIMITS.workingBytes) {
        this.db.exec("UPDATE worker SET desired=0,paused=1,control_revision=control_revision+1,error='storage_capacity_reached' WHERE id=1");
        return; // Keep the old cursor: no lost result, no completion, no resend.
      }
      if (page.historyGap) { this.state(row, "needs_attention"); this.event(row, "history_gap", {}); return; }
      let nativeId = row.native_id, turn = row.turn_index, reply = row.reply_seen;
      let competing = false;
      for (const m of page.messages) {
        if (m.role === "user" && m.contentOffset === 0 && m.content.startsWith(marker(row.id) + "\n")) {
          if (nativeId && nativeId !== m.id) competing = true;
          nativeId = m.id; turn = m.turnIndex;
        } else if (nativeId && m.role === "user" && m.id !== nativeId) competing = true;
        if (nativeId && Number.isInteger(turn) && m.role === "assistant" && m.turnIndex === turn && m.content.length) reply = 1;
        this.event(row, "message", m); // Preserve roles/offsets; never execute returned text.
      }
      if (row.native_status !== page.task.status) this.event(row, "native_status", { status: page.task.status });
      this.db.prepare("UPDATE messages SET cursor=?,native_id=?,turn_index=?,reply_seen=?,native_status=? WHERE id=?")
        .run(page.cursor, nativeId, turn, reply, page.task.status, row.id);
      if (retrying && competing) {
        this.db.prepare("UPDATE messages SET retry_at=NULL WHERE id=?").run(row.id);
        this.state(row, "released");
        this.event(row, "retry_stopped", { reason: "superseded_by_external_input", businessAccepted: false });
        return;
      }
      // Re-reading the same failed attempt must not restart its timer or spend a retry.
      if (retrying && !page.task.archived && !page.observedLatestTask && page.task.status === "failed" &&
          page.task.nativeExecutionFailure?.reason === "rate_limited") return;
      if (retrying) {
        this.db.prepare("UPDATE messages SET retry_at=NULL WHERE id=?").run(row.id);
        this.state(row, "acknowledged"); // Resume reply collection, not sending, when the native turn resumes.
      }
      if (!page.hasMore && !competing && nativeId && page.task.status === "failed") this.event(row, "native_execution_failed", {
        ...(page.task.nativeExecutionFailure ?? { stage: "native_execution", source: "zcode_native", reason: "unknown" }),
        userMessageObserved: true, assistantTextReturned: !!reply
      });
      if (!page.hasMore && !competing && nativeId && !page.task.archived && !page.observedLatestTask &&
          page.task.status === "failed" && page.task.nativeExecutionFailure?.reason === "rate_limited") {
        const retryAt = Date.now() + RATE_RETRY.delayMs;
        this.db.prepare("UPDATE worker SET rate_until=max(rate_until,?),rate_probe=NULL WHERE id=1").run(retryAt);
        if (row.retry_count < RATE_RETRY.maxRetries) {
          this.db.prepare("UPDATE messages SET retry_at=? WHERE id=?").run(retryAt, row.id);
          this.state(row, "retry_wait");
          this.event(row, "rate_limit_retry_scheduled", { attempt: row.retry_count + 1, nextAttemptAt: retryAt });
        } else {
          this.state(row, "needs_attention");
          this.event(row, "temporarily_blocked", { reason: "rate_limit_retries_exhausted", retries: row.retry_count,
            message: "本任务暂时堵塞：已重试 5 次，仍受限流影响。" });
        }
        return;
      }
      if (competing || page.task.archived || ["cancelled", "interrupted"].includes(page.task.status) ||
          !page.hasMore && page.task.status === "failed") this.state(row, "needs_attention");
      else if (page.completionConfirmed === true && !page.hasMore && nativeId && page.task.status === "completed" &&
        !page.pendingPermissions && !page.pendingQuestions && !page.pendingCommands) {
        if (reply) {
          this.state(row, "completed");
          const probe = this.worker().rate_probe;
          if (probe && this.get(probe)?.state === "completed" && !this.db.prepare("SELECT 1 FROM messages WHERE state='retry_wait' OR (retry_count>0 AND state IN ('dispatching','acknowledged','uncertain')) LIMIT 1").get())
            this.db.exec("UPDATE worker SET rate_until=0,rate_probe=NULL WHERE id=1");
        } else if (Number.isInteger(turn) && page.tailMessage?.role === "assistant" &&
            page.tailMessage.turnIndex === turn && page.tailMessage.totalCharacters === 0) {
          // The cursor may already be past this empty tail. Native completion is
          // not a successful reply and must not silently release old followers.
          this.state(row, "needs_attention");
          this.event(row, "native_execution_failed", { stage: "native_execution", source: "zcode_native",
            reason: "empty_response", userMessageObserved: true, assistantTextReturned: false });
        }
      }
    });
  }
  resolve({ messageId, decision }) {
    return this.transaction(() => {
      const row = this.get(messageId);
      if (!row) throw Error("Unknown messageId");
      if (decision === "cancel" && row.state !== "queued") throw Error("Only unsent queued messages can be cancelled; this does not stop ZCode");
      if (decision === "release" && !["uncertain", "needs_attention", "acknowledged", "retry_wait"].includes(row.state)) throw Error("Only an observed or uncertain delivery can be manually released");
      this.state(row, decision === "cancel" ? "cancelled" : "released");
      this.db.prepare("UPDATE messages SET retry_at=NULL WHERE id=?").run(row.id);
      return { messageId, state: this.get(messageId).state, remoteStopped: false };
    });
  }
  read({ taskId = null, taskIds = null, teamId = null, consumerId = null, after = 0, limit = 50 } = {}) {
    // A short transaction keeps events, envelopes, reader progress and pruning consistent.
    return this.transaction(() => {
    const targets = taskIds || (taskId ? [taskId] : null);
    const selected = targets ? JSON.stringify(targets) : null;
    const rows = this.db.prepare(`SELECT * FROM events WHERE seq>? AND (? IS NULL OR task_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR team_id=?) ORDER BY seq LIMIT ?`).all(after, selected, selected, teamId, teamId, limit + 1);
    const events = [], envelopes = []; let size = 0;
    const included = new Set();
    for (const row of rows.slice(0, limit)) {
      const event = { cursor: row.seq, messageId: row.message_id, taskId: row.task_id, teamId: row.team_id,
        kind: row.kind, payload: JSON.parse(row.payload), at: row.created_at };
      const envelope = included.has(row.message_id) ? null : this.envelope(this.get(row.message_id));
      const length = bytes(event) + (envelope ? bytes(envelope) : 0);
      if (events.length && size + length > 64000) break;
      size += length; events.push(event);
      if (envelope) { included.add(row.message_id); envelopes.push(envelope); }
    }
    if (consumerId) for (const envelope of envelopes) {
      let reader = this.db.prepare("SELECT * FROM readers WHERE message_id=? AND consumer_id=?").get(envelope.messageId, consumerId);
      if (!reader) {
        if (this.db.prepare("SELECT count(*) AS n FROM readers WHERE message_id=?").get(envelope.messageId).n >= LIMITS.readers) throw Error("Message reader limit reached (16); reuse your stable consumerId");
        if (this.usedBytes() + 4096 > LIMITS.workingBytes) throw Error("Storage capacity reached; cannot register another reader. Existing readers can continue and confirm.");
        this.db.prepare("INSERT INTO readers(message_id,consumer_id) VALUES(?,?)").run(envelope.messageId, consumerId);
        this.db.prepare("UPDATE messages SET consumed_at=NULL WHERE id=?").run(envelope.messageId);
        reader = { through_event: 0, acknowledged_event: 0 };
        envelope.consumedAt = null;
      }
      // A guessed/skipped cursor cannot certify earlier, undispatched events as read.
      const gap = this.db.prepare("SELECT 1 FROM events WHERE message_id=? AND seq>? AND seq<=? LIMIT 1").get(envelope.messageId, reader.through_event, after);
      if (!gap) {
        reader.through_event = Math.max(reader.through_event, ...events.filter(e => e.messageId === envelope.messageId).map(e => e.cursor));
        this.db.prepare("UPDATE readers SET through_event=? WHERE message_id=? AND consumer_id=?").run(reader.through_event, envelope.messageId, consumerId);
      }
      envelope.receipt = { consumerId, throughEvent: reader.through_event,
        complete: finished(envelope.state) && reader.through_event === envelope.lastEvent,
        acknowledged: reader.acknowledged_event === envelope.lastEvent };
    }
    const messages = this.db.prepare(`SELECT id AS messageId,task_id AS taskId,team_id AS teamId,state,native_status AS nativeStatus,
      consumed_at AS consumedAt,pruned_at AS bodyPrunedAt
      FROM messages WHERE (? IS NULL OR task_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR team_id=?) ORDER BY state IN (${terminal}),seq DESC LIMIT 100`).all(selected, selected, teamId, teamId)
      .map(row => ({ ...row, ...this.blocking(row.messageId) }));
    const w = this.worker(), retention = this.db.prepare("SELECT * FROM retention WHERE id=1").get();
    return { events, envelopes, cursor: events.at(-1)?.cursor ?? after, hasMore: rows.length > events.length, messages,
      historyGap: after > 0 && after < retention.through_event,
      retention: { throughEvent: retention.through_event, prunedCount: retention.pruned_count, dedupDays: LIMITS.dedupDays },
      storage: { diskBytes: diskSize(this.path), maxDiskBytes: LIMITS.diskBytes, databaseLimitBytes: LIMITS.databaseBytes,
        maxRecords: LIMITS.records, fullRecords: this.db.prepare("SELECT count(*) AS n FROM messages WHERE pruned_at IS NULL").get().n },
      worker: { requested: !!w.desired, paused: !!w.paused, running: !!w.token && alive(w.pid), starting: !!startupLive(w),
        controlRevision: w.control_revision, heartbeat: w.heartbeat, error: w.error,
        rateLimit: { scope: "queue", nextSendAt: w.rate_until || null, recoverySpacingMs: RATE_RETRY.delayMs } } };
    });
  }
}

const text = { type: "string", minLength: 1, maxLength: 128 };
export const queueTools = [
  ["zcode_queue_enqueue", "Durably queue a user-authorized prompt for 1-8 explicit existing task IDs. Same-task FIFO, optional team inbox label; no implicit broadcast. Stable requestId deduplicates retries. Does not send until queue_control start. Adds a message-ID prefix for reply correlation.", {
    requestId: text, taskIds: { type: "array", items: text, minItems: 1, maxItems: 8, uniqueItems: true }, prompt: { ...text, maxLength: 31000 }, teamId: text, context: contextSchema
  }, ["requestId", "taskIds", "prompt"], false],
  ["zcode_queue_read", "Read persisted task/team events and queue-worker status; no network, no wakeup, no acknowledgement of consumption. Pass returned cursor as after with the same filter. Completed is native turn completion, not business acceptance.", {
    taskId: text, taskIds: { type: "array", items: text, minItems: 1, maxItems: 8, uniqueItems: true }, teamId: text, consumerId: text, after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 100 }
  }, [], true],
  ["zcode_queue_control", "Explicitly start or gracefully stop the single background queue worker. Start dispatches queued authorized prompts and collects their replies without model polling; it does not wake Codex or start on app launch. Stop preserves queued data and allows an in-flight request to settle.", {
    action: { type: "string", enum: ["start", "stop"] }, scope: { type: "string", enum: ["all"] }, expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }, ["action", "scope", "expectedRevision"], false],
  ["zcode_queue_resolve", "Cancel an unsent queued message, or explicitly release an acknowledged/uncertain/needs_attention head after user review. Release permits later messages to send, but does not prove completion, retry delivery, or stop ZCode.", {
    messageId: text, decision: { type: "string", enum: ["cancel", "release", "received"] }, consumerId: text, throughEvent: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
  }, ["messageId", "decision"], false]
].map(([name, description, properties, required, readOnlyHint]) => ({ name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false } }));

export function validateQueueArgs(name, args) {
  const schema = queueTools.find(t => t.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid queue arguments");
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const r = schema.properties[key];
    if (!r || r.enum && !r.enum.includes(value) || r.type === "string" && (typeof value !== "string" || !value.trim() || value.length > (r.maxLength ?? 128)) ||
      r.type === "integer" && (!Number.isSafeInteger(value) || value < r.minimum || value > r.maximum) ||
      r.type === "array" && (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length || value.some(v => typeof v !== "string" || v.length > 128 || !/^sess_[a-zA-Z0-9-]+$/.test(v)))) throw Error(`Invalid ${key}`);
  }
  if (args.taskId && !/^sess_[a-zA-Z0-9-]+$/.test(args.taskId)) throw Error("Invalid taskId");
  if (args.taskId && args.taskIds) throw Error("Choose taskId or taskIds, not both");
  if (Object.hasOwn(args, "context")) normalizeContext(args.context);
  if (args.decision === "received" ? !args.throughEvent || !args.consumerId : args.throughEvent !== undefined || name === "zcode_queue_resolve" && args.consumerId !== undefined) throw Error("throughEvent and consumerId are required only for received confirmation");
}

async function launchWorker(reservation) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./queue-worker.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ZCODE_OPS_CONFIG: configPath(), ZCODE_OPS_WORKER_RESERVATION: reservation }
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child.pid;
}

export async function startWorker(queue, { resume = false, expectedRevision, launch = launchWorker } = {}) {
  const reservation = queue.transaction(() => {
    if (resume) {
      if (queue.worker().control_revision !== expectedRevision) throw Error("Queue control changed; read worker.controlRevision before controlling all teams");
      queue.db.exec("UPDATE worker SET paused=0,control_revision=control_revision+1 WHERE id=1");
    }
    if (queue.worker().paused) return false;
    queue.db.exec("UPDATE worker SET desired=1 WHERE id=1");
    const w = queue.worker();
    if (w.token && alive(w.pid) || startupLive(w)) return null;
    const token = randomUUID();
    queue.db.prepare("UPDATE worker SET starting_token=?,starting_pid=?,starting_at=? WHERE id=1").run(token, process.pid, Date.now());
    return token;
  });
  if (reservation) {
    try {
      const pid = await launch(reservation);
      if (Number.isInteger(pid)) queue.transaction(() => queue.db.prepare("UPDATE worker SET starting_pid=? WHERE id=1 AND starting_token=?").run(pid, reservation));
    } catch (error) {
      queue.transaction(() => queue.db.prepare("UPDATE worker SET starting_token=NULL,starting_pid=NULL,starting_at=NULL,error='worker_start_failed' WHERE id=1 AND starting_token=?").run(reservation));
      throw error;
    }
  }
  return queue.read({ limit: 1 }).worker;
}

export async function retireWorker(queue, token, options) {
  const restart = queue.transaction(() => {
    queue.release(token);
    const w = queue.worker();
    return w.desired && !w.paused && queue.heads().some(row => row.state !== "needs_attention");
  });
  // A resume arriving during exit either sees the old owner here, or starts its own reserved replacement.
  if (restart) await startWorker(queue, options);
}

export async function callQueueTool(name, args = {}, { launch } = {}) {
  validateQueueArgs(name === "zcode_queue_send" ? "zcode_queue_enqueue" : name, args);
  const queue = new MessageQueue();
  try {
    if (name === "zcode_queue_enqueue") return queue.enqueue(args);
    if (name === "zcode_queue_send") {
      const receipt = queue.enqueue(args);
      try {
        const pending = receipt.messages.some(m => !["completed", "released", "cancelled"].includes(m.state));
        return { ...receipt, worker: pending ? await startWorker(queue, { launch }) : queue.read({ limit: 1 }).worker };
      } catch { return { ...receipt, worker: queue.read({ limit: 1 }).worker, startupError: "Message saved; worker did not start. Resume explicitly, do not resend with a new requestId." }; }
    }
    if (name === "zcode_queue_read") return queue.read(args);
    if (name === "zcode_queue_resolve") {
      if (args.decision !== "received") {
        const receipt = queue.resolve(args);
        if (queue.worker().desired && !queue.worker().paused && queue.heads().some(row => row.state !== "needs_attention")) {
          try { receipt.worker = await startWorker(queue, { launch }); }
          catch { receipt.worker = queue.read({ limit: 1 }).worker; receipt.startupError = "Queue item resolved; worker did not start. Resume explicitly; do not resend."; }
        }
        return receipt;
      }
      const receipt = queue.consume(args.messageId, args.throughEvent, args.consumerId);
      return { ...receipt, prunedRecords: queue.maintain() };
    }
    if (args.action === "start") await startWorker(queue, { resume: true, expectedRevision: args.expectedRevision, launch });
    else queue.transaction(() => {
      if (queue.worker().control_revision !== args.expectedRevision) throw Error("Queue control changed; read worker.controlRevision before controlling all teams");
      queue.db.exec("UPDATE worker SET desired=0,paused=1,control_revision=control_revision+1,starting_token=NULL,starting_pid=NULL,starting_at=NULL WHERE id=1");
    });
    return { action: args.action, ...queue.read({ limit: 1 }).worker };
  } finally { queue.close(); }
}
