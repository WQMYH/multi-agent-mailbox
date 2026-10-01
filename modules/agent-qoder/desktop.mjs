import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const desktopInterfaces = {
  inspect: [], identity: [], list: ['listChatSessions'], models: ['listChatComposerModels'],
  search: ['searchChatSession'],
  verify_turn: ['listChatSessions', 'loadChatHistoryAround'],
  read_interactions: ['listChatSessions', 'openChatSession'],
  respond_permission: ['listChatSessions', 'openChatSession', 'respondChatInteraction'],
  send: ['listChatSessions', 'sendChatMessage'],
  send_new_session: ['listLocalWorkspaces', 'listChatSessions', 'sendChatMessage'],
  interrupt: ['listChatSessions', 'interruptChatSession']
};

// Queue state and the legacy wx marker both live under the operator's deliveryDir.
const normalizedRoot = root => root?.replaceAll('\\', '/').toLowerCase();
const normalizedQueuePath = path => {
  path = normalizedRoot(path);
  if (path.startsWith('//?/unc/')) return `//${path.slice(8)}`;
  return path.startsWith('//?/') ? path.slice(4) : path;
};
function canonicalPath(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw Error('Cannot resolve Qoder queue path identity');
    missing.unshift(basename(current)); current = parent;
  }
  return join(realpathSync.native(current), ...missing);
}
const queueFile = config => {
  if (!config.deliveryDir || !isAbsolute(config.deliveryDir)) throw Error('Absolute QODER_DELIVERY_DIR required for queue state');
  return canonicalPath(join(config.deliveryDir, 'send-queue.sqlite'));
};
const sqliteMagic = Buffer.from('SQLite format 3\0');
function rejectWalBeforeOpen(path) {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`))
    throw Error('Qoder budget requires DELETE journal mode; preserve data and migrate explicitly');
  if (!existsSync(path) || statSync(path).size < 20) return;
  const header = Buffer.alloc(20), file = openSync(path, 'r');
  try {
    if (readSync(file, header, 0, header.length, 0) === header.length &&
        header.subarray(0, 16).equals(sqliteMagic) && (header[18] === 2 || header[19] === 2))
      throw Error('Qoder budget requires DELETE journal mode; preserve data and migrate explicitly');
  } finally { closeSync(file); }
}
export const queueOwnerId = config => `qoder-queue:${createHash('sha256')
  .update(normalizedQueuePath(queueFile(config))).digest('hex').slice(0, 32)}`;
const deliveryId = requestId => `qoder-delivery:${requestId}`;
const budgetError = result => Object.assign(Error(`Qoder message budget blocked: ${result.reason ?? 'budget_conflict'} (${result.deltaBytes ?? 0} bytes)`), {
  code: 'QODER_BUDGET_BLOCKED', budget: result
});
const markerText = row => JSON.stringify({ sessionId: row.session_id, workspaceId: row.workspace_id,
  createdAt: row.created_at, state: 'reserved-outcome-unknown' });
function managedBytes(config, db) {
  const path = queueFile(config), directory = dirname(path);
  const names = new Set([path, `${path}-wal`, `${path}-shm`, `${path}-journal`]);
  if (existsSync(directory)) for (const name of readdirSync(directory))
    if (name.endsWith('.json')) names.add(join(directory, name));
  let bytes = 0;
  for (const name of names) if (existsSync(name)) bytes += statSync(name).size;
  if (db && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends'").get())
    for (const row of db.prepare("SELECT request_id,session_id,workspace_id,created_at FROM sends WHERE state IN ('queued','dispatching')").all())
      bytes += Buffer.byteLength(markerText(row)); // Reserve even while a concurrent marker write is incomplete.
  return bytes;
}
function checkBudget(config, context, db, additionalBytes = 0, peak = false) {
  const ownerId = queueOwnerId(config), status = context.messageBudget?.status?.();
  if (!status) throw budgetError({ reason: 'budget_not_configured', deltaBytes: additionalBytes });
  if (peak) {
    const path = queueFile(config), size = existsSync(path) ? statSync(path).size : 0;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pages = Math.max(db.prepare('PRAGMA page_count').get().page_count, Math.ceil(size / pageSize));
    // DELETE journal + no cache spill: each old page occurs once (pageSize+8).
    // Reserve all projected pages, plus two maximum 64KiB sectors for header/padding.
    // ponytail: full-copy journal reserve trades about half the quota for a simple peak bound.
    additionalBytes += pages * pageSize - size + pages * (pageSize + 8) + 2 * 65536;
  }
  const result = context.messageBudget?.check?.({ ownerId, usedBytes: managedBytes(config, db), additionalBytes });
  if (!result?.ok) throw budgetError(result ?? { reason: 'budget_check_unavailable', deltaBytes: additionalBytes });
  return result;
}
const receiptFields = (row, config) => ({ deliveryId: deliveryId(row.request_id ?? row.requestId),
  ownerId: queueOwnerId(config), correlation: row.correlation ?? row.request_id ?? row.requestId,
  nativeAck: row.native_ack === 1 || row.nativeAck === true });
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The native history groups complete messages by turn. A streamed assistant can already
// say "completed" at message_stop; only the final root text ID marks a completed turn.
export function verifyNativeTurn(history, requestId) {
  const messages = history?.messages;
  if (!Array.isArray(messages) || messages.length > 500) return null;
  const ids = new Set();
  for (const message of messages) {
    if (!message || typeof message.id !== 'string' || ids.has(message.id)) return null;
    ids.add(message.id);
  }
  const roots = messages.filter(message => message.role === 'user' && message.id === requestId &&
    message.turnId === requestId && message.status === 'completed');
  const assistants = messages.filter(message => message.role === 'assistant' && message.turnId === requestId);
  const final = assistants.find(message => message.id === `assistant:${requestId}`);
  if (roots.length !== 1 || !final || assistants.filter(message => message.id === final.id).length !== 1 ||
      assistants.some(message => message !== final && message.finalTextId) ||
      messages.some(message => message.turnId === requestId && message.role === 'user' && message.id !== requestId)) return null;
  const rootIndex = messages.indexOf(roots[0]), finalIndex = messages.indexOf(final);
  if (finalIndex <= rootIndex || messages.slice(rootIndex + 1, finalIndex)
      .some(message => message.role === 'user' && message.id !== requestId) ||
      messages.slice(finalIndex + 1).some(message => message.turnId === requestId)) return null;
  if (!['completed', 'failed', 'interrupted'].includes(final.status) ||
      typeof final.completedAt !== 'string' || !Number.isFinite(Date.parse(final.completedAt)) ||
      !Array.isArray(final.parts) || final.parts.length > 500 ||
      final.parts.some(part => part?.type === 'tool' && !['completed', 'failed'].includes(part.toolStatus))) return null;
  if (final.status === 'completed') {
    const textParts = final.parts.filter(part => part?.id === final.finalTextId &&
      part.type === 'text' && !part.parentToolUseId);
    const textIndex = final.parts.indexOf(textParts[0]);
    if (typeof final.finalTextId !== 'string' || textParts.length !== 1 ||
        final.parts.slice(textIndex + 1).some(part => ['text', 'tool'].includes(part?.type) && !part.parentToolUseId)) return null;
  }
  return { nativeInputId: roots[0].id, nativeTurnId: final.turnId,
    assistantId: final.id, terminalOutcome: final.status };
}
const safeDesktopErrors = new Set([
  'Desktop not ready', 'Interaction scope changed', 'Interaction snapshot too large',
  'Invalid decision', 'Permission expired or unsupported', 'Reviewed permission changed',
  'Task scope changed', 'Task busy', 'Current model unavailable', 'Workspace scope changed',
  'Task lookup failed', 'Session ID already exists', 'Task lookup incomplete',
  'Unverified product',
  ...['getStartupState', ...new Set(Object.values(desktopInterfaces).flat())]
    .map(name => `Missing desktop interface: ${name}`)
]);
const desktopRejection = message => {
  const raw = message.result?.exceptionDetails?.exception?.description ??
    message.result?.exceptionDetails?.text ?? message.error?.message ?? '';
  const line = String(raw).split(/\r?\n/, 1)[0]
    .replace(/^Uncaught(?: \(in promise\))?\s*/u, '').replace(/^Error:\s*/u, '').trim();
  const detail = safeDesktopErrors.has(line) ? line : undefined;
  return Error(`Desktop rejected operation${detail ? `: ${detail}` : ''}`);
};
const watchers = new Map();
const assertActive = context => { context.assertCurrent?.(); context.assertLease?.(); };
const watchKey = (config, sessionId, context) => JSON.stringify([
  normalizedRoot(queueFile(config)), sessionId.toLowerCase(), context.registrationKey ?? 'direct'
]);
const scoped = (args, config) => {
  if (!args.sessionId || !args.workspaceId || !args.cwd ||
      args.workspaceId.toLowerCase() !== config.workspaceId?.toLowerCase() ||
      normalizedRoot(args.cwd) !== normalizedRoot(config.root))
    throw Error('Operator scope changed');
};
function withQueue(config, write, action, context = {}) {
  const path = queueFile(config);
  if (write) checkBudget(config, context, null);
  rejectWalBeforeOpen(path); // Header bytes 18/19 identify WAL without creating -shm/-wal.
  if (!write && !existsSync(path)) return action(null);
  if (write) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='queue_meta'").get();
    const meta = hasMeta && db.prepare('SELECT owner_id,queue_path FROM queue_meta WHERE id=1').get();
    if (meta && (meta.owner_id !== queueOwnerId(config) || meta.queue_path !== normalizedQueuePath(path)))
      throw Error('Qoder queue owner identity changed');
    if (!write) return action(db);
    // Never silently convert a WAL database. The peak proof requires one DELETE
    // journal, no attached databases/savepoints, and no dirty-page spill before COMMIT.
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete')
      throw Error('Qoder budget requires DELETE journal mode; preserve data and migrate explicitly');
    if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 0)
      throw Error('Qoder budget requires auto_vacuum=NONE; preserve data and migrate explicitly');
    db.exec('PRAGMA cache_spill=OFF; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL');
    if (db.prepare('PRAGMA cache_spill').get().cache_spill !== 0 ||
        db.prepare('PRAGMA temp_store').get().temp_store !== 2)
      throw Error('Qoder SQLite peak controls unavailable');
    checkBudget(config, context, db, 0, true); // BEGIN itself may create an initial journal.
    db.exec('BEGIN IMMEDIATE');
    try {
      checkBudget(config, context, db, 0, true); // BEFORE schema or DML can grow the journal.
      const result = action(db);
      checkBudget(config, context, db, 0, true); // Includes dirty pages not visible to stat().
      db.exec('COMMIT');
      return result;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
export function reservePermission(config, context, key, text) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw Error('Invalid Qoder permission reservation key');
  const path = join(dirname(queueFile(config)), `permission-${key}.json`);
  if (existsSync(path)) return false;
  return withQueue(config, true, db => {
    if (existsSync(path)) return false;
    ensureOwner(db, config);
    checkBudget(config, context, db, Buffer.byteLength(text), true);
    let file;
    try {
      file = openSync(path, 'wx');
      writeFileSync(file, text);
      fsyncSync(file);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally { if (file !== undefined) closeSync(file); }
    return true;
  }, context);
}
function ensureOwner(db, config) {
  db.exec(`CREATE TABLE IF NOT EXISTS queue_meta (
    id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, queue_path TEXT NOT NULL
  )`);
  const ownerId = queueOwnerId(config), path = normalizedQueuePath(queueFile(config));
  const meta = db.prepare('SELECT owner_id,queue_path FROM queue_meta WHERE id=1').get();
  if (meta && (meta.owner_id !== ownerId || meta.queue_path !== path)) throw Error('Qoder queue owner identity changed');
  if (!meta) db.prepare('INSERT INTO queue_meta(id,owner_id,queue_path) VALUES(1,?,?)').run(ownerId, path);
}
function ensureSchema(db, config) {
  db.exec(`CREATE TABLE IF NOT EXISTS sends (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    prompt TEXT NOT NULL,
    operation TEXT,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','dispatching','awaiting_observation','needs_attention')),
    native_ack INTEGER NOT NULL DEFAULT 0,
    terminal_outcome TEXT,
    observed_at TEXT,
    correlation TEXT,
    created_at TEXT NOT NULL
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(sends)').all().map(column => column.name));
  if (!columns.has('operation')) db.exec('ALTER TABLE sends ADD COLUMN operation TEXT');
  if (!columns.has('terminal_outcome')) db.exec('ALTER TABLE sends ADD COLUMN terminal_outcome TEXT');
  if (!columns.has('observed_at')) db.exec('ALTER TABLE sends ADD COLUMN observed_at TEXT');
  if (!columns.has('correlation')) db.exec('ALTER TABLE sends ADD COLUMN correlation TEXT');
  db.exec('UPDATE sends SET correlation=request_id WHERE correlation IS NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS worker (
    id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, registration_key TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  ); INSERT OR IGNORE INTO worker(id) VALUES(1)`);
  ensureOwner(db, config);
}
function reserve(args, config, operation, context) {
  scoped(args, config);
  const requestId = args.requestId.toLowerCase(), sessionId = args.sessionId.toLowerCase();
  const correlation = args.correlation ?? requestId;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    sessionId, config.workspaceId.toLowerCase(), normalizedRoot(config.root), args.prompt, correlation,
    ...(operation === 'send_new_session' ? [operation] : [])
  ])).digest('hex');
  const legacyFingerprint = createHash('sha256').update(JSON.stringify([
    sessionId, config.workspaceId.toLowerCase(), normalizedRoot(config.root), args.prompt,
    ...(operation === 'send_new_session' ? [operation] : [])
  ])).digest('hex');
  const deduplicated = prior => {
    if (prior.fingerprint !== fingerprint && prior.fingerprint !== legacyFingerprint ||
        prior.correlation !== undefined && prior.correlation !== null && prior.correlation !== correlation)
      throw Error('Request ID conflicts with an existing queued send');
    return { requestId, state: prior.state, claimed: false, deduplicated: true,
      ...receiptFields(prior, config) };
  };
  const existing = withQueue(config, false, db => db &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends'").get()
      ? db.prepare('SELECT * FROM sends WHERE request_id=?').get(requestId) : undefined);
  if (existing) return deduplicated(existing);
  checkBudget(config, context, null, Buffer.byteLength(args.prompt) + 8192);
  return withQueue(config, true, db => {
    ensureSchema(db, config);
    const prior = db.prepare('SELECT * FROM sends WHERE request_id=?').get(requestId);
    if (prior) return deduplicated(prior);
    if (db.prepare('SELECT COUNT(*) AS n FROM sends').get().n >= 500) throw Error('Qoder queue capacity reached');
    const createdAt = new Date().toISOString();
    const seq = db.prepare(`INSERT INTO sends(request_id,session_id,workspace_id,cwd,prompt,operation,fingerprint,state,correlation,created_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(requestId, sessionId, config.workspaceId.toLowerCase(), normalizedRoot(config.root), args.prompt, operation, fingerprint, correlation, createdAt).lastInsertRowid;
    const head = db.prepare(`SELECT seq FROM sends WHERE session_id=? AND observed_at IS NULL ORDER BY seq LIMIT 1`).get(sessionId);
    const claimed = head.seq === seq;
    if (claimed) db.prepare("UPDATE sends SET state='dispatching' WHERE seq=?").run(seq);
    return { requestId, request_id: requestId, session_id: sessionId, workspace_id: config.workspaceId.toLowerCase(),
      cwd: normalizedRoot(config.root), prompt: args.prompt, operation, correlation, created_at: createdAt,
      seq: Number(seq), state: claimed ? 'dispatching' : 'queued', claimed, deduplicated: false,
      ...receiptFields({ request_id: requestId, correlation }, config) };
  }, context);
}
function claimNext(config, sessionId, context) {
  return withQueue(config, true, db => {
    ensureSchema(db, config);
    const row = db.prepare(`SELECT * FROM sends WHERE session_id=? AND observed_at IS NULL ORDER BY seq LIMIT 1`).get(sessionId.toLowerCase());
    if (!row || row.state !== 'queued' || !['send','send_new_session'].includes(row.operation)) return null;
    if (row.workspace_id !== config.workspaceId.toLowerCase() || normalizedRoot(row.cwd) !== normalizedRoot(config.root)) return null;
    db.prepare("UPDATE sends SET state='dispatching' WHERE seq=? AND state='queued'").run(row.seq);
    return { ...row, state: 'dispatching' };
  }, context);
}
function finish(config, requestId, nativeAck, context) {
  withQueue(config, true, db => db.prepare(`UPDATE sends SET state=?,native_ack=?
    WHERE request_id=? AND state='dispatching'`).run(
      nativeAck ? 'awaiting_observation' : 'needs_attention', nativeAck ? 1 : 0, requestId), context);
}
function observe(config, requestId, outcome, context) {
  withQueue(config, true, db => db.prepare(`UPDATE sends SET terminal_outcome=?,observed_at=?
    WHERE request_id=? AND state='awaiting_observation' AND observed_at IS NULL`).run(
      outcome, new Date().toISOString(), requestId), context);
}
async function reconcileHead(args, config, context) {
  assertActive(context);
  const row = withQueue(config, false, db => db?.prepare(`SELECT request_id,state,workspace_id,cwd FROM sends
    WHERE session_id=? AND observed_at IS NULL ORDER BY seq LIMIT 1`).get(args.sessionId.toLowerCase()));
  if (!row || row.state !== 'awaiting_observation') return { status: row?.state ?? 'empty' };
  if (row.workspace_id !== config.workspaceId.toLowerCase() || normalizedRoot(row.cwd) !== normalizedRoot(config.root))
    return { status: 'scope-changed' };
  const result = await nativeDesktop('verify_turn', { sessionId: args.sessionId, requestId: row.request_id,
    workspaceId: config.workspaceId, cwd: config.root }, config, context);
  assertActive(context);
  const proof = verifyNativeTurn(result?.value, row.request_id);
  if (!proof)
    return { status: 'not-terminal', requestId: row.request_id };
  observe(config, row.request_id, proof.terminalOutcome, context);
  return { status: 'observed', requestId: row.request_id, terminalOutcome: proof.terminalOutcome };
}
function queueStatus(args, config, context) {
  scoped(args, config);
  const items = withQueue(config, false, db => {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends'").get()) return [];
    const columns = new Set(db.prepare('PRAGMA table_info(sends)').all().map(column => column.name));
    const correlation = columns.has('correlation') ? 'correlation' : 'request_id AS correlation';
    return db.prepare(`SELECT seq,request_id,cwd,state,native_ack,terminal_outcome,observed_at,${correlation},created_at FROM sends
      WHERE session_id=? AND workspace_id=? ORDER BY seq`).all(
        args.sessionId.toLowerCase(), config.workspaceId.toLowerCase())
      .filter(item => normalizedRoot(item.cwd) === normalizedRoot(config.root));
  });
  const ownerId = queueOwnerId(config);
  let budget;
  try { budget = context.messageBudget?.status?.() ? context.messageBudget.check({
    ownerId, usedBytes: withQueue(config, false, db => managedBytes(config, db)), additionalBytes: 0
  }) : { ok: false, ownerId, reason: 'budget_not_configured', deltaBytes: 0 }; }
  catch (error) { budget = { ok: false, ownerId, reason: 'budget_check_failed', detail: error.message }; }
  return { sessionId: args.sessionId, ownerId, budget,
    needsAttention: items.some(item => item.state === 'needs_attention'),
    items: items.map(item => ({ seq: item.seq, requestId: item.request_id, ...receiptFields(item, config),
      state: item.observed_at ? 'observed' : item.state, ...(item.state === 'dispatching' ? { liveness: 'unknown' } : {}),
      nativeAck: item.native_ack === 1, terminalOutcome: item.terminal_outcome,
      observedAt: item.observed_at, createdAt: item.created_at })) };
}

