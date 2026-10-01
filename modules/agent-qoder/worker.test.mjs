import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { claimWorker, desktop, queueOwnerId } from './desktop.mjs';
import { runProviderWorker, startProviderWorker } from './worker.mjs';

const budget = config => {
  const ownerId = queueOwnerId(config);
  return { status: () => ({}), check: ({ usedBytes, additionalBytes = 0 }) => ({ ok: true, ownerId,
    allocatedBytes: 20_000_000, usedBytes, additionalBytes, projectedBytes: usedBytes + additionalBytes,
    remainingBytes: 20_000_000 - usedBytes - additionalBytes, deltaBytes: 0 }) };
};

test('worker launcher is detached and carries only fixed config plus registration generation', () => {
  const calls = [];
  const child = { pid: 42, unref: () => calls.push('unref') };
  const result = startProviderWorker({ deliveryDir: 'E:/queue' }, {
    registrationKey: '["registry","registration","revision"]', assertCurrent() {}
  }, (...args) => { calls.push(args); return child; });
  assert.deepEqual(result, { status: 'started', pid: 42 });
  assert.equal(calls[0][2].detached, true); assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(calls[1], 'unref');
});

test('provider worker resumes persisted observation and safe tails across sessions after host loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-worker-recovery-'));
  const config = { cdpPort: 19327, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const saved = { fetch, WebSocket };
  const terminals = new Map(), sends = [];
  let current = true;
  const context = { registrationKey: '["registry","registration","revision"]', providerWorker: true,
    assertCurrent: () => { if (!current) throw Error('Module registration changed or disabled'); },
    messageBudget: budget(config) };
  const args = (sessionId, requestId) => ({ sessionId, requestId, prompt: requestId,
    workspaceId: 'workspace', cwd: 'E:/owned' });
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'qoder-cn-app://renderer/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/worker' }] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        let result;
        try {
          const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: '0.3.4' }),
            listChatSessions: async () => ['session-a', 'session-b'].map(sessionId => ({ sessionId,
              workspaceId: 'workspace', cwd: 'E:/owned', runtimeProfileId: 'runtime:qoder', executionKind: 'local',
              runtimeState: 'cold', model: 'qfmodel', permissionMode: 'default', productMode: 'coding' })),
            listChatComposerModels: async () => [{ key: 'qfmodel', enabled: true }],
            loadChatHistoryAround: async (sessionId, cwd, requestId) => ({ messages: terminals.has(requestId) ? [
              { id: requestId, turnId: requestId, role: 'user', status: 'completed' },
              { id: `assistant:${requestId}`, turnId: requestId, role: 'assistant', status: terminals.get(requestId),
                completedAt: '2026-10-01T00:00:00.000Z',
                finalTextId: `${requestId}:final`, parts: [{ id: `${requestId}:final`, type: 'text' }] }
            ] : [] }),
            sendChatMessage: async input => sends.push(input.inputId)
          } } });
          result = { result: { value } };
        } catch { result = { exceptionDetails: { text: 'rejected' } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };

    await desktop('send', args('session-a', 'a1'), config, context);
    assert.equal((await desktop('send', args('session-a', 'a2'), config, context)).delivery, 'queued');
    await desktop('send', args('session-b', 'b1'), config, context);
    assert.deepEqual(sends, ['a1', 'b1']);

    let waits = 0;
    const oldWorker = runProviderWorker(config, context, { wait: async () => {
      waits++;
      if (waits === 1) { terminals.set('a1', 'completed'); terminals.set('b1', 'completed'); current = false; }
    } });
    await assert.rejects(oldWorker, /registration changed or disabled/i);
    assert.deepEqual(sends, ['a1', 'b1'], 'revoked generation cannot dispatch queued a2');

    current = true;
    const next = { ...context, registrationKey: '["registry","registration","revision-2"]' };
    await runProviderWorker(config, next, { wait: async () => {
      terminals.set('a2', 'completed');
    } });
    assert.deepEqual(sends, ['a1', 'b1', 'a2']);
    const status = await desktop('queue_status', args('session-a', 'unused'), config, next);
    assert.deepEqual(status.items.map(row => [row.requestId, row.state]), [['a1', 'observed'], ['a2', 'observed']]);
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker renews its token around every slow session before another process can take over', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-worker-lease-'));
  const config = { cdpPort: 19327, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const saved = { fetch, WebSocket };
  let clock = 0;
  const attempts = [];
  const context = { registrationKey: 'generation', providerWorker: true, assertCurrent() {}, messageBudget: budget(config) };
  const args = n => ({ sessionId: `session-${n}`, requestId: `request-${n}`, prompt: 'x', workspaceId: 'workspace', cwd: 'E:/owned' });
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'qoder-cn-app://renderer/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/lease' }] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
          getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
          getProductUpdateState: async () => ({ currentVersion: '0.3.4' }),
          listChatSessions: async () => [1, 2, 3].map(n => ({ sessionId: `session-${n}`, workspaceId: 'workspace',
            cwd: 'E:/owned', runtimeProfileId: 'runtime:qoder', executionKind: 'local', runtimeState: 'cold',
            model: 'qfmodel', permissionMode: 'default', productMode: 'coding' })),
          listChatComposerModels: async () => [{ key: 'qfmodel', enabled: true }],
          sendChatMessage: async () => {},
          loadChatHistoryAround: async (sessionId, cwd, requestId) => {
            clock += 25_000;
            attempts.push(claimWorker(config, context, `rival-${requestId}`, clock));
            return { messages: [{ id: requestId, turnId: requestId, role: 'user', status: 'completed' },
              { id: `assistant:${requestId}`, turnId: requestId, role: 'assistant', status: 'completed',
                completedAt: '2026-10-01T00:00:00.000Z', finalTextId: `${requestId}:final`,
                parts: [{ id: `${requestId}:final`, type: 'text' }] }] };
          }
        } } });
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result: { result: { value } } }) }));
      }
    };
    for (const n of [1, 2, 3]) await desktop('send', args(n), config, context);
    await runProviderWorker(config, context, { now: () => clock, wait: async () => {} });
    assert.deepEqual(attempts, [false, false, false]);
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    await rm(directory, { recursive: true, force: true });
  }
});

