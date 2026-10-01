import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { claimWorker, desktop as invokeDesktop, queueOwnerId } from './desktop.mjs';

const budgetContext = (config, allocatedBytes = 20_000_000) => {
  const ownerId = queueOwnerId(config);
  return { messageBudget: {
    status: () => ({ schemaVersion: 1, totalBytes: 20_000_000, allocations: [{ ownerId, bytes: allocatedBytes }] }),
    check: ({ ownerId: candidate, usedBytes, additionalBytes = 0 }) => {
      if (candidate !== ownerId) return { ok: false, reason: 'owner_unallocated', deltaBytes: Math.max(1, additionalBytes) };
      const projectedBytes = usedBytes + additionalBytes;
      return { ok: projectedBytes <= allocatedBytes, ownerId, allocatedBytes, usedBytes, additionalBytes,
        projectedBytes, remainingBytes: Math.max(0, allocatedBytes - projectedBytes),
        deltaBytes: Math.max(0, projectedBytes - allocatedBytes),
        ...(projectedBytes <= allocatedBytes ? {} : { reason: 'owner_budget_exceeded' }) };
    }
  } };
};
const desktop = (operation, args, config, context = budgetContext(config)) => invokeDesktop(operation, args, config, context);

async function waitFor(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw Error('timed out waiting for queue worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('same-session FIFO, separate-session sends, dedup and unknown outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-queue-'));
  const saved = { fetch, WebSocket };
  const target = { type: 'page', url: 'qoder-cn-app://renderer/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/queue-test' };
  const config = { cdpPort: 19327, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const args = (sessionId, requestId, prompt = requestId) => ({
    sessionId, requestId, prompt, workspaceId: 'workspace', cwd: 'E:/owned'
  });
  let sends = [], sendError = false, release;
  const terminals = new Map(), unavailableReads = new Set();
  const gate = new Promise(resolve => { release = resolve; });
  let bothStarted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [target] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        const request = JSON.parse(raw);
        let result;
        try {
          const value = await vm.runInNewContext(request.params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: '0.4.2' }),
            listChatSessions: async () => ['session-a', 'session-b', 'session-c', 'session-d'].map(sessionId => ({
              sessionId, workspaceId: 'workspace', cwd: 'E:/owned', runtimeProfileId: 'runtime:qoder',
              executionKind: 'local', runtimeState: 'cold', model: 'qfmodel', permissionMode: 'acceptEdits', productMode: 'coding'
            })),
            listChatComposerModels: async () => [{ key: 'qfmodel', enabled: true }],
            loadChatHistoryAround: async (sessionId, cwd, requestId, before, after) => {
              assert.equal(cwd, 'E:/owned'); assert.equal(before, 10); assert.equal(after, 9);
              if (unavailableReads.has(sessionId)) throw Error('desktop unavailable');
              const outcome = terminals.get(requestId);
              return { messages: outcome ? [
                { id: requestId, turnId: requestId, role: 'user', status: 'completed' },
                { id: `assistant:${requestId}`, turnId: requestId, role: 'assistant', status: outcome,
                  completedAt: '2026-10-01T00:00:00.000Z',
                  ...(outcome === 'completed' ? { finalTextId: `${requestId}:final`,
                    parts: [{ id: `${requestId}:final`, type: 'text' }] } : { parts: [] }) }
              ] : [] };
            },
            sendChatMessage: async input => {
              sends.push(input);
              if (sends.length === 2) bothStarted();
              if (sendError) throw Error('simulated transport uncertainty');
              await gate;
            }
          } } });
          result = { result: { value } };
        } catch { result = { exceptionDetails: { text: 'rejected' } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };

    const first = desktop('send', args('session-a', 'a1'), config);
    const second = await desktop('send', args('session-a', 'a2'), config);
    const other = desktop('send', args('session-b', 'b1'), config);
    assert.equal(second.delivery, 'queued');
    await started;
    assert.equal(sends.length, 2, 'other session can reach native while first is pending');
    const inFlight = await desktop('queue_status', { sessionId: 'session-a', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.equal(inFlight.needsAttention, false, 'an active dispatch is not an attention event');
    assert.equal(inFlight.items[0].state, 'dispatching');
    assert.equal(inFlight.items[0].liveness, 'unknown');
    release();
    assert.equal((await first).queueState, 'awaiting_observation');
    assert.equal((await other).queueState, 'awaiting_observation');
    const status = await desktop('queue_status', { sessionId: 'session-a', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.deepEqual(status.items.map(item => item.state), ['awaiting_observation', 'queued']);
    assert.equal(status.items[0].nativeAck, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    terminals.set('a1', 'completed');
    await waitFor(() => sends.length === 3);
    assert.equal(sends.length, 3, 'exact completed predecessor releases the FIFO tail');
    let advanced = await desktop('queue_status', { sessionId: 'session-a', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.deepEqual(advanced.items.map(item => [item.requestId, item.terminalOutcome]), [['a1', 'completed'], ['a2', null]]);
    assert.equal((await desktop('send', args('session-a', 'a3'), config)).delivery, 'queued');
    terminals.set('a2', 'failed');
    await waitFor(() => sends.length === 4);
    assert.equal((await desktop('send', args('session-a', 'a4'), config)).delivery, 'queued');
    terminals.set('a3', 'interrupted');
    await waitFor(() => sends.length === 5);
    assert.equal((await desktop('send', args('session-a', 'a1'), config)).delivery, 'not-resent');
    assert.equal((await desktop('send', args('session-a', 'a2'), config)).delivery, 'not-resent');
    await assert.rejects(desktop('send', args('session-a', 'a1', 'changed'), config), /conflicts/);
    assert.equal(sends.length, 5);

    const db = new DatabaseSync(join(directory, 'send-queue.sqlite'));
    try { db.prepare("UPDATE sends SET state='dispatching' WHERE request_id='a4'").run(); }
    finally { db.close(); }
    assert.equal((await desktop('send', args('session-a', 'a4'), config)).delivery, 'not-resent');
    assert.equal((await desktop('send', args('session-a', 'a5'), config)).delivery, 'queued');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(sends.length, 5, 'restart-unknown dispatching head is never replayed or released');

    sendError = true;
    await assert.rejects(desktop('send', args('session-c', 'c1'), config), /Desktop rejected/);
    const failed = await desktop('queue_status', { sessionId: 'session-c', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.equal(failed.items[0].state, 'needs_attention');
    assert.equal(failed.items[0].nativeAck, false);
    assert.equal((await desktop('send', args('session-c', 'c1'), config)).delivery, 'not-resent');
    assert.equal((await desktop('send', args('session-c', 'c2'), config)).delivery, 'queued');
    assert.equal(sends.length, 6, 'unknown outcome is never retried');

    sendError = false; unavailableReads.add('session-d');
    assert.equal((await desktop('send', args('session-d', 'd1'), config)).queueState, 'awaiting_observation');
    assert.equal((await desktop('send', args('session-d', 'd2'), config)).delivery, 'queued');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(sends.filter(send => send.sessionId === 'session-d').length, 1,
      'lost observation does not release or dispatch the tail');
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two processes claim only one head for the same session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-queue-process-'));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const script = `import { desktop, queueOwnerId } from ${JSON.stringify(new URL('./desktop.mjs', import.meta.url).href)};
    const config=JSON.parse(process.argv[2]),ownerId=queueOwnerId(config);
    const context={messageBudget:{status:()=>({schemaVersion:1,totalBytes:20000000,allocations:[{ownerId,bytes:20000000}]}),check:({usedBytes,additionalBytes=0})=>({ok:true,ownerId,allocatedBytes:20000000,usedBytes,additionalBytes,projectedBytes:usedBytes+additionalBytes,remainingBytes:20000000-usedBytes-additionalBytes,deltaBytes:0})}};
    await desktop('send', JSON.parse(process.argv[1]), config, context).catch(() => {});`;
  try {
    const run = promisify(execFile);
    await Promise.all(['child-1', 'child-2'].map(requestId => run(process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify({
        sessionId: 'session-a', requestId, prompt: requestId, workspaceId: 'workspace', cwd: 'E:/owned'
      }), JSON.stringify(config)])));
    const status = await desktop('queue_status', {
      sessionId: 'session-a', workspaceId: 'workspace', cwd: 'E:/owned'
    }, config);
    assert.deepEqual(status.items.map(item => item.state), ['needs_attention', 'queued']);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 1,
      'only the claimed head gets a native-send reservation');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('equivalent root hot update keeps a legacy blocking head visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-queue-root-'));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/Owned', deliveryDir: directory };
  const first = { sessionId: 'session-a', requestId: 'old-head', prompt: 'once',
    workspaceId: 'workspace', cwd: 'E:/Owned' };
  try {
    await assert.rejects(desktop('send', first, config), /cdpPort required/);
    const db = new DatabaseSync(join(directory, 'send-queue.sqlite'));
    try { db.prepare('UPDATE sends SET cwd=? WHERE request_id=?').run('E:/Owned', 'old-head'); }
    finally { db.close(); }
    const updated = { ...config, root: 'e:\\owned' };
    const same = { ...first, cwd: 'e:\\owned' };
    assert.equal((await desktop('send', same, updated)).delivery, 'not-resent');
    assert.equal((await desktop('send', { ...same, requestId: 'tail', prompt: 'later' }, updated)).delivery, 'queued');
    const status = await desktop('queue_status', { sessionId: 'session-a', workspaceId: 'workspace', cwd: 'e:\\owned' }, updated);
    assert.deepEqual(status.items.map(item => [item.requestId, item.state]),
      [['old-head', 'needs_attention'], ['tail', 'queued']]);
    assert.equal(status.needsAttention, true);
    const check = new DatabaseSync(join(directory, 'send-queue.sqlite'), { readOnly: true });
    try { assert.equal(check.prepare('SELECT cwd FROM sends WHERE request_id=?').get('tail').cwd, 'e:/owned'); }
    finally { check.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('owner budget is explicit, transactional and preserves protected records when later blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-budget-'));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const args = requestId => ({ sessionId: requestId, requestId, prompt: 'protected', workspaceId: 'workspace', cwd: 'E:/owned' });
  try {
    await assert.rejects(invokeDesktop('send', args('request-a'), config, {
      messageBudget: { status: () => null, check: () => ({ ok: false }) }
    }), /budget_not_configured/);
    assert.equal(existsSync(join(directory, 'send-queue.sqlite')), false, 'unconfigured budget writes no queue');

    await assert.rejects(desktop('send', args('request-a'), config), /cdpPort required/);
    const before = await desktop('queue_status', { sessionId: 'request-a', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.equal(before.items.length, 1); assert.equal(before.items[0].ownerId, queueOwnerId(config));
    const physical = statSync(join(directory, 'send-queue.sqlite')).size + statSync(join(directory, 'request-a.json')).size;
    assert.ok(before.budget.usedBytes >= physical, 'database and managed marker bytes are counted');

    const blocked = budgetContext(config, before.budget.usedBytes);
    await assert.rejects(invokeDesktop('send', args('request-b'), config, blocked), /owner_budget_exceeded/);
    const legacy = createHash('sha256').update(JSON.stringify([
      'request-a', 'workspace', 'e:/owned', 'protected'
    ])).digest('hex');
    const db = new DatabaseSync(join(directory, 'send-queue.sqlite'));
    try { db.prepare('UPDATE sends SET fingerprint=?,correlation=NULL WHERE request_id=?').run(legacy, 'request-a'); }
    finally { db.close(); }
    assert.equal((await invokeDesktop('send', args('request-a'), config, blocked)).delivery, 'not-resent',
      'legacy dedup remains queryable while new writes are budget-blocked');
    const preserved = await desktop('queue_status', { sessionId: 'request-a', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.equal(preserved.items.length, 1); assert.equal(existsSync(join(directory, 'request-a.json')), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows queue aliases share one owner and persisted identity rejects a hard-link alias', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qoder-owner-alias-'));
  const real = join(root, 'real'), alias = join(root, 'alias');
  await mkdir(real); await symlink(real, alias, 'junction');
  const direct = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: join(real, 'queue') };
  const junction = { ...direct, deliveryDir: join(alias, 'queue') };
  const extended = { ...direct, deliveryDir: `\\\\?\\${direct.deliveryDir}` };
  const args = { sessionId: 'session-a', requestId: 'request-a', prompt: 'x', workspaceId: 'workspace', cwd: 'E:/owned' };
  try {
    assert.equal(queueOwnerId(direct), queueOwnerId(junction));
    assert.equal(queueOwnerId(direct), queueOwnerId(extended));
    await assert.rejects(desktop('send', args, direct), /cdpPort required/);
    const status = await desktop('queue_status', args, junction);
    assert.equal(status.items[0].requestId, 'request-a');

    const other = join(root, 'other'); await mkdir(other);
    await link(join(direct.deliveryDir, 'send-queue.sqlite'), join(other, 'send-queue.sqlite'));
    await assert.rejects(desktop('queue_status', args, { ...direct, deliveryDir: other }), /owner identity changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('budget rejection rolls back legacy schema migration and preserves its row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-budget-migration-'));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const path = join(directory, 'send-queue.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE sends (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, cwd TEXT NOT NULL, prompt TEXT NOT NULL, operation TEXT,
      fingerprint TEXT NOT NULL, state TEXT NOT NULL, native_ack INTEGER NOT NULL DEFAULT 0,
      terminal_outcome TEXT, observed_at TEXT, created_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO sends(request_id,session_id,workspace_id,cwd,prompt,operation,fingerprint,state,created_at)
      VALUES('old','session-a','workspace','e:/owned','x','send','fingerprint','queued','2026-09-26T00:00:00.000Z')`).run();
  } finally { db.close(); }
  const allocatedBytes = statSync(path).size;
  try {
    await assert.rejects(Promise.resolve().then(() => claimWorker(config, {
      registrationKey: 'generation', messageBudget: budgetContext(config, allocatedBytes).messageBudget
    }, 'token')), /owner_budget_exceeded/);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = check.prepare('PRAGMA table_info(sends)').all().map(column => column.name);
      assert.equal(columns.includes('correlation'), false);
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='worker'").get(), undefined);
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='queue_meta'").get(), undefined);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 1);
    } finally { check.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('first-message session creation is scoped and never replays uncertain sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-first-send-'));
  const config = { cdpPort: 19327, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const args = (sessionId, requestId) => ({ sessionId, requestId, prompt: requestId,
    workspaceId: 'workspace', cwd: 'E:/owned' });
  const saved = { fetch, WebSocket };
  const sent = [];
  let failSend = false, existingSession = null, workspaceAvailable = true;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'qoder-cn-app://renderer/index.html?workbenchScope=primary',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/first-send' }] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        let result;
        try {
          const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: '0.4.2' }),
            listLocalWorkspaces: async () => workspaceAvailable ? [{ workspaceId: 'workspace', rootPaths: ['E:/owned'] }] : [],
            listChatSessions: async () => existingSession ? [{ sessionId: existingSession }] : [],
            sendChatMessage: async input => { sent.push(input); if (failSend) throw Error('SK_LIVE_SYNTHETIC_CREDENTIAL_123'); }
          } } });
          result = { result: { value } };
        } catch (error) { result = { exceptionDetails: { text: 'rejected',
          exception: { description: `Error: ${error.message}\n    at renderer` } } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };
    const first = args('new-a', 'request-a');
    assert.equal((await desktop('send_new_session', first, config)).queueState, 'awaiting_observation');
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].sessionId, sent[0].inputId, sent[0].turnId], ['new-a', 'request-a', 'request-a']);
    assert.equal(sent[0].model, undefined);
    assert.equal(sent[0].permissionMode, undefined);
    assert.equal(sent[0].productMode, 'coding');
    assert.equal((await desktop('send_new_session', first, config)).delivery, 'not-resent');
    await assert.rejects(desktop('send_new_session', { ...first, prompt: 'changed' }, config), /conflicts/);
    assert.equal((await desktop('send', args('new-a', 'request-after-first'), config)).delivery, 'queued');
    await assert.rejects(desktop('send_new_session', { ...args('bad-scope', 'bad-scope'), cwd: 'E:/other' }, config), /Operator scope changed/);
    assert.equal(sent.length, 1);

    workspaceAvailable = false;
    const missingWorkspace = args('new-missing-workspace', 'request-missing-workspace');
    await assert.rejects(desktop('send_new_session', missingWorkspace, config),
      /Desktop rejected operation: Workspace scope changed/);
    assert.equal(sent.length, 1, 'a missing native workspace is rejected before sendChatMessage');
    assert.equal((await desktop('send_new_session', missingWorkspace, config)).delivery, 'not-resent');
    workspaceAvailable = true;

    failSend = true;
    const uncertain = args('new-b', 'request-b');
    await assert.rejects(desktop('send_new_session', uncertain, config), error => {
      assert.equal(error.message, 'Desktop rejected operation');
      return true;
    });
    assert.equal((await desktop('send_new_session', uncertain, config)).delivery, 'not-resent');
    assert.equal((await desktop('send_new_session', args('new-b', 'request-c'), config)).delivery, 'queued');
    assert.equal(sent.length, 2);
    const status = await desktop('queue_status', { sessionId: 'new-b', workspaceId: 'workspace', cwd: 'E:/owned' }, config);
    assert.deepEqual(status.items.map(item => item.state), ['needs_attention', 'queued']);

    existingSession = 'new-c';
    await assert.rejects(desktop('send_new_session', args('new-c', 'request-d'), config), /Desktop rejected/);
    assert.equal(sent.length, 2, 'an existing native session is never sent a first message');

    existingSession = null; failSend = false;
    const [left, right] = await Promise.all([
      desktop('send_new_session', { ...args('new-d', 'request-e'), correlation: 'caller:left' }, config),
      desktop('send_new_session', { ...args('new-e', 'request-f'), correlation: 'caller:right' }, config)
    ]);
    assert.deepEqual([left.correlation, right.correlation], ['caller:left', 'caller:right']);
    assert.notEqual(left.deliveryId, right.deliveryId);
    assert.deepEqual(sent.slice(-2).map(item => [item.sessionId, item.inputId]).sort(),
      [['new-d', 'request-e'], ['new-e', 'request-f']]);
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    await rm(directory, { recursive: true, force: true });
  }
});