// Product-checked internal desktop bridge. Only fixed business operations reach CDP.
async function nativeDesktop(operation, args = {}, config = {}, context = {}) {
  assertActive(context);
  const interactionRead = `
    if(s.status!=='ready')throw Error('Desktop not ready');
    const scoped=t=>{
      if(!t||t.sessionId!==a.sessionId||t.workspaceId!==a.workspaceId||
        t.cwd.replaceAll('\\\\','/').toLowerCase()!==a.cwd.replaceAll('\\\\','/').toLowerCase()||
        t.runtimeProfileId!=='runtime:qoder'||t.executionKind!=='local'||t.archived)throw Error('Interaction scope changed');
    };
    scoped((await d.listChatSessions(100,0,false)).find(t=>t.sessionId===a.sessionId));
    const detail=await d.openChatSession(a.sessionId);scoped(detail.summary);
    const snapshot=p=>{
      const text=JSON.stringify({sessionId:a.sessionId,workspaceId:a.workspaceId,cwd:detail.summary.cwd,
        activeTurnId:detail.activeTurn?.turnId??null,type:p.type,toolUseId:p.toolUseId,toolName:p.toolName,input:p.input,requestedAt:p.requestedAt});
      if(text.length>65536)throw Error('Interaction snapshot too large');return text;
    };
  `;
  const calls = {
    inspect: `return {url:location.href,editors:[...document.querySelectorAll('[contenteditable],input,textarea')].map(e=>({label:e.getAttribute('aria-label'),text:e.value||e.innerText||'',empty:e.getAttribute('data-empty')}))};`,
    identity: 'return {startupStatus:s.status};',
    list: 'return await d.listChatSessions(a.limit,a.offset,false);',
    models: "return await d.listChatComposerModels({runtimeProfileId:'runtime:qoder',fetchStrategy:a.fetchStrategy,workspaceDirectories:a.workspaceDirectories,executionHostKind:'local'});",
    search: 'return await d.searchChatSession(a.sessionId,a.query,a.limit);',
    verify_turn: `const t=(await d.listChatSessions(100,0,false)).find(t=>t.sessionId===a.sessionId);
      if(!t||t.workspaceId!==a.workspaceId||t.cwd.replaceAll('\\\\','/').toLowerCase()!==a.cwd.replaceAll('\\\\','/').toLowerCase()||t.runtimeProfileId!=='runtime:qoder'||t.executionKind!=='local'||t.archived)throw Error('Task scope changed');
      if(t.runtimeState==='running'||t.pendingInteractionCount>0)return {messages:[]};
      const history=await d.loadChatHistoryAround(a.sessionId,t.cwd,a.requestId,10,9);
      if(!history||!Array.isArray(history.messages)||history.messages.length>500)return {messages:[]};
      const messages=history.messages.map(m=>({id:m.id,role:m.role,turnId:m.turnId,status:m.status,
        completedAt:m.completedAt,finalTextId:m.finalTextId,
        parts:Array.isArray(m.parts)&&m.parts.length<=500?m.parts.map(p=>({id:p.id,type:p.type,
          parentToolUseId:p.parentToolUseId??p.tool?.parentToolUseId,toolStatus:p.tool?.status})):null}));
      return {messages:JSON.stringify(messages).length<=65536?messages:[]};`,
    read_interactions: `${interactionRead}
      return {scope:{sessionId:a.sessionId,workspaceId:a.workspaceId,cwd:detail.summary.cwd},
        runtimeState:detail.summary.runtimeState,activeTurnId:detail.activeTurn?.turnId??null,
        pendingInteractions:detail.pendingInteractions.map(p=>({...p,expectedSnapshot:snapshot(p)}))};`,
    respond_permission: `${interactionRead}
      if(!['allow','deny'].includes(a.decision))throw Error('Invalid decision');
      const pending=detail.pendingInteractions.find(p=>p.toolUseId===a.toolUseId);
      const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
      const ordinary=pending&&['Read','Write','Edit','MultiEdit','Bash','PowerShell','Glob','Grep','LS'].includes(pending.toolName)&&object(pending.input);
      const mcpTools=new Set(['mcp__plugin_qoder-codex-bridge_qoder-codex-bridge__list_codex_tasks','mcp__plugin_qoder-codex-bridge_qoder-codex-bridge__select_codex_task','mcp__plugin_qoder-codex-bridge_qoder-codex-bridge__send_codex_message']);
      const mcp=pending?.toolName==='mcp_call'&&object(pending.input)&&Object.keys(pending.input).length===2&&
        Object.hasOwn(pending.input,'arguments')&&object(pending.input.arguments)&&Object.hasOwn(pending.input,'toolName')&&
        typeof pending.input.toolName==='string'&&mcpTools.has(pending.input.toolName);
      if(!pending||pending.type!=='permission'||!ordinary&&!mcp||!pending.requestedAt||!detail.activeTurn?.turnId)throw Error('Permission expired or unsupported');
      if(snapshot(pending)!==a.expectedSnapshot)throw Error('Reviewed permission changed');
      await d.respondChatInteraction({type:'permission',sessionId:a.sessionId,toolUseId:a.toolUseId,decision:a.decision});
      return {acknowledged:true,sessionId:a.sessionId,toolUseId:a.toolUseId,decision:a.decision,completion:'unknown'};`,
    send: `const t=(await d.listChatSessions(100,0,false)).find(t=>t.sessionId===a.sessionId);
      if(!t||t.workspaceId!==a.workspaceId||t.cwd.replaceAll('\\\\','/').toLowerCase()!==a.cwd.replaceAll('\\\\','/').toLowerCase()||t.runtimeProfileId!=='runtime:qoder'||t.executionKind!=='local')throw Error('Task scope changed');
      if(t.runtimeState==='running'||t.pendingInteractionCount>0)throw Error('Task busy');
      if(t.model!==null){
        if(typeof d.listChatComposerModels!=='function')throw Error('Missing desktop interface: listChatComposerModels');
        const models=await d.listChatComposerModels({runtimeProfileId:'runtime:qoder',fetchStrategy:'live',workspaceDirectories:[t.cwd],executionHostKind:'local'});
        if(t.model===undefined||!models.some(m=>m.key===t.model&&m.enabled===true))throw Error('Current model unavailable');
      }
      await d.sendChatMessage({sessionId:t.sessionId,agentId:'agent:default',workspaceId:t.workspaceId,cwd:t.cwd,productMode:t.productMode,executionKind:'local',
        ...(t.model===null?{}:{model:t.model}),...(t.permissionMode===null?{}:{permissionMode:t.permissionMode}),prompt:a.prompt,inputId:a.requestId,turnId:a.requestId});
      return {accepted:true,requestId:a.requestId,sessionId:t.sessionId,model:t.model};`,
    send_new_session: `if(s.status!=='ready')throw Error('Desktop not ready');
      const root=t=>t.replaceAll('\\\\','/').toLowerCase();
      const w=(await d.listLocalWorkspaces()).find(t=>t.workspaceId===a.workspaceId);
      if(!w||w.archived||!Array.isArray(w.rootPaths)||!w.rootPaths.some(t=>root(t)===root(a.cwd)))throw Error('Workspace scope changed');
      for(const archived of [false,true])for(let offset=0;offset<=10000;offset+=100){
        const page=await d.listChatSessions(100,offset,archived);
        if(!Array.isArray(page))throw Error('Task lookup failed');
        if(page.some(t=>t.sessionId===a.sessionId))throw Error('Session ID already exists');
        if(page.length<100)break;
        if(offset===10000)throw Error('Task lookup incomplete');
      }
      await d.sendChatMessage({sessionId:a.sessionId,agentId:'agent:default',workspaceId:a.workspaceId,cwd:a.cwd,
        productMode:'coding',executionKind:'local',prompt:a.prompt,inputId:a.requestId,turnId:a.requestId});
      return {accepted:true,requestId:a.requestId,sessionId:a.sessionId};`,
    interrupt: `const t=(await d.listChatSessions(100,0,false)).find(t=>t.sessionId===a.sessionId);
      if(!t||t.workspaceId!==a.workspaceId||t.cwd.replaceAll('\\\\','/').toLowerCase()!==a.cwd.replaceAll('\\\\','/').toLowerCase())throw Error('Task scope changed');
      await d.interruptChatSession(t.sessionId);return {requested:true,sessionId:t.sessionId};`
  };
  if (!Object.hasOwn(calls, operation)) throw Error('Unsupported desktop operation');
  if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1 || config.cdpPort > 65535) throw Error('Explicit local cdpPort required (operator file or QODER_DESKTOP_CDP_PORT)');
  const port = String(config.cdpPort);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error(`CDP discovery HTTP ${response.status}`);
  const pages = await response.json();
  if (!Array.isArray(pages)) throw Error('Invalid CDP targets');
  const targets = pages.filter(p => p.type === 'page' && typeof p.url === 'string' && p.url.startsWith('qoder-cn-app://renderer/index.html'));
  if (targets.length !== 1) throw Error('Expected one Qoder CN renderer');
  const page = new URL(targets[0].url), endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (page.host !== 'renderer' || page.pathname !== '/index.html' || page.username || page.password ||
      endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/devtools\/page\/[^/]+$/.test(endpoint.pathname)) throw Error('Unexpected local desktop target');
  // ponytail: each CDP connection is bounded and one-shot; the queue watcher owns polling.
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.href);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Desktop operation timeout; outcome unknown, do not retry mutations')), 20000);
    socket.addEventListener('error', () => finish(Error('Desktop transport failed; outcome unknown')));
    socket.addEventListener('close', () => finish(Error('Desktop transport closed; outcome unknown')));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) throw desktopRejection(message);
        const result = message.result?.result?.value;
        if (result?.identity?.productId !== 'qoder-cn') throw Error('Invalid desktop result');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    socket.addEventListener('open', () => {
      const expression = `(async()=>{const d=window.qoderDesktop,a=${JSON.stringify(args)};
        if(typeof d?.getStartupState!=='function')throw Error('Missing desktop interface: getStartupState');
        const s=await d.getStartupState();if(s?.productId!=='qoder-cn')throw Error('Unverified product');
        for(const name of ${JSON.stringify(desktopInterfaces[operation])})if(typeof d[name]!=='function')throw Error('Missing desktop interface: '+name);
        let version=null;try{const v=typeof d.getProductUpdateState==='function'?(await d.getProductUpdateState())?.currentVersion:null;
          if(typeof v==='string')version=v.slice(0,128);}catch{}
        return {identity:{productId:s.productId,version},value:await(async()=>{${calls[operation]}})()};})()`;
      try {
        // Last host-side check: revocation cannot retract an already-sent CDP operation.
        assertActive(context);
        socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
      }
      catch (error) { finish(error); }
    });
  });
}

