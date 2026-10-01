import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.mjs";
import { budgetSourceError, queueBudgetContext } from "./queue-budget.mjs";

export const queuePath = () => join(dirname(configPath()), "messages.sqlite");
export const QUEUE_SCHEMA_VERSION = 9;
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const terminal = "'completed','released','cancelled'";
const futureMessageBytes = 16000;
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
const contextFields = ["sourceAgent", "sourceTaskId", "sourceWorkspace", "replyTo", "goal", "background", "constraints", "expectedReply", "instanceId", "writeRoot"];
export const contextSchema = { type: "object", additionalProperties: false, properties: {
  ...Object.fromEntries(contextFields.map(key => [key, { type: "string", minLength: 1, maxLength: 2048 }])),
  references: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 2048 } }
} };
export const workspaceSchema = { type: "object", additionalProperties: false, properties: {
  path: { type: "string", minLength: 1, maxLength: 32768 }, identity: { type: "string", minLength: 1, maxLength: 32768 }
}, required: ["path"] };
export function normalizeWorkspace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(workspaceSchema.properties, key))) throw Error("Invalid workspace");
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const identity = typeof value.identity === "string" ? value.identity.trim() : "";
  if (!path || path.length > 32768 || /[\x00-\x1f]/.test(path) || value.identity !== undefined && (!identity || identity.length > 32768 || /[\x00-\x1f]/.test(identity))) throw Error("Invalid workspace");
  return { path, ...(identity ? { identity } : {}) };
}
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
const fingerprint = (target, prompt, teamId, context) => createHash("sha256")
  .update(JSON.stringify([target, prompt, teamId, context])).digest("hex");
