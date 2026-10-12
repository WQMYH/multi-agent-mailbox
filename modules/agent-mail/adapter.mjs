import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { messageObserveInputSchema, validateMessageObserveArgs, encodeMessageObserveCursor,
  decodeMessageObserveCursor, validateMessageObservation } from './runtime/core-contracts.mjs';
import { readReceiverConfig, receiverBinding, nativeIntentId, consumptionNotice,
  probeReceiver, notifyReceiver } from './receivers.mjs';

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
    db.exec('BEGIN');
    return action(verifyMeta(db, path, false) ? db : null);
  }
  finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
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
    AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.delivery_id=messages.delivery_id AND s.acked_at>=?)
    ${hasReceivers(db) ? "AND NOT EXISTS(SELECT 1 FROM mail_native_intents n WHERE n.delivery_id=messages.delivery_id AND n.state='unknown')" : ''}`)
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
const hasReceivers = db => db && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_receivers'").get();
const boundReceivers = (db, address) => hasReceivers(db)
  ? db.prepare('SELECT * FROM mail_receivers WHERE target=? ORDER BY receiver_id').all(address) : [];
const registeredConsumers = (db, row) => [...new Set([row.consumer_id,
  ...boundReceivers(db, row.address).map(receiver => receiver.consumer_id)])];
const contactRoute = (row, ownerId, db) => ({ ownerId,
  target: { moduleId: 'agent-mail', address: row.address }, consumers: registeredConsumers(db, row) });

function item(row, ownerId, db) {
  const replyTo = row.reply_to === null ? null : JSON.parse(row.reply_to);
  const contact = replyTo?.ownerId === ownerId && replyTo.target.moduleId === 'agent-mail'
    ? contactFor(db, replyTo.target.address) : null;
  return { sequence: row.seq, requestId: row.request_id, deliveryId: row.delivery_id,
    target: { moduleId: 'agent-mail', address: row.target }, source: JSON.parse(row.source),
    correlation: row.correlation, ...(row.reply_to === null ? {} : { replyTo: JSON.parse(row.reply_to) }),
    ...(contact ? { replyRoute: contactRoute(contact, ownerId, db) } : {}),
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
    const { contact, registered } = readDb(queuePath(), db => {
      const contact = contactFor(db, target.address);
      return { contact, registered: contact ? registeredConsumers(db, contact) : [] };
    });
    const suppliedConsumers = entry.consumers === undefined ? (contact ? [contact.consumer_id] : undefined) : entry.consumers;
    if (!Array.isArray(suppliedConsumers) || !suppliedConsumers.length || suppliedConsumers.length > MAX_CONSUMERS)
      fail(`targets[${index}].consumers must contain 1-${MAX_CONSUMERS} IDs`);
    const consumers = suppliedConsumers.map((value, i) => id(value, `targets[${index}].consumers[${i}]`));
    if (new Set(consumers).size !== consumers.length) fail(`Duplicate consumer for ${target.address}`);
    if (contact && consumers.some(consumer => !registered.includes(consumer)))
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

async function send(args, context) {
  const input = normalizeSend(args); // All targets, including provider targets, are checked before the first write.
  context.assertCurrent?.();
  const path = queuePath();
  const ownerId = queueOwnerId(path);
  const fingerprint = digest(JSON.stringify(input));
  const results = [];
  const fresh = new Set();
  const implicitTargets = new Set(args.targets.filter(entry => entry.consumers === undefined).map(entry => entry.target.address));
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
      const admitted = writeDb(path, context, db => {
        const prior = db.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(input.requestId);
        if (prior && prior.fingerprint !== fingerprint) fail(`requestId conflict: ${input.requestId}`, 'MAIL_ID_CONFLICT');
        const existing = db.prepare('SELECT * FROM messages WHERE request_id=? AND target=?')
          .get(input.requestId, target.address);
        if (existing) {
          context.validateMessageReceipt?.(receipt(existing, ownerId));
          return { [NO_WRITE]: true, value: { row: existing, inserted: false } };
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
        const nativeConsumers = boundReceivers(db, target.address).map(receiver => receiver.consumer_id);
        const enrolled = [...new Set(implicitTargets.has(target.address) && nativeConsumers.length
          ? nativeConsumers : [...consumers, ...nativeConsumers])];
        if (enrolled.length > MAX_CONSUMERS) fail('Agent Mail consumer capacity is full', 'MAIL_CAPACITY_REACHED');
        for (const consumer of enrolled) insert.run(deliveryId, consumer, EMPTY_BATCH, EMPTY_ACK_TIME);
        for (const receiver of boundReceivers(db, target.address)) pendingIntent(db, deliveryId, receiver.receiver_id);
        const inserted = db.prepare('SELECT * FROM messages WHERE delivery_id=?').get(deliveryId);
        context.validateMessageReceipt?.(receipt(inserted, ownerId));
        return { row: inserted, inserted: true };
      });
      accepted(target, admitted.row);
      if (admitted.inserted) fresh.add(admitted.row.delivery_id);
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
  await Promise.all(results.filter(result => result.state === 'accepted').map(async result => {
    const notifications = await notifyDelivery(path, result.deliveryId, context, fresh.has(result.deliveryId));
    if (notifications.length) result.nativeDelivery = notifications;
  }));
  if (fresh.size) startMailWorker(path, context);
  return { requestId: input.requestId, ownerId, results, dedupeWindowMs: DEDUPE_WINDOW_MS };
}

function contactRecord(row, ownerId, db) {
  const receivers = boundReceivers(db, row.address);
  return { registrationId: row.registration_id, label: row.label, ...contactRoute(row, ownerId, db),
    createdAt: new Date(row.created_at).toISOString(), presence: 'unknown',
    capabilities: { delivery: receivers.length ? 'pull_with_native_notification' : 'pull', nativeWake: receivers.length > 0 },
    ...(receivers.length ? { receivers: receivers.map(receiver => ({ receiverId: receiver.receiver_id, consumerId: receiver.consumer_id })) } : {}) };
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
  const checked = (row, db) => {
    if (row.label !== name) fail(`Registration requestId conflict: ${requestId}`, 'MAIL_ID_CONFLICT');
    return contactRecord(row, ownerId, db);
  };
  context.assertCurrent?.();
  const previous = readDb(path, db => { const row = existing(db); return row ? checked(row, db) : null; });
  if (previous) return previous;
  return writeDb(path, context, db => {
    // Additive table only: old mail rows, fingerprints and Core receipt schema stay unchanged.
    db.exec(`CREATE TABLE IF NOT EXISTS mail_contacts(registration_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,address TEXT NOT NULL UNIQUE,consumer_id TEXT NOT NULL,created_at INTEGER NOT NULL)`);
    const prior = existing(db);
    if (prior) return { [NO_WRITE]: true, value: checked(prior, db) };
    if (db.prepare('SELECT COUNT(*) AS n FROM mail_contacts').get().n >= MAX_CONTACTS)
      fail('Agent Mail contact capacity is full', 'MAIL_CAPACITY_REACHED');
    const row = { registration_id: requestId, label: name, address: `mbx:${randomUUID()}`,
      consumer_id: `consumer:${randomUUID()}`, created_at: Date.now() };
    db.prepare('INSERT INTO mail_contacts(registration_id,label,address,consumer_id,created_at) VALUES(?,?,?,?,?)')
      .run(row.registration_id, row.label, row.address, row.consumer_id, row.created_at);
    return contactRecord(row, ownerId, db);
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
    WHERE (? IS NULL OR label=?) AND address>? ORDER BY address LIMIT ?`).all(name, name, after, limit + 1)
    .map(row => contactRecord(row, ownerId, db)) : []);
  const page = rows.slice(0, limit);
  return { ownerId, contacts: page,
    nextAfterAddress: rows.length > limit ? page.at(-1).target.address : null };
}

function receiverTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_receivers(receiver_id TEXT PRIMARY KEY,target TEXT NOT NULL,
    consumer_id TEXT NOT NULL,binding TEXT NOT NULL,transport TEXT NOT NULL,session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,UNIQUE(target,consumer_id));
    CREATE TABLE IF NOT EXISTS mail_native_intents(delivery_id TEXT NOT NULL REFERENCES messages(delivery_id) ON DELETE CASCADE,
    receiver_id TEXT NOT NULL REFERENCES mail_receivers(receiver_id),native_id TEXT NOT NULL,state TEXT NOT NULL,
    reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(delivery_id,receiver_id));
    CREATE TABLE IF NOT EXISTS mail_dispatch_worker(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,
    registration_key TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
}

function pendingIntent(db, deliveryId, receiverId) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO mail_native_intents VALUES(?,?,?,?,?,?,?)').run(deliveryId, receiverId,
    nativeIntentId(deliveryId, receiverId), 'pending', 'NATIVE_NOT_ATTEMPTED', now, now);
}

const receiverPublic = row => ({ receiverId: row.receiver_id, target: { moduleId: 'agent-mail', address: row.target },
  consumerId: row.consumer_id, transport: row.transport, sessionId: row.session_id,
  createdAt: new Date(row.created_at).toISOString() });
