import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { ModuleRegistry } from '../agent-core/src/registry.mjs';
import { queueOwnerId } from './desktop.mjs';

const moduleRoot = fileURLToPath(new URL('.', import.meta.url));
const cli = fileURLToPath(new URL('../agent-core/src/cli.mjs', import.meta.url));
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const sessionId = id(1), workspaceId = id(2), a = id(3), b = id(4);

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'qoder-lifecycle-'));
  const registryPath = join(root, 'registry.json');
  const config = { USERPROFILE: root, HOME: root, QODER_DESKTOP_CDP_PORT: '19327',
    QODER_CONTROL_WORKSPACE_ID: workspaceId, QODER_CONTROL_ROOT: root, QODER_DELIVERY_DIR: root };
  const env = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  const saved = { fetch, WebSocket, setTimeout, clearTimeout };
  const timers = new Map(), sends = [], histories = [];
  const state = { terminal: false, outcome: 'completed', unknown: false, disconnected: false, historyGate: null,
    fetchGate: null, fetchCount: 0, schedules: 0, sendGate: null };
  const registry = new ModuleRegistry({ registryPath });
  const other = new ModuleRegistry({ registryPath });
  const act = (requestId, task = sessionId) => registry.agentAct({ moduleId: 'agent-qoder', operation: 'send',
    args: { sessionId: task, requestId, prompt: requestId } });
  const status = () => registry.agentRead({ moduleId: 'agent-qoder', operation: 'queue_status', args: { sessionId } });
  const external = (...args) => execFileSync(process.execPath, [cli, ...args, '--registry', registryPath],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  // Drive only the production watcher's timers; CDP deadlines remain real timers.
  async function tick() {
    const batch = [...timers.entries()];
    for (const [timer, { fn }] of batch) { timers.delete(timer); await fn(); }
  }
  try {
    Object.assign(process.env, config);
    registry.install(moduleRoot);
    registry.initializeMessageBudget([queueOwnerId({ deliveryDir: root })]);
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms !== 0 && ms !== 1000) return saved.setTimeout(fn, ms, ...args);
      const timer = { unref() {} }; timers.set(timer, { fn: () => fn(...args), ms }); state.schedules++;
      return timer;
    };
    globalThis.clearTimeout = timer => { if (!timers.delete(timer)) saved.clearTimeout(timer); };
    globalThis.fetch = async () => {
      state.fetchCount++;
      await state.fetchGate?.(state.fetchCount);
      if (state.disconnected) throw Error('offline');
      return { ok: true, json: async () => [{ type: 'page', url: 'qoder-cn-app://renderer/index.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/lifecycle' }] };
    };
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        let result;
        try {
          const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: '0.3.4' }),
            listChatSessions: async () => [sessionId, id(10)].map(sessionId => ({ sessionId, workspaceId,
              cwd: root, runtimeProfileId: 'runtime:qoder', executionKind: 'local', runtimeState: 'cold',
              model: 'qfmodel', productMode: 'coding', permissionMode: 'default' })),
            listChatComposerModels: async () => [{ key: 'qfmodel', enabled: true }],
            loadChatHistoryAround: async (task, cwd, turn) => {
              histories.push(turn); await state.historyGate?.();
              return { messages: state.terminal ? [
                { id: turn, turnId: turn, role: 'user', status: 'completed' },
                { id: `assistant:${turn}`, turnId: turn, role: 'assistant', status: state.outcome,
                  completedAt: '2026-10-01T00:00:00.000Z',
                  ...(state.outcome === 'completed' ? { finalTextId: `${turn}:final`,
                    parts: [{ id: `${turn}:final`, type: 'text' }] } : { parts: [] }) }
              ] : [] };
            },
            sendChatMessage: async input => {
              sends.push(input.inputId);
              await state.sendGate?.(input);
              if (state.unknown) throw Error('lost reply after send');
            }
          } } });
          result = { result: { value } };
        } catch { result = { exceptionDetails: { text: 'rejected' } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };
    await run({ root, registry, other, act, status, external, tick, state, sends, histories, timers });
  } finally {
    // Revoke and drain callbacks before removing their isolated registry/data.
    if (other.list().some(row => row.id === 'agent-qoder')) other.uninstall('agent-qoder');
    await tick(); assert.equal(timers.size, 0, 'revoked callbacks must terminate');
    Object.assign(globalThis, saved);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('real core: exactly A/B, later completion automatically dispatches B once; reads never wake a queue', () => fixture(async f => {
  await assert.rejects(f.registry.agentAct({ moduleId: 'agent-qoder', operation: 'launch',
    args: { executable: 'relative.exe' } }), /absolute Qoder CN standalone executable/,
  'core context without a launcher injection must use the default launcher validation');
  await f.act(a); assert.equal((await f.act(b)).delivery, 'queued');
  await f.tick(); assert.deepEqual(f.sends, [a]);
  assert.equal([...f.timers.values()][0].ms, 1000);
  await f.act(id(11), id(10)); assert.deepEqual(f.sends, [a, id(11)], 'independent session progresses');
  f.state.disconnected = true; f.state.terminal = true;
  await f.tick(); assert.deepEqual(f.sends, [a, id(11)], 'loss of observation cannot release B');
  f.state.disconnected = false; await f.tick();
  assert.deepEqual(f.sends, [a, id(11), b]); assert.equal(f.timers.size, 1);
  assert.deepEqual((await f.status()).items.map(row => row.state), ['observed', 'awaiting_observation']);
  await f.tick();
  assert.equal(f.timers.size, 0);
  await f.tick(); assert.equal(f.sends.filter(x => x === b).length, 1);
}));

for (const outcome of ['completed', 'failed']) {
  test(`real core: final accepted row records exact ${outcome} outcome without a successor`, () => fixture(async f => {
    await f.act(a);
    const schedules = f.state.schedules;
    assert.equal((await f.status()).items[0].state, 'awaiting_observation');
    assert.equal(f.state.schedules, schedules, 'queue_status stays passive');
    await f.tick();
    assert.equal((await f.status()).items[0].state, 'awaiting_observation');
    assert.equal([...f.timers.values()][0].ms, 1000);
    f.state.outcome = outcome; f.state.terminal = true; await f.tick();
    const row = (await f.status()).items[0];
    assert.equal(row.state, 'observed'); assert.equal(row.terminalOutcome, outcome);
    assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
  }));
}

test('real core: final observer keeps disconnect unknown and revocation prevents revival or replay', () => fixture(async f => {
  await f.act(a); f.state.disconnected = true; f.state.terminal = true; await f.tick();
  const row = (await f.status()).items[0];
  assert.equal(row.state, 'awaiting_observation'); assert.equal(row.terminalOutcome, null);
  assert.deepEqual(f.sends, [a]); assert.equal([...f.timers.values()][0].ms, 1000);
  f.other.disable('agent-qoder'); await f.tick(); assert.equal(f.timers.size, 0);
  f.other.enable('agent-qoder'); await f.status(); await f.tick();
  assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
}));

for (const revoke of ['instance-disable', 'process-uninstall', 'process-disable-enable', 'process-reinstall']) {
  test(`real core: ${revoke} invalidates old callbacks`, () => fixture(async f => {
    await f.act(a); assert.equal((await f.act(b)).delivery, 'queued'); await f.tick();
    if (revoke === 'instance-disable') f.other.disable('agent-qoder');
    if (revoke === 'process-uninstall') f.external('uninstall', 'agent-qoder');
    if (revoke === 'process-disable-enable') {
      f.external('disable', 'agent-qoder'); f.external('enable', 'agent-qoder');
    }
    if (revoke === 'process-reinstall') f.external('install', moduleRoot);
    if (revoke === 'instance-disable' || revoke === 'process-uninstall') await assert.rejects(f.status(), /disabled|Unknown module/);
    else await f.registry.agentDiscover({ moduleId: 'agent-qoder' });
    f.state.terminal = true; await f.tick();
    assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
    if (revoke === 'instance-disable') f.other.enable('agent-qoder');
    if (revoke === 'process-uninstall') f.other.install(moduleRoot);
    await f.status(); await f.tick();
    assert.deepEqual(f.sends, [a], 're-enable/read/discovery cannot resurrect the old registration callback');
  }));
}

test('real core: revoke while terminal read is in flight stops claim; new explicit registration call can resume queued B', () => fixture(async f => {
  await f.act(a); await f.act(b);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.historyGate = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = f.tick(); await ready;
  f.external('disable', 'agent-qoder'); f.external('enable', 'agent-qoder');
  f.state.terminal = true; release(); await pending;
  assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
  assert.equal((await f.status()).items[1].state, 'queued');
  f.state.historyGate = null;
  await f.act(b); assert.deepEqual(f.sends, [a, b]);
}));

test('real core: revoke after claim but before CDP send retains unknown reservation', () => fixture(async f => {
  await f.act(a); await f.act(b);
  f.state.terminal = true;
  // A send, B foreground observation, watcher terminal observation, then B dispatch discovery.
  f.state.fetchGate = count => { if (count === 4) f.other.disable('agent-qoder'); };
  await f.tick(); assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
  f.other.enable('agent-qoder');
  assert.equal((await f.status()).items[1].state, 'needs_attention');
  await f.act(b); assert.deepEqual(f.sends, [a], 'reserved send is never retried after revival');
}));

test('real core: needs_attention with queued tail stops quietly; fresh registry never replays unknown A', () => fixture(async f => {
  f.state.unknown = true;
  await assert.rejects(f.act(a), /Desktop rejected/);
  assert.equal((await f.act(b)).delivery, 'queued');
  const count = f.state.schedules;
  for (let i = 0; i < 12; i++) await f.tick();
  assert.equal(f.state.schedules, count); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.sends, [a]); assert.equal(f.histories.length, 0);
  f.state.unknown = false; f.state.terminal = true;
  await f.other.agentAct({ moduleId: 'agent-qoder', operation: 'send', args: { sessionId, requestId: a, prompt: a } });
  await f.other.agentAct({ moduleId: 'agent-qoder', operation: 'send', args: { sessionId, requestId: b, prompt: b } });
  await f.tick(); assert.deepEqual(f.sends, [a]); assert.equal(f.timers.size, 0);
}));