function verifiedRow(args, config) {
  if (!args || typeof args.requestId !== 'string' || typeof args.sessionId !== 'string' ||
      !requestIdPattern.test(args.requestId) || !requestIdPattern.test(args.sessionId) ||
      args.deliveryId !== deliveryId(args.requestId)) return null;
  const row = withQueue(config, false, db => db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends'").get()
    ? db.prepare('SELECT * FROM sends WHERE request_id=?').get(args.requestId) : null);
  return row?.session_id === args.sessionId && row.workspace_id === config.workspaceId?.toLowerCase() &&
    normalizedRoot(row.cwd) === normalizedRoot(config.root) && row.state === 'awaiting_observation' &&
    row.native_ack === 1 && row.observed_at && ['send', 'send_new_session'].includes(row.operation) &&
    ['completed', 'failed', 'interrupted'].includes(row.terminal_outcome) ? row : null;
}

export async function observeVerifiedTurn(args, config, context = {}) {
  assertActive(context);
  const row = verifiedRow(args, config);
  if (!row) return null;
  const result = await nativeDesktop('verify_turn', { sessionId: row.session_id, requestId: row.request_id,
    workspaceId: config.workspaceId, cwd: config.root }, config, context);
  assertActive(context);
  const proof = verifyNativeTurn(result.value, row.request_id);
  const current = verifiedRow(args, config);
  if (!proof || !current || current.observed_at !== row.observed_at ||
      proof.terminalOutcome !== current.terminal_outcome) return null;
  return { ownerId: queueOwnerId(config), deliveryId: args.deliveryId, requestId: row.request_id,
    workspaceId: config.workspaceId, sessionId: row.session_id,
    canonicalCwd: realpathSync.native(resolve(config.root)), ...proof,
    evidenceSource: 'qoder-cn:normalized-history', productVersion: result.identity.version };
}

