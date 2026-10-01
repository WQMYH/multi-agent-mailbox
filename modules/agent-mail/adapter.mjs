import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMPTY_BATCH = '00000000-0000-0000-0000-000000000000';
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 4096;
const MAX_BODY_BYTES = 8192;
const MAX_TARGETS = 16;
const MAX_CONSUMERS = 8;
const MAX_BATCH = 32;
const MAX_CONTACTS = 4096;
const EMPTY_ACK_TIME = '0000-00-00T00:00:00.000Z';
const NO_WRITE = Symbol('no-write');
const fail = (message, code = 'MAIL_INVALID') => { throw Object.assign(Error(message), { code }); };
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object`);
  return value;
};
const exact = (value, keys, name) => {
  object(value, name);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`Unknown ${name} field: ${key}`);
  return value;
};
const id = (value, name) => {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${name}`);
  return value;
};
const endpoint = (value, name) => {
  exact(value, ['moduleId', 'address'], name);
  return { moduleId: id(value.moduleId, `${name}.moduleId`), address: id(value.address, `${name}.address`) };
};
const localTarget = (value, name) => {
  const target = endpoint(value, name);
  if (target.moduleId !== 'agent-mail') fail('Agent Mail accepts only explicit agent-mail targets');
  return target;
};
const count = (value, name, maximum, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`Invalid ${name}`);
  return value;
};
const digest = value => createHash('sha256').update(value).digest('hex');

export function queuePath(env = process.env) {
  const path = env.AGENT_MAIL_DB_PATH ?? join(homedir(), '.codex-agent-core', 'agent-mail', 'queue.sqlite');
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('AGENT_MAIL_DB_PATH must be an absolute path');
  return resolve(path);
}

function canonicalPath(path) {
  let parent = resolve(path);
  const missing = [];
  while (!existsSync(parent)) { missing.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync.native(parent), ...missing);
}

function normalizedPath(path) {
  let value = canonicalPath(path).replaceAll('\\', '/');
  if (process.platform === 'win32') {
    value = value.toLowerCase();
    if (value.startsWith('//?/unc/')) value = `//${value.slice(8)}`;
    else if (value.startsWith('//?/')) value = value.slice(4);
  }
  return value;
}

export function queueOwnerId(path = queuePath()) {
  return `agent-mail:${digest(normalizedPath(path)).slice(0, 32)}`;
}

function managedBytes(path) {
  const files = [path, ...['-journal', '-wal', '-shm', '-stmtjrnl'].map(suffix => `${path}${suffix}`)];
  const directory = dirname(path), prefix = `${basename(path)}-mj`;
  if (existsSync(directory)) for (const name of readdirSync(directory))
    if (name.startsWith(prefix)) files.push(join(directory, name));
  return files.reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
}

const journalBytes = path => existsSync(`${path}-journal`) ? statSync(`${path}-journal`).size : 0;

function budgetCheck(path, context, additionalBytes) {
  const ownerId = queueOwnerId(path);
  if (!context.messageBudget?.status?.()) fail('Agent Mail budget is not configured', 'MAIL_BUDGET_BLOCKED');
  const result = context.messageBudget.check({ ownerId, usedBytes: managedBytes(path), additionalBytes });
  if (!result?.ok) throw Object.assign(Error(`Agent Mail budget blocked: ${result?.reason ?? 'unavailable'}`),
    { code: 'MAIL_BUDGET_BLOCKED', budget: result });
}

function peakBudgetCheck(path, context, db) {
  const size = existsSync(path) ? statSync(path).size : 0;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const pages = Math.max(db.prepare('PRAGMA page_count').get().page_count, Math.ceil(size / pageSize));
  // ponytail: a full DELETE-journal copy plus sector padding is a conservative physical peak bound.
  budgetCheck(path, context, pages * pageSize - size +
    Math.max(0, pages * (pageSize + 8) + 2 * 65536 - journalBytes(path)));
}