const nativePublic = row => ({ receiverId: row.receiver_id, deliveryId: row.delivery_id,
  nativeId: row.native_id, state: row.state, reason: row.reason, attempted: row.state !== 'pending',
  updatedAt: new Date(row.updated_at).toISOString() });
const deliveryIds = value => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BATCH) fail('deliveryIds must be a nonempty bounded list');
  const ids = value.map((entry, index) => id(entry, `deliveryIds[${index}]`));
  if (new Set(ids).size !== ids.length) fail('Duplicate deliveryId');
  return ids;
};
const unavailable = (receiver, deliveryId, reason) => ({ receiverId: receiver.receiver_id, deliveryId,
  state: 'unreachable', reason, attempted: false });

async function receiverAvailability(row, context) {
  try {
    const config = (context.mailReceivers?.readConfig ?? readReceiverConfig)().find(entry => entry.receiverId === row.receiver_id);
    if (!config) return { presence: 'unreachable', reason: 'RECEIVER_NOT_CONFIGURED' };
    if (!config.enabled) return { presence: 'unreachable', reason: 'RECEIVER_DISABLED' };
    if (receiverBinding(config) !== row.binding) return { presence: 'unreachable', reason: 'RECEIVER_BINDING_CHANGED' };
    const probe = await (context.mailReceivers?.probe ?? probeReceiver)(config);
    if (!probe?.reachable) return { presence: 'unreachable', reason: probe?.reason ?? 'NATIVE_UNREACHABLE' };
    return { presence: 'reachable', config, probe };
  } catch { return { presence: 'unreachable', reason: 'RECEIVER_PROBE_FAILED' }; }
}

async function connectReceiver(args, context) {
  exact(args, ['receiverId', 'target', 'consumerId', 'deliveryIds'], 'connect_receiver arguments');
  const receiverId = id(args.receiverId, 'receiverId'), target = localTarget(args.target, 'target');
  const requestedConsumer = args.consumerId === undefined ? undefined : id(args.consumerId, 'consumerId');
  const historical = args.deliveryIds === undefined ? [] : deliveryIds(args.deliveryIds);
  const config = (context.mailReceivers?.readConfig ?? readReceiverConfig)().find(entry => entry.receiverId === receiverId);
  if (!config) fail('Receiver is not in trusted operator configuration', 'MAIL_RECEIVER_UNCONFIGURED');
  const binding = receiverBinding(config), path = queuePath(), ownerId = queueOwnerId(path);
  const row = writeDb(path, context, db => {
    const contact = contactFor(db, target.address);
    if (!contact) fail('Receiver target must be an existing registered mailbox', 'MAIL_ROUTE_CONFLICT');
    receiverTables(db);
    if (db.prepare('SELECT 1 FROM mail_receivers WHERE binding=? AND receiver_id<>?').get(binding, receiverId))
      fail('Native receiving session is already connected under another receiverId', 'MAIL_RECEIVER_CONFLICT');
    let receiver = db.prepare('SELECT * FROM mail_receivers WHERE receiver_id=?').get(receiverId);
    if (receiver && (receiver.target !== target.address || receiver.binding !== binding ||
        (requestedConsumer !== undefined && receiver.consumer_id !== requestedConsumer)))
      fail('Receiver identity is immutable; use a new receiverId for a different session', 'MAIL_RECEIVER_CONFLICT');
    if (!receiver) {
      const consumers = registeredConsumers(db, contact);
      const consumerId = requestedConsumer ?? `consumer:${randomUUID()}`;
      if (requestedConsumer !== undefined && consumerId !== contact.consumer_id)
        fail('Existing consumer must match the registered default consumer', 'MAIL_ROUTE_CONFLICT');
      if (boundReceivers(db, target.address).some(entry => entry.consumer_id === consumerId))
        fail('A consumer cannot be shared by different native receivers', 'MAIL_RECEIVER_CONFLICT');
      if (!consumers.includes(consumerId) && consumers.length >= MAX_CONSUMERS)
        fail('Agent Mail consumer capacity is full', 'MAIL_CAPACITY_REACHED');
      receiver = { receiver_id: receiverId, target: target.address, consumer_id: consumerId, binding,
        transport: config.transport, session_id: config.sessionId, created_at: Date.now() };
      db.prepare('INSERT INTO mail_receivers VALUES(?,?,?,?,?,?,?)').run(receiver.receiver_id, receiver.target,
        receiver.consumer_id, receiver.binding, receiver.transport, receiver.session_id, receiver.created_at);
    }
    for (const deliveryId of historical) {
      const message = db.prepare('SELECT target FROM messages WHERE delivery_id=?').get(deliveryId);
      if (!message || message.target !== target.address) fail('Historical delivery does not match receiver target', 'MAIL_ROUTE_CONFLICT');
      const count = db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE delivery_id=?').get(deliveryId).n;
      const exists = db.prepare('SELECT 1 FROM subscriptions WHERE delivery_id=? AND consumer_id=?').get(deliveryId, receiver.consumer_id);
      if (!exists && count >= MAX_CONSUMERS) fail('Agent Mail consumer capacity is full', 'MAIL_CAPACITY_REACHED');
      if (!exists) db.prepare('INSERT INTO subscriptions VALUES(?,?,?,0,?)').run(deliveryId, receiver.consumer_id, EMPTY_BATCH, EMPTY_ACK_TIME);
      const subscription = db.prepare('SELECT acked FROM subscriptions WHERE delivery_id=? AND consumer_id=?').get(deliveryId, receiver.consumer_id);
      if (subscription.acked === 0) pendingIntent(db, deliveryId, receiverId);
    }
    return receiver;
  });
  const availability = await receiverAvailability(row, context);
  const notifications = await Promise.all(historical.map(deliveryId => notifyOne(path, row, deliveryId, context, true)));
  startMailWorker(path, context);
  return { ownerId, ...receiverPublic(row), presence: availability.presence,
    ...(availability.reason ? { reason: availability.reason } : {}), historicalDeliveryIds: historical,
    ...(notifications.length ? { nativeDelivery: notifications } : {}) };
}