async function projectVerifiedReturns(config, context) {
  if (config.returnModulePath === undefined && config.returnDataDir === undefined) return [];
  if (!isAbsolute(config.returnModulePath ?? '') || !isAbsolute(config.returnDataDir ?? '') ||
      basename(config.returnModulePath) !== 'native-turn-return.mjs') throw Error('Invalid Qoder return integration path');
  assertActive(context);
  const { reconcileVerifiedReturns } = await import(pathToFileURL(config.returnModulePath).href);
  if (typeof reconcileVerifiedReturns !== 'function') throw Error('Qoder return integration unavailable');
  assertActive(context);
  const result = await reconcileVerifiedReturns({ dataDir: config.returnDataDir,
    scope: { ownerId: queueOwnerId(config), workspaceId: config.workspaceId,
      canonicalCwd: realpathSync.native(resolve(config.root)) },
    observeTurn: args => observeVerifiedTurn(args, config, context),
    assertActive: () => assertActive(context) });
  assertActive(context);
  if (!Array.isArray(result)) throw Error('Qoder return integration result invalid');
  return result;
}

function hasObservedPendingReturn(config, results, sessionId) {
  const pending = results.filter(result => result?.state === 'nonterminal');
  if (!pending.length) return false;
  return withQueue(config, false, db => {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends'").get()) return false;
    const lookup = db.prepare('SELECT session_id FROM sends WHERE request_id=? AND native_ack=1 AND observed_at IS NOT NULL');
    return pending.some(result => {
      const row = lookup.get(result.requestId);
      return row && (!sessionId || row.session_id === sessionId);
    });
  });
}