function rejectWal(path) {
  if (!existsSync(path) || statSync(path).size < 20) return;
  const file = openSync(path, 'r');
  try {
    const header = Buffer.alloc(20);
    readSync(file, header, 0, 20, 0);
    if (header.toString('utf8', 0, 16) === 'SQLite format 3\0' && (header[18] === 2 || header[19] === 2))
      fail('Agent Mail requires DELETE journal mode; preserve and migrate this database explicitly');
  } finally { closeSync(file); }
}

function verifyMeta(db, path, create) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const hasMeta = tables.some(row => row.name === 'mail_meta');
  if (!hasMeta && tables.length) fail('Unsupported Agent Mail database; preserve and migrate it explicitly');
  if (!hasMeta && !create) return false;
  if (!hasMeta) {
    db.exec(`CREATE TABLE mail_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,
      owner_id TEXT NOT NULL,queue_path TEXT NOT NULL);
      CREATE TABLE requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL REFERENCES requests(request_id),
        delivery_id TEXT NOT NULL UNIQUE,target TEXT NOT NULL,source TEXT NOT NULL,correlation TEXT NOT NULL,
        reply_to TEXT,team_id TEXT,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(request_id,target));
      CREATE INDEX messages_target_seq ON messages(target,seq);
      CREATE TABLE subscriptions(delivery_id TEXT NOT NULL REFERENCES messages(delivery_id) ON DELETE CASCADE,
        consumer_id TEXT NOT NULL,batch_id TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,acked_at TEXT NOT NULL,
        PRIMARY KEY(delivery_id,consumer_id));`);
    db.prepare('INSERT INTO mail_meta(id,schema_version,owner_id,queue_path) VALUES(1,1,?,?)')
      .run(queueOwnerId(path), normalizedPath(path));
  }
  const meta = db.prepare('SELECT schema_version,owner_id,queue_path FROM mail_meta WHERE id=1').get();
  if (meta?.schema_version !== 1 || meta.owner_id !== queueOwnerId(path) || meta.queue_path !== normalizedPath(path))
    fail('Agent Mail database owner identity changed; preserve and inspect it');
  return true;
}

function readDb(path, action) {
  if (!existsSync(path)) return action(null);
  rejectWal(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return action(verifyMeta(db, path, false) ? db : null);
  }
  finally { db.close(); }
}

function writeDb(path, context, action) {
  context.assertCurrent?.();
  const size = existsSync(path) ? statSync(path).size : 0;
  const pages = Math.ceil(size / 4096);
  budgetCheck(path, context, Math.max(0, pages * 4104 + 2 * 65536 - journalBytes(path)));
  // Reject unallocated or tight owners before creating files.
  rejectWal(path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let begun = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF; PRAGMA foreign_keys=ON');
    db.exec('BEGIN IMMEDIATE'); begun = true;
    verifyMeta(db, path, true);
    context.assertCurrent?.();
    const result = action(db);
    if (result?.[NO_WRITE]) { db.exec('ROLLBACK'); begun = false; return result.value; }
    context.assertCurrent?.();
    peakBudgetCheck(path, context, db);
    try { db.exec('COMMIT'); begun = false; }
    catch (error) { throw Object.assign(Error(`Agent Mail commit outcome unknown: ${error.message}`), { code: 'MAIL_COMMIT_UNKNOWN' }); }
    try { budgetCheck(path, context, 0); }
    catch (error) { throw Object.assign(Error(`Agent Mail committed but physical budget needs inspection: ${error.message}`),
      { code: 'MAIL_COMMIT_UNKNOWN' }); }
    return result;
  } catch (error) {
    if (begun) try { db.exec('ROLLBACK'); } catch { /* SQLite recovery owns the uncertain transaction. */ }
    throw error;
  } finally { db.close(); }
}

function prune(db, timestamp) {
  const cutoff = timestamp - DEDUPE_WINDOW_MS;
  db.prepare(`DELETE FROM messages WHERE created_at < ?
    AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.delivery_id=messages.delivery_id AND s.acked=0)
    AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.delivery_id=messages.delivery_id AND s.acked_at>=?)`)
    .run(cutoff, new Date(cutoff).toISOString());
  db.prepare('DELETE FROM requests WHERE created_at < ? AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.request_id=requests.request_id)')
    .run(cutoff);
}