async function receivers(args, context) {
  exact(args, ['receiverId', 'target', 'afterReceiverId', 'limit'], 'receivers arguments');
  const receiverId = args.receiverId === undefined ? null : id(args.receiverId, 'receiverId');
  const target = args.target === undefined ? null : localTarget(args.target, 'target').address;
  const after = args.afterReceiverId === undefined ? '' : id(args.afterReceiverId, 'afterReceiverId');
  const limit = count(args.limit, 'limit', 64, 32), path = queuePath();
  context.assertCurrent?.();
  const rows = readDb(path, db => hasReceivers(db) ? db.prepare(`SELECT * FROM mail_receivers
    WHERE (? IS NULL OR receiver_id=?) AND (? IS NULL OR target=?) AND receiver_id>? ORDER BY receiver_id LIMIT ?`)
    .all(receiverId, receiverId, target, target, after, limit + 1) : []);
  const page = rows.slice(0, limit);
  const records = await Promise.all(page.map(async row => {
    const status = await receiverAvailability(row, context);
    return { ...receiverPublic(row), presence: status.presence, ...(status.reason ? { reason: status.reason } : {}) };
  }));
  context.assertCurrent?.();
  return { ownerId: queueOwnerId(path), receivers: records,
    nextAfterReceiverId: rows.length > limit ? page.at(-1).receiver_id : null };
}