async function dispatchClaimed(claimed, config, context) {
  try {
    assertActive(context);
    writeFileSync(join(dirname(queueFile(config)), `${claimed.request_id}.json`), markerText(claimed), { flag: 'wx' });
  } catch (error) {
    finish(config, claimed.request_id, false, context);
    if (error.code === 'EEXIST') return { requestId: claimed.request_id, delivery: 'not-resent',
      queueState: 'needs_attention', completion: 'unknown', ...receiptFields(claimed, config) };
    throw error;
  }
  let result, error;
  try { result = await nativeDesktop(claimed.operation, { sessionId: claimed.session_id,
    requestId: claimed.request_id, prompt: claimed.prompt, workspaceId: config.workspaceId, cwd: config.root }, config, context); }
  catch (cause) { error = cause; }
  finish(config, claimed.request_id, !!result?.value?.accepted, context);
  if (error) throw error;
  return { ...result, requestId: claimed.request_id,
    queueState: result?.value?.accepted ? 'awaiting_observation' : 'needs_attention', completion: 'unknown',
    ...receiptFields({ ...claimed, native_ack: result?.value?.accepted ? 1 : 0 }, config) };
}

function watchState(config, sessionId) {
  return withQueue(config, false, db => {
    if (!db) return null;
    const rows = db.prepare(`SELECT state,operation,workspace_id,cwd FROM sends
      WHERE session_id=? AND observed_at IS NULL ORDER BY seq`).all(sessionId.toLowerCase());
    const head = rows[0];
    if (!head || !['queued','awaiting_observation'].includes(head.state) ||
        (head.state === 'queued' && !['send','send_new_session'].includes(head.operation))) return null;
    if (head.workspace_id !== config.workspaceId.toLowerCase() || normalizedRoot(head.cwd) !== normalizedRoot(config.root))
      return null;
    return head.state;
  });
}