function receipt(row, ownerId) {
  return { schemaVersion: 1, requestId: row.request_id, deliveryId: row.delivery_id, ownerId,
    target: { moduleId: 'agent-mail', address: row.target }, correlation: row.correlation,
    ...(row.reply_to === null ? {} : { replyTo: JSON.parse(row.reply_to) }),
    acceptance: { owner: { state: 'accepted', evidence: `agent-mail:${row.delivery_id}` }, provider: { state: 'unknown' } } };
}

const hasContacts = db => db && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_contacts'").get();
const contactFor = (db, address) => hasContacts(db) ? db.prepare('SELECT * FROM mail_contacts WHERE address=?').get(address) : null;
const contactRoute = (row, ownerId) => ({ ownerId,
  target: { moduleId: 'agent-mail', address: row.address }, consumers: [row.consumer_id] });

function item(row, ownerId, db) {
  const replyTo = row.reply_to === null ? null : JSON.parse(row.reply_to);
  const contact = replyTo?.ownerId === ownerId && replyTo.target.moduleId === 'agent-mail'
    ? contactFor(db, replyTo.target.address) : null;
  return { sequence: row.seq, requestId: row.request_id, deliveryId: row.delivery_id,
    target: { moduleId: 'agent-mail', address: row.target }, source: JSON.parse(row.source),
    correlation: row.correlation, ...(row.reply_to === null ? {} : { replyTo: JSON.parse(row.reply_to) }),
    ...(contact ? { replyRoute: contactRoute(contact, ownerId) } : {}),
    ...(row.team_id === null ? {} : { teamId: row.team_id }), body: row.body,
    createdAt: new Date(row.created_at).toISOString(), messageReceipt: receipt(row, ownerId) };
}

function normalizeSend(args) {
  exact(args, ['requestId', 'source', 'targets', 'body', 'correlation', 'replyTo', 'teamId'], 'send arguments');
  const requestId = id(args.requestId, 'requestId');
  const source = endpoint(args.source, 'source');
  if (typeof args.body !== 'string' || !args.body.trim() || Buffer.byteLength(args.body) > MAX_BODY_BYTES)
    fail(`body must be nonempty and at most ${MAX_BODY_BYTES} UTF-8 bytes`);
  if (!Array.isArray(args.targets) || !args.targets.length || args.targets.length > MAX_TARGETS)
    fail(`targets must contain 1-${MAX_TARGETS} explicit recipients`);
  const seen = new Set();
  const targets = args.targets.map((entry, index) => {
    exact(entry, ['target', 'consumers'], `targets[${index}]`);
    const target = localTarget(entry.target, `targets[${index}].target`);
    if (seen.has(target.address)) fail(`Duplicate target: ${target.address}`);
    seen.add(target.address);
    const contact = readDb(queuePath(), db => contactFor(db, target.address));
    const suppliedConsumers = entry.consumers === undefined ? (contact ? [contact.consumer_id] : undefined) : entry.consumers;
    if (!Array.isArray(suppliedConsumers) || !suppliedConsumers.length || suppliedConsumers.length > MAX_CONSUMERS)
      fail(`targets[${index}].consumers must contain 1-${MAX_CONSUMERS} IDs`);
    const consumers = suppliedConsumers.map((value, i) => id(value, `targets[${index}].consumers[${i}]`));
    if (new Set(consumers).size !== consumers.length) fail(`Duplicate consumer for ${target.address}`);
    if (contact && (consumers.length !== 1 || consumers[0] !== contact.consumer_id))
      fail(`Consumer does not match registered mailbox: ${target.address}`, 'MAIL_ROUTE_CONFLICT');
    return { target, consumers: consumers.sort() };
  });
  const replyTo = args.replyTo === undefined ? undefined : (() => {
    exact(args.replyTo, ['ownerId', 'target'], 'replyTo');
    return { ownerId: id(args.replyTo.ownerId, 'replyTo.ownerId'), target: endpoint(args.replyTo.target, 'replyTo.target') };
  })();
  return { requestId, source, targets: targets.sort((a, b) => a.target.address.localeCompare(b.target.address)),
    body: args.body, correlation: args.correlation === undefined ? requestId : id(args.correlation, 'correlation'),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(args.teamId === undefined ? {} : { teamId: id(args.teamId, 'teamId') }) };
}