async function notifyOne(path, receiver, deliveryId, context, dispatch) {
  const prior = () => readDb(path, db => db?.prepare('SELECT * FROM mail_native_intents WHERE delivery_id=? AND receiver_id=?')
    .get(deliveryId, receiver.receiver_id));
  const previous = prior();
  if (previous && previous.state !== 'pending') return nativePublic(previous);
  if (!dispatch) return { receiverId: receiver.receiver_id, deliveryId, state: 'pending', attempted: false };
  const availability = await receiverAvailability(receiver, context);
  if (availability.presence !== 'reachable') return unavailable(receiver, deliveryId, availability.reason);
  let claimed;
  try {
    claimed = writeDb(path, context, db => {
      const previous = db.prepare('SELECT * FROM mail_native_intents WHERE delivery_id=? AND receiver_id=?').get(deliveryId, receiver.receiver_id);
      if (previous && previous.state !== 'pending') return { [NO_WRITE]: true, value: { prior: previous } };
      const subscribed = db.prepare(`SELECT m.* FROM messages m JOIN subscriptions s ON m.delivery_id=s.delivery_id
        WHERE m.delivery_id=? AND m.target=? AND s.consumer_id=? AND s.acked=0`).get(deliveryId, receiver.target, receiver.consumer_id);
      if (!subscribed) return { [NO_WRITE]: true, value: { done: true } };
      const now = Date.now(), nativeId = nativeIntentId(deliveryId, receiver.receiver_id);
      if (!previous) pendingIntent(db, deliveryId, receiver.receiver_id);
      db.prepare("UPDATE mail_native_intents SET state='unknown',reason='NATIVE_DISPATCH_CLAIMED',updated_at=? WHERE delivery_id=? AND receiver_id=? AND state='pending'")
        .run(now, deliveryId, receiver.receiver_id);
      return { nativeId };
    });
  } catch { return prior() ? nativePublic(prior()) : unavailable(receiver, deliveryId, 'NATIVE_CLAIM_BLOCKED'); }
  if (claimed.prior) return nativePublic(claimed.prior);
  if (claimed.done) return { receiverId: receiver.receiver_id, deliveryId, state: 'consumer_confirmed', attempted: false };
  let outcome = { state: 'unknown', reason: 'NATIVE_OUTCOME_UNKNOWN' };
  try {
    context.assertCurrent?.();
    const current = await receiverAvailability(receiver, context);
    if (current.presence !== 'reachable') outcome = { state: 'unknown', reason: 'NATIVE_CHANGED_AFTER_CLAIM' };
    else {
      context.assertCurrent?.();
      const result = await (context.mailReceivers?.notify ?? notifyReceiver)(current.config, current.probe,
        { nativeId: claimed.nativeId, text: consumptionNotice({ ownerId: queueOwnerId(path),
          target: { moduleId: 'agent-mail', address: receiver.target }, consumerId: receiver.consumer_id, deliveryId, queuePath: path }, current.config.coreClient) });
      if (['submitted', 'accepted', 'held', 'refused', 'unknown'].includes(result?.state))
        outcome = { state: result.state, reason: result.reason ?? 'NATIVE_OUTCOME_UNKNOWN' };
    }
  } catch { /* A claimed native action is never replayed after a lost response or generation change. */ }
  try {
    writeDb(path, context, db => db.prepare('UPDATE mail_native_intents SET state=?,reason=?,updated_at=? WHERE delivery_id=? AND receiver_id=?')
      .run(outcome.state, outcome.reason, Date.now(), deliveryId, receiver.receiver_id));
  } catch { /* The persisted claim remains unknown if result recording is blocked. */ }
  return nativePublic(prior());
}

async function notifyDelivery(path, deliveryId, context, dispatch) {
  const rows = readDb(path, db => hasReceivers(db) ? db.prepare(`SELECT r.* FROM mail_receivers r
    JOIN mail_native_intents n ON n.receiver_id=r.receiver_id WHERE n.delivery_id=? ORDER BY r.receiver_id`).all(deliveryId) : []);
  return Promise.all(rows.map(receiver => notifyOne(path, receiver, deliveryId, context, dispatch)));
}

async function deliverPending(args, context) {
  exact(args, ['receiverId', 'deliveryIds'], 'deliver_pending arguments');
  const receiverId = id(args.receiverId, 'receiverId'), ids = deliveryIds(args.deliveryIds), path = queuePath();
  context.assertCurrent?.();
  const receiver = readDb(path, db => hasReceivers(db) ? db.prepare('SELECT * FROM mail_receivers WHERE receiver_id=?').get(receiverId) : null);
  if (!receiver) fail('Receiver is not connected', 'MAIL_RECEIVER_UNCONFIGURED');
  readDb(path, db => {
    for (const deliveryId of ids) if (!db.prepare(`SELECT 1 FROM messages m JOIN subscriptions s ON m.delivery_id=s.delivery_id
      WHERE m.delivery_id=? AND m.target=? AND s.consumer_id=?`).get(deliveryId, receiver.target, receiver.consumer_id))
      fail('Delivery is not subscribed to this receiver', 'MAIL_ROUTE_CONFLICT');
  });
  return { ownerId: queueOwnerId(path), receiverId,
    results: await Promise.all(ids.map(deliveryId => notifyOne(path, receiver, deliveryId, context, true))) };
}

export function pendingNotifications(path = queuePath(), receiverIds) {
  if (receiverIds?.length === 0) return [];
  return readDb(path, db => hasReceivers(db) ? db.prepare(`WITH pending AS (SELECT n.delivery_id,r.*,m.seq,
    ROW_NUMBER() OVER(PARTITION BY r.receiver_id ORDER BY m.seq) AS position FROM mail_native_intents n
    JOIN mail_receivers r ON r.receiver_id=n.receiver_id JOIN messages m ON m.delivery_id=n.delivery_id
    JOIN subscriptions s ON s.delivery_id=n.delivery_id AND s.consumer_id=r.consumer_id
    WHERE n.state='pending' AND s.acked=0 ${receiverIds ? `AND r.receiver_id IN (${receiverIds.map(() => '?').join(',')})` : ''})
    SELECT * FROM pending WHERE position=1 ORDER BY seq,receiver_id LIMIT 64`).all(...(receiverIds ?? [])) : []);
}

