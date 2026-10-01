import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { desktop, observeVerifiedTurn, queueOwnerId, runQueueCycle, verifyNativeTurn } from './desktop.mjs';
import { runProviderWorker } from './worker.mjs';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const completedAt = '2026-09-28T00:00:00.000Z';
const input = requestId => ({ id: requestId, turnId: requestId, role: 'user', status: 'completed' });
const answer = (requestId, extra = {}) => ({ id: `assistant:${requestId}`, turnId: requestId,
  role: 'assistant', status: 'completed', completedAt, finalTextId: `${requestId}:final`,
  parts: [{ id: `${requestId}:final`, type: 'text', parentToolUseId: null }], ...extra });

test('F1: intermediate completed assistant never releases FIFO; real terminal outcomes do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qoder-fifo-finality-'));
  const saved = { fetch, WebSocket }, otherSession = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const otherRequest = '33333333-3333-4333-8333-333333333333';
  const histories = new Map(), sent = [];
  let runtimeState = 'cold', pendingInteractionCount;
  const args = (requestId, task = sessionId) => ({ sessionId: task, workspaceId, cwd: root, requestId, prompt: requestId });
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'qoder-cn-app://renderer/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/fifo-finality' }] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        let result;
        try {
          const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: '0.4.3' }),
            listChatSessions: async () => [sessionId, otherSession].map(task => ({ sessionId: task, workspaceId,
              cwd: root, runtimeProfileId: 'runtime:qoder', executionKind: 'local', productMode: 'coding',
              model: null, permissionMode: null, runtimeState: task === sessionId ? runtimeState : 'cold',
              pendingInteractionCount: task === sessionId ? pendingInteractionCount : undefined })),
            sendChatMessage: async value => { sent.push(value.inputId); },
            loadChatHistoryAround: async (task, cwd, requestId) => ({ messages: histories.get(requestId) ?? [] })
          } } });
          result = { result: { value } };
        } catch (error) { result = { exceptionDetails: { text: error.message } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };
    for (const outcome of ['completed', 'failed', 'interrupted']) {
      histories.clear(); sent.length = 0; runtimeState = 'cold'; pendingInteractionCount = undefined;
      const config = { cdpPort: 19327, workspaceId, root, deliveryDir: join(root, outcome) };
      const context = { providerWorker: true, messageBudget: { status: () => ({}), check: () => ({ ok: true }) } };
      const status = () => desktop('queue_status', args(first), config, context);
      assert.equal((await desktop('send', args(first), config, context)).nativeAck, true);
      runtimeState = 'running';
      histories.set(first, [input(first), answer(first, { completedAt: undefined, finalTextId: undefined,
        parts: [{ id: 'tool', type: 'tool', tool: { status: 'running' } }] })]);
      assert.equal((await desktop('send', args(second), config, context)).delivery, 'queued');
      const initialStates = (await status()).items.map(row => row.state);
      assert.deepEqual(initialStates, ['awaiting_observation', 'queued']);
      const heldCases = ['running', 'pending', 'tool-running', 'missing-final-text', 'missing-completion-time'];
      for (const reason of heldCases) {
        runtimeState = reason === 'running' ? 'running' : 'cold';
        pendingInteractionCount = reason === 'pending' ? 1 : undefined;
        const extra = reason === 'tool-running' ? { parts: [
          { id: 'tool', type: 'tool', tool: { status: 'running' } }, { id: `${first}:final`, type: 'text' }
        ] } : reason === 'missing-final-text' ? { finalTextId: undefined, parts: [] }
          : reason === 'missing-completion-time' ? { completedAt: undefined } : {};
        histories.set(first, [input(first), answer(first, extra)]);
        await runQueueCycle(config, context);
        assert.deepEqual((await status()).items.map(row => row.state), initialStates, reason);
        assert.equal((await status()).items[0].observedAt, null, reason);
        assert.deepEqual(sent, [first], reason);
      }
      histories.set(otherRequest, [input(otherRequest), answer(otherRequest)]);
      assert.equal((await desktop('send', args(otherRequest, otherSession), config, context)).nativeAck, true);
      await runQueueCycle(config, context);
      assert.deepEqual((await status()).items.map(row => row.state), initialStates);
      assert.equal((await desktop('queue_status', args(otherRequest, otherSession), config, context)).items[0].state, 'observed');
      assert.deepEqual(sent, [first, otherRequest], 'another session progresses while this head stays blocked');
      histories.set(first, [input(first), answer(first, outcome === 'completed' ? {} : {
        status: outcome, finalTextId: undefined, parts: []
      })]);
      await runQueueCycle(config, context);
      const released = (await status()).items;
      assert.deepEqual(released.map(row => row.state), ['observed', 'awaiting_observation']);
      assert.equal(released[0].terminalOutcome, outcome);
      assert.deepEqual(sent, [first, otherRequest, second]);
      assert.equal((await observeVerifiedTurn({ requestId: first, sessionId,
        deliveryId: `qoder-delivery:${first}` }, config, context)).terminalOutcome, outcome);
      histories.set(second, [input(second), answer(second)]);
      await runQueueCycle(config, context);
      assert.deepEqual((await status()).items.map(row => row.state), ['observed', 'observed']);
      assert.equal((await desktop('send', args(second), config, context)).delivery, 'not-resent');
      assert.deepEqual(sent, [first, otherRequest, second], 'tail dispatches exactly once');
      t.diagnostic(JSON.stringify({ outcome, initialStates, heldCases, otherSessionObserved: true,
        finalStates: ['observed', 'observed'], sameSessionNativeSends: 2 }));
    }
  } finally { Object.assign(globalThis, saved); await rm(root, { recursive: true, force: true }); }
});