function send(args, context) {
  const input = normalizeSend(args); // All targets, including provider targets, are checked before the first write.
  context.assertCurrent?.();
  const path = queuePath();
  const ownerId = queueOwnerId(path);
  const fingerprint = digest(JSON.stringify(input));
  const results = [];
  const existingFor = address => readDb(path, db => {
    if (!db) return null;
    const request = db.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(input.requestId);
    if (request && request.fingerprint !== fingerprint) fail(`requestId conflict: ${input.requestId}`, 'MAIL_ID_CONFLICT');
    return db.prepare('SELECT * FROM messages WHERE request_id=? AND target=?')
      .get(input.requestId, address) ?? null;
  });
  const accepted = (target, row) => {
    const messageReceipt = receipt(row, ownerId);
    context.validateMessageReceipt?.(messageReceipt);
    results.push({ target, state: 'accepted', deliveryId: row.delivery_id, messageReceipt });
  };
  for (const { target, consumers } of input.targets) {
    try {
      const previous = existingFor(target.address);
      if (previous) {
        context.assertCurrent?.();
        accepted(target, previous);
        continue;
      }
      const row = writeDb(path, context, db => {
        const prior = db.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(input.requestId);
        if (prior && prior.fingerprint !== fingerprint) fail(`requestId conflict: ${input.requestId}`, 'MAIL_ID_CONFLICT');
        const existing = db.prepare('SELECT * FROM messages WHERE request_id=? AND target=?')
          .get(input.requestId, target.address);
        if (existing) {
          context.validateMessageReceipt?.(receipt(existing, ownerId));
          return { [NO_WRITE]: true, value: existing };
        }
        const timestamp = Date.now();
        if (!prior) prune(db, timestamp);
        if (db.prepare('SELECT COUNT(*) AS n FROM messages').get().n >= MAX_MESSAGES)
          fail('Agent Mail protected/retained capacity is full', 'MAIL_CAPACITY_REACHED');
        if (!prior) db.prepare('INSERT INTO requests(request_id,fingerprint,created_at) VALUES(?,?,?)')
          .run(input.requestId, fingerprint, timestamp);
        const deliveryId = `mail:${randomUUID()}`;
        db.prepare(`INSERT INTO messages(request_id,delivery_id,target,source,correlation,reply_to,team_id,body,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(input.requestId, deliveryId, target.address, JSON.stringify(input.source),
          input.correlation, input.replyTo === undefined ? null : JSON.stringify(input.replyTo), input.teamId ?? null,
          input.body, timestamp);
        const insert = db.prepare('INSERT INTO subscriptions(delivery_id,consumer_id,batch_id,acked,acked_at) VALUES(?,?,?,0,?)');
        for (const consumer of consumers) insert.run(deliveryId, consumer, EMPTY_BATCH, EMPTY_ACK_TIME);
        const inserted = db.prepare('SELECT * FROM messages WHERE delivery_id=?').get(deliveryId);
        context.validateMessageReceipt?.(receipt(inserted, ownerId));
        return inserted;
      });
      accepted(target, row);
    } catch (error) {
      if (error.code === 'MAIL_ID_CONFLICT') throw error;
      if (['MAIL_BUDGET_BLOCKED', 'MAIL_COMMIT_UNKNOWN'].includes(error.code)) {
        const recovered = existingFor(target.address);
        if (recovered) { context.assertCurrent?.(); accepted(target, recovered); continue; }
      }
      results.push({ target, state: error.code === 'MAIL_COMMIT_UNKNOWN' ? 'unknown' : 'rejected',
        reason: error.code ?? 'MAIL_STORAGE_ERROR', detail: error.message });
    }
  }
  return { requestId: input.requestId, ownerId, results, dedupeWindowMs: DEDUPE_WINDOW_MS };
}

function contactRecord(row, ownerId) {
  return { registrationId: row.registration_id, label: row.label, ...contactRoute(row, ownerId),
    createdAt: new Date(row.created_at).toISOString(), presence: 'unknown',
    capabilities: { delivery: 'pull', nativeWake: false } };
}

const LABEL = /^(?=[\s\S]*\S)(?![\s\S]*[\u0000-\u001f\u007f])/u;
function label(value) {
  if (typeof value !== 'string' || !LABEL.test(value) || [...value].length > 128)
    fail('label must contain 1-128 characters without control characters');
  return value;
}

function register(args, context) {
  exact(args, ['requestId', 'label'], 'register arguments');
  const requestId = id(args.requestId, 'requestId'), name = label(args.label);
  const path = queuePath(), ownerId = queueOwnerId(path);
  const existing = db => hasContacts(db) ? db.prepare('SELECT * FROM mail_contacts WHERE registration_id=?').get(requestId) : null;
  const checked = row => {
    if (row.label !== name) fail(`Registration requestId conflict: ${requestId}`, 'MAIL_ID_CONFLICT');
    return contactRecord(row, ownerId);
  };
  context.assertCurrent?.();
  const previous = readDb(path, existing);
  if (previous) return checked(previous);
  return writeDb(path, context, db => {
    // Additive table only: old mail rows, fingerprints and Core receipt schema stay unchanged.
    db.exec(`CREATE TABLE IF NOT EXISTS mail_contacts(registration_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,address TEXT NOT NULL UNIQUE,consumer_id TEXT NOT NULL,created_at INTEGER NOT NULL)`);
    const prior = existing(db);
    if (prior) return { [NO_WRITE]: true, value: checked(prior) };
    if (db.prepare('SELECT COUNT(*) AS n FROM mail_contacts').get().n >= MAX_CONTACTS)
      fail('Agent Mail contact capacity is full', 'MAIL_CAPACITY_REACHED');
    const row = { registration_id: requestId, label: name, address: `mbx:${randomUUID()}`,
      consumer_id: `consumer:${randomUUID()}`, created_at: Date.now() };
    db.prepare('INSERT INTO mail_contacts(registration_id,label,address,consumer_id,created_at) VALUES(?,?,?,?,?)')
      .run(row.registration_id, row.label, row.address, row.consumer_id, row.created_at);
    return contactRecord(row, ownerId);
  });
}

function contacts(args, context) {
  exact(args, ['label', 'afterAddress', 'limit'], 'contacts arguments');
  const name = args.label === undefined ? null : label(args.label);
  const after = args.afterAddress === undefined ? '' : id(args.afterAddress, 'afterAddress');
  const limit = count(args.limit, 'limit', 64, 32);
  context.assertCurrent?.();
  const path = queuePath(), ownerId = queueOwnerId(path);
  const rows = readDb(path, db => hasContacts(db) ? db.prepare(`SELECT * FROM mail_contacts
    WHERE (? IS NULL OR label=?) AND address>? ORDER BY address LIMIT ?`).all(name, name, after, limit + 1) : []);
  const page = rows.slice(0, limit);
  return { ownerId, contacts: page.map(row => contactRecord(row, ownerId)),
    nextAfterAddress: rows.length > limit ? page.at(-1).address : null };
}

function normalizeRead(args, name) {
  exact(args, name === 'inbox' ? ['target', 'consumerId', 'limit'] : ['target', 'consumerId', 'limit', 'ack'], `${name} arguments`);
  return { target: localTarget(args.target, 'target'), consumerId: id(args.consumerId, 'consumerId'),
    limit: count(args.limit, 'limit', MAX_BATCH, MAX_BATCH) };
}

const pendingSql = `SELECT m.* FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
  WHERE m.target=? AND s.consumer_id=? AND s.acked=0 ORDER BY m.seq LIMIT ?`;
function inbox(args, context) {
  const { target, consumerId, limit } = normalizeRead(args, 'inbox');
  context.assertCurrent?.();
  const path = queuePath(), ownerId = queueOwnerId(path);
  const messages = readDb(path, db => db ? db.prepare(pendingSql).all(target.address, consumerId, limit)
    .map(row => item(row, ownerId, db)) : []);
  return { target, consumerId, messages, consumption: 'unconfirmed_preview', dedupeWindowMs: DEDUPE_WINDOW_MS };
}

function batchRows(db, address, consumerId, batchId) {
  return db.prepare(`SELECT m.* FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
    WHERE m.target=? AND s.consumer_id=? AND s.batch_id=? ORDER BY m.seq`).all(address, consumerId, batchId);
}

function openBatch(db, address, consumerId) {
  const first = db.prepare(`SELECT s.batch_id FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
    WHERE m.target=? AND s.consumer_id=? AND s.acked=0 AND s.batch_id<>? ORDER BY m.seq LIMIT 1`)
    .get(address, consumerId, EMPTY_BATCH);
  return first ? { batchId: first.batch_id, rows: batchRows(db, address, consumerId, first.batch_id) } : null;
}

function confirmAndFetch(args, context) {
  const { target, consumerId, limit } = normalizeRead(args, 'confirm_and_fetch');
  let ack;
  if (args.ack !== undefined) {
    exact(args.ack, ['batchId', 'deliveryIds'], 'ack');
    ack = { batchId: id(args.ack.batchId, 'ack.batchId'), deliveryIds: args.ack.deliveryIds };
    if (!Array.isArray(ack.deliveryIds) || !ack.deliveryIds.length || ack.deliveryIds.length > MAX_BATCH)
      fail('ack.deliveryIds must be a nonempty batch');
    ack.deliveryIds = ack.deliveryIds.map((value, index) => id(value, `ack.deliveryIds[${index}]`));
  }
  const path = queuePath(), ownerId = queueOwnerId(path);
  return writeDb(path, context, db => {
    let confirmed = null;
    if (ack) {
      const rows = batchRows(db, target.address, consumerId, ack.batchId);
      if (!rows.length || rows.length !== ack.deliveryIds.length ||
          rows.some((row, i) => row.delivery_id !== ack.deliveryIds[i]))
        fail('Ack does not match a fetched batch for this target and consumer');
      const states = db.prepare(`SELECT DISTINCT s.acked FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
        WHERE m.target=? AND s.consumer_id=? AND s.batch_id=?`).all(target.address, consumerId, ack.batchId);
      if (states.length !== 1) fail('Inconsistent batch confirmation state');
      if (states[0].acked === 0) db.prepare(`UPDATE subscriptions SET acked=1,acked_at=?
        WHERE consumer_id=? AND batch_id=? AND delivery_id IN
          (SELECT delivery_id FROM messages WHERE target=?)`).run(new Date().toISOString(), consumerId, ack.batchId, target.address);
      confirmed = { batchId: ack.batchId, deliveryIds: ack.deliveryIds };
    }
    let active = openBatch(db, target.address, consumerId);
    if (!active) {
      const rows = db.prepare(`SELECT m.* FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
        WHERE m.target=? AND s.consumer_id=? AND s.acked=0 AND s.batch_id=? ORDER BY m.seq LIMIT ?`)
        .all(target.address, consumerId, EMPTY_BATCH, limit);
      if (rows.length) {
        const batchId = randomUUID();
        const assign = db.prepare('UPDATE subscriptions SET batch_id=? WHERE delivery_id=? AND consumer_id=? AND batch_id=? AND acked=0');
        for (const row of rows) if (assign.run(batchId, row.delivery_id, consumerId, EMPTY_BATCH).changes !== 1)
          fail('Batch assignment changed concurrently');
        active = { batchId, rows };
      }
    }
    return { target, consumerId, confirmed,
      batch: active ? { batchId: active.batchId, deliveryIds: active.rows.map(row => row.delivery_id),
        messages: active.rows.map(row => item(row, ownerId, db)) } : null,
      consumption: 'confirmation_required', dedupeWindowMs: DEDUPE_WINDOW_MS };
  });
}

const idSchema = { type: 'string', pattern: ID.source, minLength: 1, maxLength: 128 };
const labelSchema = { type: 'string', pattern: LABEL.source, minLength: 1, maxLength: 128,
  description: 'Human-readable label: 1-128 Unicode code points, non-whitespace, no ASCII control characters. Not a unique address or authenticated identity.' };
const endpointSchema = { type: 'object', required: ['moduleId', 'address'],
  properties: { moduleId: idSchema, address: idSchema }, additionalProperties: false };
const mailTargetSchema = { ...endpointSchema,
  properties: { moduleId: { type: 'string', const: 'agent-mail' }, address: idSchema } };
const readProperties = { target: mailTargetSchema, consumerId: idSchema,
  limit: { type: 'integer', minimum: 1, maximum: MAX_BATCH, default: MAX_BATCH } };
const definitions = [
  { name: 'register', description: 'Create a durable pull mailbox for one logical agent session. Preserve requestId across reconnects; use a new ID for an unrelated session. Same ID/label returns the same route. Does not start, authenticate or grant authority to an agent.',
    inputSchema: { type: 'object', required: ['requestId', 'label'], additionalProperties: false,
      properties: { requestId: idSchema, label: labelSchema } }, annotations: { readOnlyHint: false } },
  { name: 'contacts', description: 'Read registered pull routes; labels may repeat. Choose the exact target address, never guess by label. Registration does not prove a live consumer. No native wakeup.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      label: labelSchema, afterAddress: idSchema,
      limit: { type: 'integer', minimum: 1, maximum: 64, default: 32 }
    } }, annotations: { readOnlyHint: true } },
  { name: 'send', description: 'Persist bounded messages for explicit local recipients; no product dispatch or wakeup.',
    inputSchema: { type: 'object', required: ['requestId', 'source', 'targets', 'body'], properties: {
      requestId: { ...idSchema, description: 'Keep the same ID and payload when reconciling an uncertain local admission.' },
      source: { ...endpointSchema, description: 'Declared agent origin, not authenticated human authority or queue ownership.' },
      targets: { type: 'array', minItems: 1, maxItems: MAX_TARGETS,
        description: 'Explicit unique mailbox addresses. Registered mailboxes resolve consumers when omitted; legacy addresses require explicit consumers. Never guess a native session route.',
        items: { type: 'object', required: ['target'], additionalProperties: false,
          properties: { target: mailTargetSchema,
            consumers: { type: 'array', minItems: 1, maxItems: MAX_CONSUMERS, uniqueItems: true, items: idSchema } } } },
      body: { type: 'string', minLength: 1, pattern: '\\S',
        description: `Self-contained agent message; at most ${MAX_BODY_BYTES} UTF-8 bytes, not characters. Does not grant human authorization.` },
      correlation: { ...idSchema, description: 'Defaults to requestId. Copy the original correlation for a related reply.' },
      replyTo: { type: 'object', required: ['ownerId', 'target'], additionalProperties: false,
        description: 'Set to your register result ownerId/target. Local registered replies expose complete replyRoute on read. Legacy/foreign addresses have no inferred consumers or automatic forwarding.',
        properties: { ownerId: idSchema, target: endpointSchema } }, teamId: idSchema
    }, additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'inbox', description: 'Preview unconfirmed local messages without changing delivery or consumer state.',
    inputSchema: { type: 'object', required: ['target', 'consumerId'], properties: readProperties,
      additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'confirm_and_fetch', description: 'Fetch without ack first; replay the same open batch until explicitly confirmed. Confirm only after durable handling, not after preview. Confirmation is not business completion.',
    inputSchema: { type: 'object', required: ['target', 'consumerId'], properties: {
      ...readProperties,
      ack: { type: 'object', required: ['batchId', 'deliveryIds'], additionalProperties: false,
        description: 'Copy the exact batchId and ordered deliveryIds from this target/consumer previous fetch; never guess or partially acknowledge.',
        properties: { batchId: idSchema,
          deliveryIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: idSchema } } }
    }, additionalProperties: false }, annotations: { readOnlyHint: false } }
];

export async function describe() { return structuredClone(definitions); }
export async function call(operation, args = {}, context = {}) {
  if (operation === 'register') return register(args, context);
  if (operation === 'contacts') return contacts(args, context);
  if (operation === 'send') return send(args, context);
  if (operation === 'inbox') return inbox(args, context);
  if (operation === 'confirm_and_fetch') return confirmAndFetch(args, context);
  fail(`Unknown Agent Mail operation: ${operation}`);
}