test('real core: failed background B leaves C queued and terminates its existing watcher', () => fixture(async f => {
  await f.act(a); await f.act(b); await f.act(id(5));
  f.state.terminal = true; f.state.unknown = true;
  await f.tick(); assert.deepEqual(f.sends, [a, b]);
  const count = f.state.schedules;
  for (let i = 0; i < 12; i++) await f.tick();
  assert.equal(f.state.schedules, count); assert.equal(f.timers.size, 0);
  assert.deepEqual((await f.status()).items.map(row => row.state), ['observed', 'needs_attention', 'queued']);
}));

test('real core: live dispatch owner wakes tails on ACK; a crash-left dispatching head stays quiet', () => fixture(async f => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.sendGate = () => new Promise(resolve => { release = resolve; entered(); });
  const first = f.act(a); await ready;
  assert.equal((await f.act(b)).delivery, 'queued'); assert.equal(f.timers.size, 0);
  f.state.sendGate = null; release(); await first;
  assert.equal(f.timers.size, 1, 'ACK owner must create the missing watcher');
  f.state.terminal = true; await f.tick(); assert.deepEqual(f.sends, [a, b]);
  f.other.disable('agent-qoder'); f.other.enable('agent-qoder'); await f.tick();
  const db = new DatabaseSync(join(f.root, 'send-queue.sqlite'));
  try { db.prepare("UPDATE sends SET state='dispatching' WHERE request_id=?").run(b); }
  finally { db.close(); }
  await f.other.agentAct({ moduleId: 'agent-qoder', operation: 'send', args: { sessionId, requestId: id(5), prompt: id(5) } });
  assert.equal(f.timers.size, 0); await f.tick(); assert.deepEqual(f.sends, [a, b]);
}));

test('real core: revocation cannot retract an issued native operation, but prevents its queued continuation', () => fixture(async f => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.sendGate = () => new Promise(resolve => { release = resolve; entered(); });
  const first = f.act(a), rejected = assert.rejects(first, /disabled/);
  await ready; await f.act(b); f.other.disable('agent-qoder');
  release(); await rejected; await f.tick();
  assert.deepEqual(f.sends, [a], 'A already crossed the native dispatch boundary');
  f.other.enable('agent-qoder');
  const rows = (await f.status()).items;
  assert.equal(rows[0].nativeAck, true); assert.equal(rows[1].state, 'queued');
  assert.equal(f.timers.size, 0);
}));