function watchQueue(args, config, context) {
  assertActive(context);
  const key = watchKey(config, args.sessionId, context);
  if (watchers.has(key)) return;
  const fixed = { ...config }, sessionId = args.sessionId.toLowerCase();
  if (watchState(fixed, sessionId) === null) return;
  const run = async () => {
    let pendingReturn = false;
    try {
      assertActive(context);
      const state = watchState(fixed, sessionId);
      if (state === 'awaiting_observation') {
        const observation = await reconcileHead({ sessionId }, fixed, context);
        if (observation.status === 'scope-changed') return watchers.delete(key);
        if (observation.status === 'observed') {
          assertActive(context);
          const claimed = claimNext(fixed, sessionId, context);
          if (claimed) await dispatchClaimed(claimed, fixed, context);
        }
      } else if (state === 'queued') {
        assertActive(context);
        const claimed = claimNext(fixed, sessionId, context);
        if (claimed) await dispatchClaimed(claimed, fixed, context);
      }
    } catch (error) {
      if (error.code === 'QODER_BUDGET_BLOCKED') return watchers.delete(key);
      // A failed read may be polled again; a failed dispatch keeps its reservation.
    }
    try {
      const projected = await projectVerifiedReturns(fixed, context);
      pendingReturn = hasObservedPendingReturn(fixed, projected, sessionId);
    } catch { /* An explicit recover_queue may retry a failed return projection. */ }
    try {
      assertActive(context);
      if (watchState(fixed, sessionId) === null && !pendingReturn) return watchers.delete(key);
    } catch { return watchers.delete(key); }
    // No immediate rearm: blocked heads stop; other progress checks remain bounded.
    const timer = setTimeout(run, 1000); timer.unref?.(); watchers.set(key, timer);
  };
  const timer = setTimeout(run, 0); timer.unref?.(); watchers.set(key, timer);
}