test('native turn proof rejects intermediate assistants, interleaved roots, duplicates and incomplete finality', () => {
  const history = { messages: [input(first), answer(first), input(second), answer(second)] };
  assert.deepEqual(verifyNativeTurn(history, first), { nativeInputId: first, nativeTurnId: first,
    assistantId: `assistant:${first}`, terminalOutcome: 'completed' });
  assert.deepEqual(verifyNativeTurn(history, second), { nativeInputId: second, nativeTurnId: second,
    assistantId: `assistant:${second}`, terminalOutcome: 'completed' });
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first, { finalTextId: undefined })] }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first, { parts: [
    { id: 'tool', type: 'tool', toolStatus: 'running' }, { id: `${first}:final`, type: 'text' }
  ] })] }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first, { parts: [
    { id: `${first}:final`, type: 'text' }, { id: 'tool', type: 'tool', toolStatus: 'completed' }
  ] })] }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), input(second), answer(first)] }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first), answer(first)] }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first, { finalTextId: 'missing' })] }, first), null);
  assert.equal(verifyNativeTurn({ messages: Array.from({ length: 501 }, (_, n) => ({ id: String(n) })) }, first), null);
  assert.equal(verifyNativeTurn({ messages: [input(first), answer(first, { status: 'failed', finalTextId: undefined,
    parts: [] })] }, first)?.terminalOutcome, 'failed');
});