export async function dispatchPendingNotifications(context, path = queuePath()) {
  context.assertCurrent?.();
  let configured;
  try { configured = (context.mailReceivers?.readConfig ?? readReceiverConfig)().map(receiver => receiver.receiverId); }
  catch { configured = []; }
  const pending = pendingNotifications(path, configured);
  const results = await Promise.all(pending.map(row => notifyOne(path, row, row.delivery_id, context, true)));
  return { results, pending: pendingNotifications(path).length };
}

export function claimMailWorker(context, token, now = Date.now(), path = queuePath()) {
  return writeDb(path, context, db => {
    if (!hasReceivers(db)) return { [NO_WRITE]: true, value: false };
    const prior = db.prepare('SELECT * FROM mail_dispatch_worker WHERE id=1').get();
    if (prior && prior.token !== token && prior.registration_key === context.registrationKey && prior.expires_at > now)
      return { [NO_WRITE]: true, value: false };
    db.prepare('INSERT INTO mail_dispatch_worker VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,registration_key=excluded.registration_key,expires_at=excluded.expires_at')
      .run(token, context.registrationKey, now + 60000);
    return true;
  });
}

export function releaseMailWorker(context, token, path = queuePath()) {
  try {
    writeDb(path, context, db => {
      if (db.prepare('SELECT token FROM mail_dispatch_worker WHERE id=1').get()?.token !== token)
        return { [NO_WRITE]: true, value: false };
      return db.prepare('DELETE FROM mail_dispatch_worker WHERE id=1 AND token=?').run(token);
    });
  } catch { /* A revoked generation leaves a bounded lease for its successor. */ }
}

export function finishMailWorkerIfIdle(context, token, path = queuePath()) {
  return writeDb(path, context, db => {
    if (db.prepare('SELECT token FROM mail_dispatch_worker WHERE id=1').get()?.token !== token)
      fail('Agent Mail dispatcher lease was superseded', 'MAIL_WORKER_SUPERSEDED');
    const pending = db.prepare(`SELECT 1 FROM mail_native_intents n JOIN mail_receivers r ON r.receiver_id=n.receiver_id
      JOIN subscriptions s ON s.delivery_id=n.delivery_id AND s.consumer_id=r.consumer_id
      WHERE n.state='pending' AND s.acked=0 LIMIT 1`).get();
    if (pending) return { [NO_WRITE]: true, value: false };
    db.prepare('DELETE FROM mail_dispatch_worker WHERE id=1 AND token=?').run(token);
    return true;
  });
}

function startMailWorker(path, context) {
  if (context.mailDispatcher || context.mailReceivers || !context.registrationKey || !pendingNotifications(path).length) return;
  try {
    context.assertCurrent?.();
    const worker = readDb(path, db => db.prepare('SELECT * FROM mail_dispatch_worker WHERE id=1').get());
    if (worker?.registration_key === context.registrationKey && worker.expires_at > Date.now()) return;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)),
      Buffer.from(context.registrationKey).toString('base64url')], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AGENT_MAIL_DB_PATH: path }
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* Pending intents survive a launcher failure for the next authorized connection or send. */ }
}