test('only one process acquires the provider worker lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-worker-race-'));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const context = { providerWorker: true, messageBudget: budget(config) };
  try {
    await assert.rejects(desktop('send', { sessionId: 'session-a', requestId: 'request-a', prompt: 'x',
      workspaceId: 'workspace', cwd: 'E:/owned' }, config, context), /cdpPort required/);
    const source = `import { claimWorker, queueOwnerId } from ${JSON.stringify(new URL('./desktop.mjs', import.meta.url).href)};
      const config=JSON.parse(process.argv[1]),ownerId=queueOwnerId(config);
      const context={registrationKey:'generation',messageBudget:{status:()=>({}),check:({usedBytes,additionalBytes=0})=>({ok:true,ownerId,usedBytes,additionalBytes})}};
      process.stdout.write(String(claimWorker(config,context,process.argv[2])));`;
    const run = promisify(execFile);
    const results = await Promise.all(['one', 'two'].map(token => run(process.execPath,
      ['--input-type=module', '-e', source, JSON.stringify(config), token])));
    assert.deepEqual(results.map(result => result.stdout).sort(), ['false', 'true']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function copiedWorkerBudget(totalBytes, allocationTotal, accepted, { adaptive = false, globalLimitBytes } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qoder-worker-install-smoke-'));
  const install = join(root, 'installed-agent-qoder'), deliveryDir = join(root, 'delivery');
  const registryPath = join(root, 'registry.json');
  await mkdir(install); await mkdir(deliveryDir);
  try {
    for (const name of ['desktop.mjs', 'worker.mjs'])
      await copyFile(new URL(name, import.meta.url), join(install, name));
    const config = { cdpPort: 19327, workspaceId: 'workspace', root: 'E:/owned', deliveryDir };
    new DatabaseSync(join(deliveryDir, 'send-queue.sqlite')).close();
    const ownerId = queueOwnerId(config), registrationId = 'registration', revision = 'revision';
    const registry = JSON.stringify({ modules: { 'agent-qoder': {
      enabled: true, registrationId, revision
    } }, messageBudget: { schemaVersion: 1, totalBytes,
      ...(adaptive ? { defaultOwnerBytes: 50_000_000 } : {}),
      ...(globalLimitBytes === undefined ? {} : { globalLimitBytes }),
      allocations: [{ ownerId, bytes: 240_000 }, { ownerId: 'other-owner', bytes: allocationTotal - 240_000 }] } });
    await writeFile(registryPath, registry);
    const registrationKey = JSON.stringify([registryPath, registrationId, revision]);
    const run = promisify(execFile);
    const execute = () => run(process.execPath, [join(install, 'worker.mjs'),
      Buffer.from(JSON.stringify(config)).toString('base64url'), Buffer.from(registrationKey).toString('base64url')],
    { timeout: 10_000, windowsHide: true });
    if (!accepted) {
      await assert.rejects(execute(), error => error.code === 1);
      assert.equal(await readFile(registryPath, 'utf8'), registry);
      return;
    }
    const result = await execute();
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(await readFile(registryPath, 'utf8'), registry);
    const db = new DatabaseSync(join(deliveryDir, 'send-queue.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
      assert.equal(db.prepare('SELECT token FROM worker WHERE id=1').get().token, null);
      assert.equal(db.prepare('SELECT owner_id FROM queue_meta WHERE id=1').get().owner_id, ownerId);
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('copied provider worker accepts legacy 20M and current 200M budgets without enlarging its allocation', async () => {
  for (const totalBytes of [20_000_000, 200_000_000])
    await copiedWorkerBudget(totalBytes, totalBytes, true);
});

test('copied provider worker rejects allocations that do not sum to the declared total', async () => {
  await copiedWorkerBudget(200_000_000, 20_000_000, false);
});

test('copied provider worker accepts adaptive 250M budgets and rejects an exceeded global cap', async () => {
  await copiedWorkerBudget(250_000_000, 250_000_000, true, { adaptive: true });
  await copiedWorkerBudget(250_000_000, 250_000_000, false, { adaptive: true, globalLimitBytes: 200_000_000 });
});