export function claimWorker(config, context, token, now = Date.now()) {
  if (!existsSync(queueFile(config))) return false;
  return withQueue(config, true, db => {
    ensureSchema(db, config);
    const row = db.prepare('SELECT token,registration_key,lease_until FROM worker WHERE id=1').get();
    const registrationKey = context.registrationKey;
    if (!registrationKey) throw Error('Qoder recovery requires an agent-core registration context');
    if (row.token && row.lease_until > now && row.registration_key === registrationKey) return false;
    db.prepare('UPDATE worker SET token=?,registration_key=?,lease_until=? WHERE id=1')
      .run(token, registrationKey, now + 60_000);
    return true;
  }, context);
}

export function renewWorker(config, token, now = Date.now(), context = {}) {
  return withQueue(config, true, db => db.prepare('UPDATE worker SET lease_until=? WHERE id=1 AND token=?')
    .run(now + 60_000, token).changes === 1, context);
}

export function releaseWorker(config, token, context = {}) {
  if (!existsSync(queueFile(config))) return;
  withQueue(config, true, db => db.prepare("UPDATE worker SET token=NULL,registration_key=NULL,lease_until=0 WHERE id=1 AND token=?").run(token), context);
}

export async function runQueueCycle(config, context) {
  assertActive(context);
  const sessions = withQueue(config, false, db => db ? db.prepare(`SELECT DISTINCT session_id FROM sends
    WHERE observed_at IS NULL ORDER BY session_id`).all().map(row => row.session_id) : []);
  let activeSessions = 0, progressed = 0;
  for (const sessionId of sessions) {
    assertActive(context);
    const state = watchState(config, sessionId);
    if (state === null) continue;
    activeSessions++;
    try {
      if (state === 'awaiting_observation') {
        const observation = await reconcileHead({ sessionId }, config, context);
        if (observation.status === 'observed') {
          progressed++;
          const claimed = claimNext(config, sessionId, context);
          if (claimed) { await dispatchClaimed(claimed, config, context); progressed++; }
        }
      } else {
        const claimed = claimNext(config, sessionId, context);
        if (claimed) { await dispatchClaimed(claimed, config, context); progressed++; }
      }
    } catch (error) {
      if (error.code === 'QODER_BUDGET_BLOCKED') throw error;
      assertActive(context);
    }
  }
  const projected = await projectVerifiedReturns(config, context);
  return { activeSessions: activeSessions + Number(hasObservedPendingReturn(config, projected)),
    progressed: progressed + projected.filter(result => result?.state === 'accepted').length };
}