function normalizeRead(args, name) {
  exact(args, name === 'inbox' ? ['target', 'consumerId', 'limit'] : ['target', 'consumerId', 'limit', 'ack', 'deliveryIds'], `${name} arguments`);
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

function observeMessages(args, context) {
  args = validateMessageObserveArgs(args);
  context.assertCurrent?.();
  const path = queuePath(), ownerId = queueOwnerId(path), moduleId = 'agent-mail';
  const scope = { kind: 'retained', ...Object.fromEntries(['correlation', 'requestId', 'deliveryId']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
  const cursorScope = { moduleId, ownerId, view: args.view, ...scope };
  const after = decodeMessageObserveCursor(args.cursor, cursorScope) ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) fail('Invalid Agent Mail observation cursor');
  const conditions = [], parameters = [];
  for (const [key, column] of [['correlation', 'correlation'], ['requestId', 'request_id'], ['deliveryId', 'delivery_id']])
    if (args[key] !== undefined) { conditions.push(`m.${column}=?`); parameters.push(args[key]); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const result = { schemaVersion: 1, moduleId, ownerId, observedAt: new Date().toISOString(), scope,
    coverage: { complete: true, limitations: ['historical_rejections_not_recorded', 'provider_delivery_not_observed'] },
    retention: { dedupeWindowMs: DEDUPE_WINDOW_MS } };
  return validateMessageObservation(readDb(path, db => {
    const project = row => {
      const contentLimit = args.view === 'items' ? 512 : 16000;
      const subscriptions = db.prepare('SELECT consumer_id,acked,acked_at FROM subscriptions WHERE delivery_id=? ORDER BY consumer_id LIMIT ?')
        .all(row.delivery_id, MAX_CONSUMERS + 1);
      if (subscriptions.length > MAX_CONSUMERS) fail('Agent Mail subscription count exceeds supported limit');
      const confirmations = subscriptions.map(subscription => ({ consumerId: subscription.consumer_id,
        confirmed: subscription.acked === 1, confirmedAt: subscription.acked === 1 ? subscription.acked_at : null }));
      const createdAt = new Date(row.created_at).toISOString();
      const events = [{ at: createdAt, kind: 'owner_accepted' }, ...confirmations.filter(subscription => subscription.confirmed)
        .map(subscription => ({ at: subscription.confirmedAt, kind: 'consumer_confirmed', detail: { consumerId: subscription.consumerId } }))]
        .sort((a, b) => a.at.localeCompare(b.at));
      const source = endpoint(JSON.parse(row.source), 'stored source');
      const reply = row.reply_to === null ? null : JSON.parse(row.reply_to);
      return { requestId: row.request_id, deliveryId: row.delivery_id, ownerId, source,
        target: { moduleId, address: row.target }, correlation: row.correlation,
        replyTo: reply === null ? null : { ownerId: id(reply.ownerId, 'replyTo.ownerId'), target: endpoint(reply.target, 'replyTo.target') },
        createdAt, updatedAt: events.at(-1).at, state: 'accepted',
        content: { status: 'available', text: row.body.slice(0, contentLimit), truncated: row.body.length > contentLimit },
        evidence: { ownerAccepted: true, providerAccepted: 'unknown',
          consumerConfirmed: confirmations.length ? confirmations.every(subscription => subscription.confirmed) : 'unknown', businessAccepted: 'unknown' },
        consumers: confirmations, trace: { status: 'available', events } };
    };
    if (args.view === 'stats') {
      const groups = db ? db.prepare(`SELECT confirmation,COUNT(*) AS count FROM
        (SELECT CASE WHEN COUNT(s.consumer_id)=0 THEN 'unknown' WHEN MIN(s.acked)=1 THEN 'confirmed' ELSE 'pending' END AS confirmation
        FROM messages m LEFT JOIN subscriptions s ON s.delivery_id=m.delivery_id WHERE ${where} GROUP BY m.delivery_id)
        GROUP BY confirmation`).all(...parameters) : [];
      const consumerConfirmed = { confirmed: 0, pending: 0, unknown: 0 };
      for (const row of groups) consumerConfirmed[row.confirmation] = row.count;
      const total = groups.reduce((sum, row) => sum + row.count, 0);
      return { ...result, stats: { total, byState: total ? { accepted: total } : {}, consumerConfirmed,
        providerAccepted: { accepted: 0, unknown: total }, businessAccepted: 'unknown' } };
    }
    const rows = db ? db.prepare(`SELECT m.* FROM messages m WHERE ${where}${args.view === 'items' ? ' AND m.seq>?' : ''}
      ORDER BY m.seq LIMIT ?`).all(...parameters, ...(args.view === 'items' ? [after] : []), args.view === 'items' ? args.limit + 1 : 2) : [];
    if (args.view === 'detail') {
      if (rows.length > 1) fail('Agent Mail detail matches multiple deliveries; supply deliveryId');
      return { ...result, item: rows.length ? project(rows[0]) : null };
    }
    const page = rows.slice(0, args.limit), hasMore = rows.length > args.limit;
    return { ...result, items: page.map(project), hasMore,
      nextCursor: hasMore ? encodeMessageObserveCursor(cursorScope, page.at(-1).seq) : null };
  }));
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
  const selected = args.deliveryIds === undefined ? null : deliveryIds(args.deliveryIds);
  if (selected && selected.length > limit) fail('Selected deliveryIds must fit the requested limit');
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
    if (selected) for (const deliveryId of selected) if (!db.prepare(`SELECT 1 FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
      WHERE m.delivery_id=? AND m.target=? AND s.consumer_id=?`).get(deliveryId, target.address, consumerId))
      fail('Selected delivery does not match this target and consumer', 'MAIL_ROUTE_CONFLICT');
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
    if (active && selected && (active.rows.length !== selected.length || active.rows.some(row => !selected.includes(row.delivery_id))))
      fail('Existing open batch differs from selected deliveries; handle that exact batch first', 'MAIL_BATCH_OPEN');
    if (!active) {
      const rows = db.prepare(`SELECT m.* FROM messages m JOIN subscriptions s ON s.delivery_id=m.delivery_id
        WHERE m.target=? AND s.consumer_id=? AND s.acked=0 AND s.batch_id=?
        ${selected ? `AND m.delivery_id IN (${selected.map(() => '?').join(',')})` : ''} ORDER BY m.seq LIMIT ?`)
        .all(target.address, consumerId, EMPTY_BATCH, ...(selected ?? []), limit);
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
  { name: 'message_observe', description: 'Read retained local message summaries, exact delivery details or statistics without fetching, confirming, consuming or dispatching messages. Historical rejected admissions are not stored.',
    inputSchema: messageObserveInputSchema, annotations: { readOnlyHint: true } },
  { name: 'register', description: 'Create a durable pull mailbox for one logical agent session. Preserve requestId across reconnects; use a new ID for an unrelated session. Same ID/label returns the same route. Does not start, authenticate or grant authority to an agent.',
    inputSchema: { type: 'object', required: ['requestId', 'label'], additionalProperties: false,
      properties: { requestId: idSchema, label: labelSchema } }, annotations: { readOnlyHint: false } },
  { name: 'contacts', description: 'Read registered routes and enrolled consumers; labels may repeat. Choose the exact address. Presence remains unknown; use receivers to inspect native availability. Reading does not wake a receiver.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      label: labelSchema, afterAddress: idSchema,
      limit: { type: 'integer', minimum: 1, maximum: 64, default: 32 }
    } }, annotations: { readOnlyHint: true } },
  { name: 'send', description: 'Persist bounded messages for explicit local recipients, then notify their trusted connected native receivers once. Native acceptance is separate from original-body fetch and consumer confirmation. Repeated request IDs do not replay a native action.',
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
      deliveryIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH, uniqueItems: true, items: idSchema,
        description: 'Optional exact retained deliveries for this consumer. Default is FIFO. A different existing open batch is rejected without changing it; exact whole-batch acknowledgement remains required.' },
      ack: { type: 'object', required: ['batchId', 'deliveryIds'], additionalProperties: false,
        description: 'Copy the exact batchId and ordered deliveryIds from this target/consumer previous fetch; never guess or partially acknowledge.',
        properties: { batchId: idSchema,
          deliveryIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: idSchema } } }
    }, additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'connect_receiver', description: 'Bind an operator-configured native receiver to a registered mailbox. Omit consumerId to create an independent consumer, or supply the existing default consumer. Bindings are immutable. Explicit deliveryIds enroll and notify only those retained deliveries; other historical mail is untouched. Starts the common dispatcher for unattempted notifications.',
    inputSchema: { type: 'object', required: ['receiverId', 'target'], additionalProperties: false,
      properties: { receiverId: idSchema, target: mailTargetSchema, consumerId: idSchema,
        deliveryIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH, uniqueItems: true, items: idSchema } } },
    annotations: { readOnlyHint: false } },
  { name: 'receivers', description: 'Read connected receiver identities and current native availability without notifying, fetching or acknowledging mail. Reachability is not consumer confirmation or human permission.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { receiverId: idSchema,
      target: mailTargetSchema, afterReceiverId: idSchema, limit: { type: 'integer', minimum: 1, maximum: 64, default: 32 } } },
    annotations: { readOnlyHint: true } },
  { name: 'deliver_pending', description: 'Notify an explicit retained delivery for a connected receiver only if no native action was attempted. Existing submitted, held, refused or unknown intents are returned without replay. Consumption still uses confirm_and_fetch and exact acknowledgement.',
    inputSchema: { type: 'object', required: ['receiverId', 'deliveryIds'], additionalProperties: false,
      properties: { receiverId: idSchema, deliveryIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH, uniqueItems: true, items: idSchema } } },
    annotations: { readOnlyHint: false } }
];

export async function describe() { return structuredClone(definitions); }
export async function call(operation, args = {}, context = {}) {
  if (operation === 'message_observe') return observeMessages(args, context);
  if (operation === 'register') return register(args, context);
  if (operation === 'contacts') return contacts(args, context);
  if (operation === 'send') return send(args, context);
  if (operation === 'inbox') return inbox(args, context);
  if (operation === 'confirm_and_fetch') return confirmAndFetch(args, context);
  if (operation === 'connect_receiver') return connectReceiver(args, context);
  if (operation === 'receivers') return receivers(args, context);
  if (operation === 'deliver_pending') return deliverPending(args, context);
  fail(`Unknown Agent Mail operation: ${operation}`);
}