test('recover projects two persisted turns and keeps an intermediate tool assistant awaiting observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qoder-native-return-'));
  const modulePath = join(root, 'native-turn-return.mjs');
  const config = { cdpPort: 19327, workspaceId, root, deliveryDir: join(root, 'delivery') };
  const ownerId = queueOwnerId(config), saved = { fetch, WebSocket };
  const rows = [], sent = [];
  let enabled = true, waits = 0, version = '0.4.3';
  const context = { registrationKey: 'generation', providerWorker: true,
    assertCurrent: () => { if (!enabled) throw Error('Module disabled'); },
    messageBudget: { status: () => ({}), check: ({ usedBytes, additionalBytes = 0 }) =>
      ({ ok: true, ownerId, usedBytes, additionalBytes }) } };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'qoder-cn-app://renderer/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:19327/devtools/page/return' }] });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
      async send(raw) {
        let result;
        try {
          const value = await vm.runInNewContext(JSON.parse(raw).params.expression, { window: { qoderDesktop: {
            getStartupState: async () => ({ productId: 'qoder-cn', status: 'ready' }),
            getProductUpdateState: async () => ({ currentVersion: version }),
            listChatSessions: async () => [{ sessionId, workspaceId, cwd: root, runtimeProfileId: 'runtime:qoder',
              executionKind: 'local', runtimeState: 'cold', pendingInteractionCount: 0, model: 'qfmodel',
              permissionMode: 'default', productMode: 'coding' }],
            listChatComposerModels: async () => [{ key: 'qfmodel', enabled: true }],
            sendChatMessage: async value => {
              sent.push(value.inputId);
              rows.push(input(value.inputId), value.inputId === first ? answer(first) : answer(second, {
                completedAt: undefined, finalTextId: undefined, parts: [{ id: 'tool', type: 'tool', tool: { status: 'running' } }]
              }));
            },
            loadChatHistoryAround: async () => ({ messages: rows })
          } } });
          result = { result: { value } };
        } catch { result = { exceptionDetails: { text: 'rejected' } }; }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
      }
    };
    const args = requestId => ({ sessionId, workspaceId, cwd: root, requestId, prompt: requestId });
    await desktop('send', args(first), config, context);
    await runQueueCycle(config, context);
    await desktop('send', args(second), config, context);
    await runQueueCycle(config, context);
    assert.deepEqual(sent, [first, second]);
    assert.deepEqual((await desktop('queue_status', args(first), config, context)).items.map(item => item.state),
      ['observed', 'awaiting_observation'], 'FIFO and return proof both wait for true finality');

    globalThis.__qoderReturnFacts = [];
    globalThis.__qoderReturnSeen = new Set();
    const bindings = [first, second].map(requestId => ({ requestId, sessionId,
      deliveryId: `qoder-delivery:${requestId}` }));
    await writeFile(modulePath, `export async function reconcileVerifiedReturns({observeTurn,assertActive}) {
      const results=[];
      for (const item of ${JSON.stringify(bindings)}) {
        await assertActive(); const fact=await observeTurn(item);
        if (fact && !globalThis.__qoderReturnSeen.has(item.requestId)) {
          globalThis.__qoderReturnSeen.add(item.requestId); globalThis.__qoderReturnFacts.push(fact);
        }
        results.push({requestId:item.requestId,state:fact?'accepted':'nonterminal'});
      }
      return results;
    }`);
    const linked = { ...config, returnModulePath: modulePath, returnDataDir: root };
    await runProviderWorker(linked, context, { wait: async () => {
      if (++waits === 1) {
        assert.equal(globalThis.__qoderReturnFacts.length, 1, 'intermediate turn cannot project');
        rows[3] = answer(second, { parts: [{ id: 'tool', type: 'tool', tool: { status: 'completed' } },
          { id: `${second}:final`, type: 'text', parentToolUseId: null }] });
      } else {
        assert.equal(waits, 2, 'existing worker settles the now-observed head then exits');
        assert.deepEqual((await desktop('queue_status', args(first), config, context)).items.map(item => item.state),
          ['observed', 'observed']);
        assert.equal(globalThis.__qoderReturnFacts.length, 2);
      }
    } });
    assert.equal(waits, 2);
    assert.equal(globalThis.__qoderReturnFacts.length, 2);
    assert.deepEqual(globalThis.__qoderReturnFacts.map(fact => fact.requestId), [first, second]);
    for (const fact of globalThis.__qoderReturnFacts) {
      assert.equal(fact.ownerId, ownerId); assert.equal(fact.deliveryId, `qoder-delivery:${fact.requestId}`);
      assert.equal(fact.workspaceId, workspaceId); assert.equal(fact.sessionId, sessionId);
      assert.equal(fact.canonicalCwd, realpathSync.native(root));
      assert.equal(fact.nativeInputId, fact.requestId); assert.equal(fact.nativeTurnId, fact.requestId);
      assert.equal(fact.assistantId, `assistant:${fact.requestId}`);
      assert.equal(fact.terminalOutcome, 'completed');
      assert.equal(fact.evidenceSource, 'qoder-cn:normalized-history');
      assert.equal(fact.productVersion, '0.4.3');
    }
    assert.equal(await observeVerifiedTurn({ requestId: first, deliveryId: 'wrong', sessionId }, linked, context), null);
    for (version of ['0.4.2', '0.3.4', '9.9.9-canary.1', 'diagnostic only', undefined]) {
      const fact = await observeVerifiedTurn({ requestId: first, deliveryId: `qoder-delivery:${first}`, sessionId }, linked, context);
      assert.equal(fact.nativeTurnId, first); assert.equal(fact.productVersion, version ?? null);
      assert.equal(fact.evidenceSource, 'qoder-cn:normalized-history');
      const final = rows[1]; rows[1] = answer(first, { finalTextId: undefined });
      assert.equal(await observeVerifiedTurn({ requestId: first, deliveryId: `qoder-delivery:${first}`, sessionId }, linked, context), null);
      rows[1] = final;
    }
    enabled = false;
    await assert.rejects(runProviderWorker(linked, context), /Module disabled/);
    assert.equal(globalThis.__qoderReturnFacts.length, 2, 'disabled generation cannot project again');
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    delete globalThis.__qoderReturnFacts; delete globalThis.__qoderReturnSeen;
    await rm(root, { recursive: true, force: true });
  }
});