export async function desktop(operation, args = {}, config = {}, context = {}) {
  assertActive(context);
  if (operation === 'queue_status') return queueStatus(args, config, context);
  if (operation !== 'send' && operation !== 'send_new_session') return nativeDesktop(operation, args, config, context);
  const item = reserve(args, config, operation, context);
  let claimed = item.claimed ? item : null, observation;
  if (!claimed) {
    try { observation = await reconcileHead(args, config, context); }
    catch { observation = { status: 'unavailable' }; }
    assertActive(context);
    if (observation.status === 'observed' || observation.status === 'queued') claimed = claimNext(config, args.sessionId, context);
    if (!claimed) {
      if (item.state === 'queued' && !context.providerWorker) watchQueue(args, config, context);
      return { requestId: item.requestId, delivery: item.deduplicated ? 'not-resent' : 'queued',
        queueState: item.state, completion: 'unknown', observation: observation.status,
        deliveryId: item.deliveryId, ownerId: item.ownerId, correlation: item.correlation, nativeAck: item.nativeAck };
    }
  }
  const result = await dispatchClaimed(claimed, config, context);
  // The actual dispatch owner wakes tails after ACK; stale dispatching rows have no wakeup.
  if (!context.providerWorker) watchQueue(args, config, context);
  if (claimed.request_id !== item.requestId) return { requestId: item.requestId,
    delivery: item.deduplicated ? 'not-resent' : 'queued', queueState: item.state, completion: 'unknown',
    observation: observation.status, advanced: { requestId: claimed.request_id,
      queueState: result.queueState }, deliveryId: item.deliveryId, ownerId: item.ownerId,
    correlation: item.correlation, nativeAck: item.nativeAck };
  return { ...result, requestId: item.requestId, observation: observation?.status };
}