export function assignmentOf(prompt, context = {}) {
  const values = { instanceId: [], writeRoot: [] };
  for (const key of Object.keys(values)) if (context[key] !== undefined) values[key].push(context[key]);
  // Only the task's identity, not predecessor objects or pairedPrimaryInstanceId.
  const identities = [...prompt.matchAll(/\bidentity["'`]?\s*[:=]\s*\{[^{}]*\}/g)];
  if (identities.length !== [...prompt.matchAll(/\bidentity["'`]?\s*[:=]\s*\{/g)].length)
    throw Error("Use a flat identity declaration or context.instanceId");
  const owned = match => match[1] === "writeRoot" || identities.some(block => match.index >= block.index && match.index < block.index + block[0].length) ||
    /identity\s*\.\s*$/.test(prompt.slice(0, match.index)) ||
    /^["'`]?instanceId["'`]?\s*=/.test(match[0]) && /(?:^|\n)[ \t]*$/.test(prompt.slice(0, match.index));
  const declarations = /(?<![\w])["'`]?(instanceId|writeRoot)["'`]?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[^\s,;}\]。；，"'`]+)/g;
  const matches = [...prompt.matchAll(declarations)].filter(owned);
  if (matches.length !== [...prompt.matchAll(/(?<![\w])["'`]?(instanceId|writeRoot)["'`]?\s*[:=]/g)].filter(owned).length)
    throw Error("Invalid instanceId/writeRoot declaration; use context fields or quoted values");
  for (const match of matches) {
    let value = match[2];
    if (/^["'`]/.test(value)) {
      if (value[0] === '"') { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
      else value = value.slice(1, -1);
    } else if (/^[ \t]+[^\s,;}\]。；，]/.test(prompt.slice(match.index + match[0].length)))
      throw Error("Quote instanceId/writeRoot declarations containing spaces");
    values[match[1]].push(value);
  }
  const result = {};
  for (const [key, entries] of Object.entries(values)) for (let value of entries) {
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\x00-\x1f]/.test(value)) throw Error(`Invalid ${key} declaration`);
    value = value.trim();
    if (key === "writeRoot") {
      value = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
      if (/^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)) {
        value = win32.normalize(value).toLowerCase();
        if (value.split("\\").some(part => part && /[. ]$/.test(part))) throw Error("Ambiguous Windows writeRoot; use a canonical absolute path");
        if (value !== win32.parse(value).root) value = value.replace(/\\$/, "");
      } else if (value.startsWith("/")) value = posix.normalize(value).replace(/\/$/, "") || "/";
      else throw Error("writeRoot must be an absolute path");
    }
    if (result[key] !== undefined && result[key] !== value) throw Error(`Conflicting ${key} declarations`);
    result[key] = value;
  }
  return result;
}
const diskSize = path => ["", "-journal", "-wal", "-shm"].reduce((sum, suffix) => {
  try { return sum + statSync(path + suffix).size; } catch (e) { if (e.code === "ENOENT") return sum; throw e; }
}, 0);
const normalizedQueuePath = path => {
  path = path.replaceAll("\\", "/").toLowerCase();
  if (path.startsWith("//?/unc/")) return `//${path.slice(8)}`;
  return path.startsWith("//?/") ? path.slice(4) : path;
};
function canonicalPath(path) {
  let current = resolve(path), missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw Error("Cannot resolve ZCode queue path identity");
    missing.unshift(basename(current)); current = parent;
  }
  return join(realpathSync.native(current), ...missing);
}
export const queueOwnerId = (path = queuePath()) => `zcode-queue:${createHash("sha256")
  .update(normalizedQueuePath(canonicalPath(path))).digest("hex").slice(0, 32)}`;
export const managedQueueBytes = path => diskSize(canonicalPath(path));
const budgetError = result => Object.assign(Error(`ZCode message budget blocked: ${result.reason ?? "budget_conflict"} (${result.deltaBytes ?? 0} bytes)`), {
  code: "ZCODE_BUDGET_BLOCKED", budget: result
});
function checkBudget(path, context, db, additionalBytes = 0, peak = false, futureBytes = 0) {
  if (!context) return null;
  context.assertCurrent?.();
  const ownerId = queueOwnerId(path), status = context.messageBudget?.status?.();
  if (!status) throw budgetError({ ok: false, ownerId, reason: "budget_not_configured", deltaBytes: additionalBytes + futureBytes });
  if (peak) {
    const size = existsSync(path) ? statSync(path).size : 0;
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const pages = Math.max(db.prepare("PRAGMA page_count").get().page_count,
      Math.ceil((size + additionalBytes + futureBytes) / pageSize));
    // DELETE journal + no cache spill: reserve projected main pages, one full-copy journal and sector padding.
    // ponytail: conservative peak reservation avoids a second quota ledger; revisit only if measured capacity is too low.
    additionalBytes = pages * pageSize - size + pages * (pageSize + 8) + 2 * 65536;
  } else additionalBytes += futureBytes;
  const result = context.messageBudget?.check?.({ ownerId, usedBytes: managedQueueBytes(path), additionalBytes });
  if (!result?.ok) throw budgetError(result ?? { ok: false, ownerId, reason: "budget_check_unavailable", deltaBytes: additionalBytes });
  return result;
}
function durableFutureBytes(db, additionalMessages = 0, requestId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) return 0;
  if (requestId && db.prepare("SELECT 1 FROM messages WHERE request_id=?").get(requestId)) additionalMessages = 0;
  return (db.prepare(`SELECT count(*) AS n FROM messages WHERE state NOT IN (${terminal})`).get().n + additionalMessages) * futureMessageBytes;
}

// ponytail: one local SQLite journal, not a distributed broker. Split hosts only when needed.
export class MessageQueue {
  constructor(path = queuePath(), coreContext = null, initialAdditionalBytes = 0) {
    this.path = canonicalPath(path);
    this.coreContext = coreContext?.registrationKey
      ? { ...coreContext, ...queueBudgetContext(coreContext.registrationKey) } : coreContext;
    checkBudget(this.path, this.coreContext, null, initialAdditionalBytes);
    path = this.path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
    // Set the busy handler BEFORE the first read, including a cold concurrent open.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > QUEUE_SCHEMA_VERSION) throw Error("Queue schema is newer than this plugin");
    const ownerColumns = this.db.prepare("PRAGMA table_info(queue_owner)").all();
    const savedSource = ownerColumns.some(column => column.name === "budget_registration_key")
      ? this.db.prepare("SELECT budget_registration_key FROM queue_owner WHERE id=1").get()?.budget_registration_key : null;
    if (savedSource && !this.coreContext?.registrationKey)
      this.coreContext = { ...this.coreContext, ...queueBudgetContext(savedSource) };
    checkBudget(this.path, this.coreContext, this.db, initialAdditionalBytes);
    if (version < QUEUE_SCHEMA_VERSION && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='worker'").get()) {
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
      if (this.db.prepare("PRAGMA user_version").get().user_version >= 5) return;
      const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(c => c.name));
      for (const [name, type] of Object.entries({ retry_count: "INTEGER NOT NULL DEFAULT 0", retry_at: "INTEGER" })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      if (!this.db.prepare("PRAGMA table_info(worker)").all().some(c => c.name === "rate_until"))
        this.db.exec("ALTER TABLE worker ADD COLUMN rate_until INTEGER NOT NULL DEFAULT 0; ALTER TABLE worker ADD COLUMN rate_probe TEXT");
      this.db.exec("PRAGMA user_version=5");
    });
    if (version < 6) this.transaction(() => {
      if (this.db.prepare("PRAGMA user_version").get().user_version >= 6) return;
      if (!this.db.prepare("PRAGMA table_info(messages)").all().some(c => c.name === "assignment"))
        this.db.exec("ALTER TABLE messages ADD COLUMN assignment TEXT NOT NULL DEFAULT '{}'");
      for (const row of this.db.prepare("SELECT id,prompt,context FROM messages WHERE assignment='{}' AND pruned_at IS NULL").all()) {
        let assignment;
        try { assignment = assignmentOf(row.prompt, JSON.parse(row.context)); }
        catch { assignment = { error: "Saved instanceId/writeRoot declarations could not be parsed" }; }
        this.db.prepare("UPDATE messages SET assignment=? WHERE id=?").run(JSON.stringify(assignment), row.id);
      }
      this.db.exec("PRAGMA user_version=6");
    });
    if (version < 7) this.transaction(() => {
      if (this.db.prepare("PRAGMA user_version").get().user_version >= 7) return;
      this.db.exec(`CREATE TABLE IF NOT EXISTS queue_owner (
        id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, queue_path TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      const ownerId = queueOwnerId(path), identity = normalizedQueuePath(path);
      const owner = this.db.prepare("SELECT owner_id,queue_path FROM queue_owner WHERE id=1").get();
      if (owner && (owner.owner_id !== ownerId || owner.queue_path !== identity)) throw Error("ZCode queue owner identity changed");
      if (!owner) this.db.prepare("INSERT INTO queue_owner(id,owner_id,queue_path,created_at) VALUES(1,?,?,?)").run(ownerId, identity, Date.now());
      this.db.exec("PRAGMA user_version=7");
    });
    if (version < 8) this.transaction(() => {
      if (this.db.prepare("PRAGMA user_version").get().user_version >= 8) return;
      const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(c => c.name));
      for (const [name, type] of Object.entries({ target_kind: "TEXT NOT NULL DEFAULT 'task'", target_address: "TEXT",
        workspace_path: "TEXT", workspace_identity: "TEXT", create_state: "TEXT", created_task_id: "TEXT",
        send_trace_id: "TEXT", send_query_id: "TEXT", send_message_id: "TEXT" })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      this.db.exec("PRAGMA user_version=8");
    });
    if (version < 9) this.transaction(() => {
      if (this.db.prepare("PRAGMA user_version").get().user_version >= 9) return;
      if (!this.db.prepare("PRAGMA table_info(queue_owner)").all().some(column => column.name === "budget_registration_key"))
        this.db.exec("ALTER TABLE queue_owner ADD COLUMN budget_registration_key TEXT");
      this.db.exec("PRAGMA user_version=9");
    });
    const owner = this.db.prepare("SELECT owner_id,queue_path FROM queue_owner WHERE id=1").get();
    if (!owner || owner.owner_id !== queueOwnerId(path) || owner.queue_path !== normalizedQueuePath(path)) throw Error("ZCode queue owner identity changed");
    this.ownerId = owner.owner_id;
    if (this.coreContext?.registrationKey && savedSource !== this.coreContext.registrationKey)
      this.transaction(() => this.db.prepare("UPDATE queue_owner SET budget_registration_key=? WHERE id=1")
        .run(this.coreContext.registrationKey));
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  transaction(fn, additionalBytes = 0, { additionalMessages = 0, requestId } = {}) {
    // Only local, fully rolled-back transactions are retried; never remote actions.
    return retryBusy(() => {
      const pendingBytes = () => requestId && this.db.prepare("SELECT 1 FROM messages WHERE request_id=?").get(requestId) ? 0 : additionalBytes;
      checkBudget(this.path, this.coreContext, this.db, pendingBytes(), true,
        durableFutureBytes(this.db, additionalMessages, requestId));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        checkBudget(this.path, this.coreContext, this.db, pendingBytes(), true,
          durableFutureBytes(this.db, additionalMessages, requestId));
        const result = fn();
        checkBudget(this.path, this.coreContext, this.db, 0, true, durableFutureBytes(this.db));
        this.db.exec("COMMIT"); return result;
      }
      catch (e) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw e; }
    });
  }
  usedBytes() { return (this.db.prepare("PRAGMA page_count").get().page_count - this.db.prepare("PRAGMA freelist_count").get().freelist_count) * this.pageSize; }
  maintain(extraRecords = 0, extraBytes = 0, budgetAdditionalBytes = extraBytes) {
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
    }, budgetAdditionalBytes);
  }
  summary(row) {
    const common = { messageId: row.id, deliveryId: row.id, ownerId: this.ownerId, correlation: row.request_id, state: row.state,
      ...this.blocking(row.id) };
    return row.target_kind === "workspace" ? { ...common, targetAddress: row.target_address,
      workspace: { path: row.workspace_path, ...(row.workspace_identity ? { identity: row.workspace_identity } : {}) },
      createState: row.create_state, createdTaskId: row.created_task_id } : { ...common, taskId: row.task_id };
  }
  envelope(row) {
    const failure = this.db.prepare("SELECT payload FROM events WHERE message_id=? AND kind='native_execution_failed' ORDER BY seq DESC LIMIT 1").get(row.id);
    const destination = row.target_kind === "workspace" ? { agent: "zcode", target: { kind: "workspace_create", address: row.target_address },
      workspace: { path: row.workspace_path, ...(row.workspace_identity ? { identity: row.workspace_identity } : {}) },
      ...(row.created_task_id ? { createdTaskId: row.created_task_id } : {}) } : { agent: "zcode", taskId: row.task_id };
    return { schemaVersion: 1, messageId: row.id, requestId: row.request_id, teamId: row.team_id,
      source: { agent: JSON.parse(row.context).sourceAgent ?? "unspecified", declaredBySender: true },
      destination, createdAt: row.created_at,
      prompt: row.pruned_at ? null : row.prompt, context: row.pruned_at ? null : JSON.parse(row.context), assignment: JSON.parse(row.assignment),
      state: row.state, ...this.blocking(row.id), createState: row.create_state, createdTaskId: row.created_task_id,
      nativeStatus: row.native_status, nativeMessageId: row.native_id, turnIndex: row.turn_index,
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
  assignmentConflict(assignment, id = "") {
    if (assignment.error) return { reason: "invalid_assignment_declaration", detail: assignment.error };
    if (!assignment.instanceId && !assignment.writeRoot) return null;
    // ponytail: scan the bounded retained queue; index JSON fields if this becomes measurable.
    const prior = this.db.prepare(`SELECT id,task_id,target_kind,target_address,created_task_id,state,assignment FROM messages WHERE id<>? AND
      (json_extract(assignment,'$.instanceId')=? OR json_extract(assignment,'$.writeRoot')=?) ORDER BY seq LIMIT 1`)
      .get(id, assignment.instanceId ?? null, assignment.writeRoot ?? null);
    if (!prior) return null;
    const saved = JSON.parse(prior.assignment);
    return { reason: "duplicate_assignment", conflictingMessageId: prior.id,
      ...(prior.target_kind === "workspace" ? { conflictingTargetAddress: prior.target_address,
        conflictingTaskId: prior.created_task_id } : { conflictingTaskId: prior.task_id }), conflictingState: prior.state,
      fields: ["instanceId", "writeRoot"].filter(key => assignment[key] && assignment[key] === saved[key]) };
  }
  admitAssignment(assignment, taskIds) {
    if (Object.keys(assignment).length && taskIds.length !== 1) throw Error("An instanceId/writeRoot assignment requires exactly one task; use distinct assignments for parallel tasks");
    const conflict = this.assignmentConflict(assignment);
    if (conflict) throw Error(`DUPLICATE_ASSIGNMENT: ${conflict.fields.join("/")} already admitted by ${conflict.conflictingMessageId}; use a new instanceId and writeRoot. Nothing queued.`);
  }
  blocking(id) {
    if (this.get(id)?.state === "needs_attention") {
      const blocked = this.db.prepare("SELECT payload FROM events WHERE message_id=? AND kind='assignment_blocked' ORDER BY seq DESC LIMIT 1").get(id);
      if (blocked) {
        const reason = JSON.parse(blocked.payload);
        return { blockedReason: reason.reason, blockedByMessageId: reason.conflictingMessageId ?? null, blockedByState: reason.conflictingState ?? null };
      }
      const creation = this.db.prepare("SELECT kind FROM events WHERE message_id=? AND kind IN ('task_creation_unknown','task_creation_failed') ORDER BY seq DESC LIMIT 1").get(id);
      if (creation) return { blockedReason: creation.kind === "task_creation_unknown" ? "create_unknown" : "create_failed",
        blockedByMessageId: null, blockedByState: null };
    }
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
  claimCreate(row, token) {
    return this.transaction(() => {
      row = this.get(row.id);
      if (!this.running(token) || !this.ready(row) || row.target_kind !== "workspace" || row.created_task_id ||
          !this.heads().some(head => head.id === row.id)) return false;
      const conflict = this.assignmentConflict(JSON.parse(row.assignment), row.id);
      if (conflict) { this.state(row, "needs_attention"); this.event(row, "assignment_blocked", conflict); return false; }
      this.db.prepare("UPDATE messages SET create_state='started',state='dispatching' WHERE id=?").run(row.id);
      const started = this.get(row.id);
      this.event(started, "task_creation_started", { workspace: { path: started.workspace_path,
        ...(started.workspace_identity ? { identity: started.workspace_identity } : {}) } });
      this.event(started, "delivery", { state: "dispatching" });
      return true;
    });
  }
  bindCreatedTask(row, taskId) {
    return this.transaction(() => {
      row = this.get(row.id);
      if (row.target_kind !== "workspace" || row.create_state !== "started" || row.state !== "dispatching" || row.created_task_id) throw Error("Create result cannot be bound to this queue row");
      if (!/^sess_[a-zA-Z0-9-]+$/.test(taskId)) throw Error("Invalid created task ID");
      const priorTaskId = row.task_id;
      this.db.prepare("UPDATE messages SET task_id=?,created_task_id=?,create_state='created',state='queued' WHERE id=?").run(taskId, taskId, row.id);
      this.db.prepare("UPDATE events SET task_id=? WHERE message_id=? AND task_id=?").run(taskId, row.id, priorTaskId);
      const bound = this.get(row.id);
      this.event(bound, "task_created", { createdTaskId: taskId });
      this.event(bound, "delivery", { state: "queued" });
      return bound;
    });
  }
  failCreate(row, explicit = false) {
    const apply = () => {
      row = this.get(row.id);
      if (row.target_kind !== "workspace" || row.create_state !== "started" || row.created_task_id) return row;
      const createState = explicit ? "failed" : "unknown", kind = explicit ? "task_creation_failed" : "task_creation_unknown";
      this.db.prepare("UPDATE messages SET create_state=?,state='needs_attention' WHERE id=?").run(createState, row.id);
      const failed = this.get(row.id);
      this.event(failed, kind, { source: explicit ? "zcode_native" : "transport", automaticRetry: false });
      this.event(failed, "delivery", { state: "needs_attention" });
      return failed;
    };
    return this.db.isTransaction ? apply() : this.transaction(apply);
  }
  enqueue({ requestId, taskIds, workspace, prompt, teamId = null, context = {} }) {
    validateQueueArgs("zcode_queue_enqueue", { requestId, ...(taskIds ? { taskIds } : { workspace }), prompt, ...(teamId === null ? {} : { teamId }), context });
    context = normalizeContext(context);
    workspace = workspace ? normalizeWorkspace(workspace) : null;
    const count = taskIds?.length ?? 1, target = taskIds ? [...taskIds].sort() : { workspace };
    const hash = fingerprint(target, prompt, teamId, context);
    if (bytes(prompt) + bytes(context) > LIMITS.requestBytes) throw Error("Request exceeds 40000 UTF-8 bytes; provide a bounded summary and references");
    let assignment;
    if (!this.db.prepare("SELECT 1 FROM messages WHERE request_id=?").get(requestId)) {
      assignment = assignmentOf(prompt, context);
      this.admitAssignment(assignment, Array(count)); // Reject known collisions before any retention maintenance.
      this.maintain(count, count * (bytes(prompt) + bytes(context) + futureMessageBytes),
        count * (bytes(prompt) + bytes(context)));
    }
    const estimatedBytes = count * (bytes(prompt) + bytes(context));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM messages WHERE request_id=? ORDER BY task_id").all(requestId);
      if (existing.length) {
        if (existing.length !== count || existing.some(r => r.request_hash !== hash)) throw Error("requestId already exists with different content or recipients");
        return { deduplicated: true, ownerId: this.ownerId, messages: existing.map(r => this.summary(r)) };
      }
      assignment ??= assignmentOf(prompt, context);
      this.admitAssignment(assignment, Array(count)); // Repeat under the cross-process write transaction.
      if (this.db.prepare(`SELECT count(*) AS n FROM messages WHERE state NOT IN (${terminal})`).get().n + count > LIMITS.pending) throw Error("Queue full: resolve pending entries first (limit 100)");
      if (this.db.prepare("SELECT count(*) AS n FROM messages WHERE pruned_at IS NULL").get().n + count > LIMITS.records || this.usedBytes() + count * (bytes(prompt) + bytes(context) + 16000) > LIMITS.workingBytes) throw Error("Storage capacity reached; confirm received terminal results first. Nothing sent.");
      const messages = (taskIds ?? [null]).map(taskId => {
        const id = randomUUID();
        const create = taskId === null, queueTarget = create ? `create:${id}` : taskId, targetAddress = create ? `workspace:create:${id}` : null;
        this.db.prepare(`INSERT INTO messages(id,request_id,task_id,team_id,prompt,context,request_hash,created_at,assignment,
          target_kind,target_address,workspace_path,workspace_identity,create_state,send_trace_id,send_query_id,send_message_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, requestId, queueTarget, teamId, prompt, JSON.stringify(context), hash, Date.now(), JSON.stringify(assignment),
          create ? "workspace" : "task", targetAddress, workspace?.path ?? null, workspace?.identity ?? null, create ? "pending" : null,
          create ? randomUUID() : null, create ? randomUUID() : null, create ? randomUUID() : null);
        const row = this.get(id);
        this.event(row, "delivery", { state: "queued" });
        return this.summary(row);
      });
      return { deduplicated: false, ownerId: this.ownerId, messages };
    }, estimatedBytes, { additionalMessages: count, requestId });
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
      for (const row of this.db.prepare("SELECT * FROM messages WHERE state='dispatching'").all()) {
        if (row.target_kind === "workspace" && row.create_state === "started" && !row.created_task_id) this.failCreate(row);
        else this.state(row, "uncertain");
      }
      return token;
    });
  }
  running(token) { const w = this.worker(); return w.desired === 1 && w.token === token; }
  heartbeat(token, error = null) {
    const apply = () => this.db.prepare("UPDATE worker SET heartbeat=?,error=? WHERE id=1 AND token=?").run(Date.now(), error, token);
    return this.db.isTransaction ? apply() : this.transaction(apply);
  }
  release(token) {
    const apply = () => this.db.prepare("UPDATE worker SET token=NULL,pid=NULL WHERE id=1 AND token=?").run(token);
    return this.db.isTransaction ? apply() : this.transaction(apply);
  }
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
      const conflict = this.assignmentConflict(JSON.parse(row.assignment), row.id);
      if (conflict) {
        this.state(row, "needs_attention"); this.event(row, "assignment_blocked", conflict);
        return false;
      }
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
      if (decision === "release" && !["queued", "uncertain", "needs_attention", "acknowledged", "retry_wait"].includes(row.state)) throw Error("Only queued, observed or uncertain deliveries can be manually released");
      this.state(row, decision === "cancel" ? "cancelled" : "released");
      this.db.prepare("UPDATE messages SET retry_at=NULL WHERE id=?").run(row.id);
      return { messageId, state: this.get(messageId).state, remoteStopped: false, businessAccepted: false };
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
      const saved = this.get(row.message_id), event = { cursor: row.seq, messageId: row.message_id,
        ...(saved.target_kind === "workspace" ? { targetAddress: saved.target_address, createdTaskId: saved.created_task_id } : { taskId: row.task_id }),
        teamId: row.team_id, kind: row.kind, payload: JSON.parse(row.payload), at: row.created_at };
      const envelope = included.has(row.message_id) ? null : this.envelope(saved);
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
    const messages = this.db.prepare(`SELECT *
      FROM messages WHERE (? IS NULL OR task_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR team_id=?) ORDER BY state IN (${terminal}),seq DESC LIMIT 100`).all(selected, selected, teamId, teamId)
      .map(row => ({ messageId: row.id, ...(row.target_kind === "workspace" ? { targetAddress: row.target_address,
          workspace: { path: row.workspace_path, ...(row.workspace_identity ? { identity: row.workspace_identity } : {}) },
          createState: row.create_state, createdTaskId: row.created_task_id } : { taskId: row.task_id }),
        teamId: row.team_id, state: row.state, nativeStatus: row.native_status, consumedAt: row.consumed_at,
        bodyPrunedAt: row.pruned_at, ...this.blocking(row.id) }));
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
  ["zcode_queue_enqueue", "Durably queue a user-authorized prompt for either 1-8 explicit existing task IDs or one connected workspace where the first message creates a new task. Same-task FIFO, optional team inbox label; no implicit broadcast. Stable requestId deduplicates retries. Does not send until queue_control start.", {
    requestId: text, taskIds: { type: "array", items: text, minItems: 1, maxItems: 8, uniqueItems: true }, workspace: workspaceSchema,
    prompt: { ...text, maxLength: 31000 }, teamId: text, context: contextSchema
  }, ["requestId", "prompt"], false],
  ["zcode_queue_read", "Read persisted task/team events and queue-worker status; no network, no wakeup, no acknowledgement of consumption. Pass returned cursor as after with the same filter. Completed is native turn completion, not business acceptance.", {
    taskId: text, taskIds: { type: "array", items: text, minItems: 1, maxItems: 8, uniqueItems: true }, teamId: text, consumerId: text, after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 100 }
  }, [], true],
  ["zcode_queue_control", "Explicitly start or gracefully stop the single background queue worker. Start dispatches queued authorized prompts and collects their replies without model polling; it does not wake Codex or start on app launch. Stop preserves queued data and allows an in-flight request to settle.", {
    action: { type: "string", enum: ["start", "stop"] }, scope: { type: "string", enum: ["all"] }, expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }, ["action", "scope", "expectedRevision"], false],
  ["zcode_queue_resolve", "Cancel an unsent queued message, or explicitly release a reviewed queued/acknowledged/uncertain/needs_attention/retry_wait item. Release retains its body and history under the normal retention policy and permits later messages to send, but does not prove completion, retry delivery, or stop ZCode. When reassigning a task, release reviewed obsolete queued followers before its blocked head.", {
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
  if (name === "zcode_queue_enqueue" && Boolean(args.taskIds) === Boolean(args.workspace)) throw Error("Choose exactly one of taskIds or workspace");
  if (args.workspace) normalizeWorkspace(args.workspace);
  if (Object.hasOwn(args, "context")) normalizeContext(args.context);
  if (args.decision === "received" ? !args.throughEvent || !args.consumerId : args.throughEvent !== undefined || name === "zcode_queue_resolve" && args.consumerId !== undefined) throw Error("throughEvent and consumerId are required only for received confirmation");
}

export async function launchWorker(reservation, { path = queuePath(), registrationKey = null, coreManaged = false } = {}, spawnProcess = spawn) {
  if (coreManaged && !registrationKey) throw budgetSourceError("budget_source_unavailable");
  const child = spawnProcess(process.execPath, [fileURLToPath(new URL("./queue-worker.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ZCODE_OPS_CONFIG: configPath(),
      ZCODE_OPS_QUEUE_PATH: path, ZCODE_OPS_CORE_REGISTRATION: registrationKey ?? "",
      ZCODE_OPS_CORE_REQUIRED: coreManaged ? "1" : "", ZCODE_OPS_WORKER_RESERVATION: reservation }
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
      const pid = await launch(reservation, { path: queue.path, registrationKey: queue.coreContext?.registrationKey,
        coreManaged: Boolean(queue.coreContext) });
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

export async function callQueueTool(name, args = {}, { launch, assertCurrent, validateMessageReceipt, messageBudget, registrationKey } = {}) {
  validateQueueArgs(name === "zcode_queue_send" ? "zcode_queue_enqueue" : name, args);
  const coreContext = assertCurrent || validateMessageReceipt || messageBudget || registrationKey
    ? { assertCurrent, validateMessageReceipt, messageBudget, registrationKey } : null;
  const path = queuePath(), initialAdditionalBytes = !existsSync(path) && (name === "zcode_queue_send" || name === "zcode_queue_enqueue")
    ? (args.taskIds?.length ?? 1) * (bytes(args.prompt) + bytes(normalizeContext(args.context)) + futureMessageBytes) : 0;
  assertCurrent?.();
  const queue = new MessageQueue(path, coreContext, initialAdditionalBytes);
  try {
    if (name === "zcode_queue_enqueue") return queue.enqueue(args);
    if (name === "zcode_queue_send") {
      let receipt = queue.enqueue(args);
      if (coreContext) {
        if (typeof validateMessageReceipt !== "function") throw Error("Core message receipt validator unavailable");
        receipt = { ...receipt, messages: receipt.messages.map(message => {
          const messageReceipt = { schemaVersion: 1, requestId: args.requestId, deliveryId: message.deliveryId,
            ownerId: message.ownerId, target: { moduleId: "agent-zcode", address: message.targetAddress ?? message.taskId }, correlation: message.correlation,
            acceptance: { owner: { state: "accepted", evidence: `messages.sqlite durable row:${message.messageId}` }, provider: { state: "unknown" } } };
          validateMessageReceipt(messageReceipt);
          return { ...message, messageReceipt };
        }) };
      }
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
