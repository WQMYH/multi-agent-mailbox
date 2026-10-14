import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { call, describe, readConfig, receiptOwnerId } from './adapter.mjs';
import { validateMessageReceipt } from '../agent-core/src/contracts.mjs';
import { ModuleRegistry } from '../agent-core/src/registry.mjs';

const fixture = fileURLToPath(new URL('./test/fixture-cli.mjs', import.meta.url));
const wakerId = 'abcdef123456', sessionId = '00000000-0000-4000-8000-000000000010';
const send = { requestId: 'one-request', wakerId, sessionId, message: 'Bounded offline input' };

test('offline CLI control preserves scope, one-shot receipts, native approvals and private output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wake-adapter-'));
  const home = join(root, 'home'), workspace = join(root, 'project'), other = join(root, 'other');
  for (const dir of [home, workspace, other]) mkdirSync(dir);
  const configPath = join(root, 'operator.json'), log = join(root, 'calls.jsonl');
  const configuration = { cliExecutable: process.execPath, home, allowedWakerIds: [wakerId], allowedRoots: [workspace], receiptDir: join(root, 'receipts') };
  writeFileSync(configPath, JSON.stringify(configuration));
  const priorConfig = process.env.AGENT_QODER_WAKE_CONFIG;
  process.env.AGENT_QODER_WAKE_CONFIG = configPath;
  let mode = '', current = true, permittedBudget = true, gate;
  const budgetCalls = [];
  const context = {
    registrationKey: 'offline-registration-generation-1',
    assertCurrent() { if (!current) throw Error('PRIVATE_SENTINEL'); },
    messageBudget: { status: () => ({}), check: value => { budgetCalls.push(value); return { ok: permittedBudget }; } },
    execFile(executable, args, options, callback) {
      return execFile(executable, [fixture, ...args], { ...options, env: { ...options.env,
        WAKE_TEST_MODE: mode, WAKE_TEST_CALL_LOG: log, WAKE_TEST_WORKSPACE: workspace, WAKE_TEST_OTHER_ROOT: other,
        WAKE_TEST_CREATED: join(root, 'created'), ...(gate ? { WAKE_TEST_GATE: gate } : {}) } }, callback);
    }
  };
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const mutations = () => calls().filter(item => item.args[0] === 'session' && ['create', 'send', 'interrupt'].includes(item.args[1]));
  const rejects = (action, code) => assert.rejects(action, error => error.message === code && error.code === code);
  try {
    await t.test('the unchanged Core routes the adapter through its existing discover/read/act gates', async () => {
      const registry = new ModuleRegistry({ registryPath: join(root, 'core-registry.json') });
      registry.install(fileURLToPath(new URL('.', import.meta.url)));
      const moduleId = 'agent-qoder-wake';
      assert.equal((await registry.agentDiscover({ moduleId })).operations.length, 10);
      assert.equal((await registry.agentRead({ moduleId, operation: 'request_receipt', args: { requestId: 'absent' } })).state, 'not_found');
      await assert.rejects(registry.agentRead({ moduleId, operation: 'send_session_message', args: send }), /agent_read cannot call mutating/);
      await assert.rejects(registry.agentAct({ moduleId, operation: 'identity' }), /agent_act cannot call read-only/);
      assert.equal(calls().length, 0);
    });
    await t.test('Core discovery is metadata only and native JSON is projected into the scoped Session domain', async () => {
      const operations = await describe();
      assert.equal(calls().length, 0);
      assert.equal(operations.find(item => item.name === 'send_session_message').annotations.readOnlyHint, false);
      assert.ok(!operations.some(item => /resume|stop|conversation|runs|trace|approval_resolve/.test(item.name)));
      const info = await call('identity', {}, context);
      assert.equal(info.identity.version, '1.1.7-cn');
      const employees = await call('list_wakers', {}, context);
      assert.deepEqual(employees.items.map(item => item.agentId), [wakerId]);
      const sessions = await call('list_sessions', { wakerId }, context);
      assert.equal(sessions.items[0].sessionId, sessionId);
      assert.ok(!JSON.stringify([info, employees, sessions]).includes('PRIVATE_SENTINEL'));
      assert.ok(!Object.hasOwn(sessions.items[0], 'convId'));
      assert.ok(calls().every(item => item.home === readConfig().home && item.cwd === readConfig().home && !item.daemonUrlPresent));
    });
    await t.test('wrong Waker, foreign project, stopped Session, pending approval and revoked registration cannot dispatch', async () => {
      const before = mutations().length;
      await rejects(call('send_session_message', { ...send, wakerId: 'other' }, context), 'WAKE_TARGET_OUTSIDE_SCOPE');
      mode = 'wrong-agent'; await rejects(call('send_session_message', send, context), 'WAKE_NATIVE_SCHEMA');
      mode = 'outside-root'; await rejects(call('send_session_message', send, context), 'WAKE_TARGET_OUTSIDE_SCOPE');
      mode = 'stopped'; await rejects(call('send_session_message', send, context), 'WAKE_SESSION_NOT_LIVE');
      mode = 'pending'; await rejects(call('send_session_message', send, context), 'WAKE_APPROVAL_PENDING');
      mode = ''; current = false; await rejects(call('send_session_message', send, context), 'WAKE_REGISTRATION_CHANGED');
      current = true; permittedBudget = false; await rejects(call('send_session_message', send, context), 'WAKE_BUDGET_BLOCKED');
      permittedBudget = true;
      assert.equal(mutations().length, before);
      assert.throws(() => readdirSync(configuration.receiptDir), { code: 'ENOENT' });
    });
    await t.test('concurrent same request dispatches once; changed payload or generation cannot reuse that request', async () => {
      const results = await Promise.all([call('send_session_message', send, context),
        call('send_session_message', { message: send.message, sessionId, wakerId, requestId: send.requestId }, context)]);
      assert.equal(mutations().length, 1);
      assert.ok(results.some(item => item.state === 'accepted'));
      for (const result of results) {
        validateMessageReceipt(result.messageReceipt);
        assert.equal(result.consumerConfirmed, false);
        assert.equal(result.completion, 'unknown');
        assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
      }
      assert.equal((await call('send_session_message', send, context)).deduplicated, true);
      await rejects(call('send_session_message', { ...send, message: 'Changed input' }, context), 'WAKE_REQUEST_CONFLICT');
      await rejects(call('send_session_message', send, { ...context, registrationKey: 'generation-2' }), 'WAKE_REQUEST_CONFLICT');
      assert.equal(mutations().length, 1);
      const records = readdirSync(configuration.receiptDir).filter(name => name.endsWith('.json')).map(name => readFileSync(join(configuration.receiptDir, name), 'utf8'));
      assert.ok(records.every(record => !record.includes(send.message) && !record.includes('PRIVATE_SENTINEL')));
      assert.ok(budgetCalls.every(item => item.ownerId === receiptOwnerId(readConfig()) && Number.isSafeInteger(item.usedBytes) && Number.isSafeInteger(item.additionalBytes)));
    });
    await t.test('lost or malformed native output remains unknown across reread and retry without redispatch', async () => {
      for (const value of ['error', 'malformed', 'wrong-result']) {
        mode = value;
        const args = { ...send, requestId: `unknown-${value}` };
        const first = await call('send_session_message', args, context), before = mutations().length;
        assert.equal(first.state, 'unknown');
        assert.equal(first.messageReceipt.acceptance.provider.state, 'unknown');
        mode = '';
        assert.equal((await call('request_receipt', { requestId: args.requestId }, context)).state, 'unknown');
        assert.equal((await call('send_session_message', args, context)).state, 'unknown');
        assert.equal(mutations().length, before);
        assert.ok(!JSON.stringify(first).includes('PRIVATE_SENTINEL'));
      }
    });
    await t.test('registration revocation after native dispatch fences acceptance without replay', async () => {
      gate = join(root, 'gate');
      const args = { ...send, requestId: 'revoked-after-dispatch' }, before = mutations().length;
      const pending = call('send_session_message', args, context);
      const deadline = Date.now() + 5000;
      while (mutations().length === before && Date.now() < deadline) await delay(10);
      assert.equal(mutations().length, before + 1);
      current = false; writeFileSync(gate, 'ready');
      assert.equal((await pending).state, 'unknown');
      current = true; gate = undefined;
      assert.equal((await call('send_session_message', args, context)).state, 'unknown');
      assert.equal(mutations().length, before + 1);
    });
    await t.test('the caller cannot change reserved input while native preflight is awaiting', async () => {
      const args = { ...send, requestId: 'immutable-input' };
      const pending = call('send_session_message', args, context);
      args.message = 'changed after call';
      assert.equal((await pending).state, 'accepted');
      const sent = mutations().at(-1).args;
      assert.equal(sent[sent.indexOf('--message') + 1], send.message);
    });
    await t.test('only the observed idle resident combination can continue after natural turn completion', async () => {
      mode = 'resident';
      const result = await call('send_session_message', { ...send, requestId: 'resident-follow-up' }, context);
      assert.equal(result.state, 'accepted');
      const before = mutations().length;
      for (const state of ['stopped', 'terminal-resident', 'unknown-resident', 'incomplete-resident', 'released-live']) {
        mode = state;
        await rejects(call('send_session_message', { ...send, requestId: `reject-${state}` }, context), 'WAKE_SESSION_NOT_LIVE');
      }
      mode = 'pending-resident';
      await rejects(call('send_session_message', { ...send, requestId: 'resident-pending' }, context), 'WAKE_APPROVAL_PENDING');
      mode = 'resident';
      await rejects(call('interrupt_session', { requestId: 'resident-noop-interrupt', wakerId, sessionId }, context), 'WAKE_SESSION_NOT_LIVE');
      assert.equal(mutations().length, before);
      mode = '';
    });
    await t.test('native SSE keeps high sequence/run coordinates without leaking thinking, system or metrics payloads', async () => {
      mode = 'sse-normal';
      const args = { wakerId, sessionId, fromSequence: 1000000000 };
      const result = await call('read_session_events', args, context);
      assert.equal(result.observation, 'observed');
      assert.equal(result.complete, false);
      assert.equal(result.consumerConfirmed, false);
      assert.equal(result.terminalResultObserved, true);
      assert.equal(result.observedThroughSequence, 1000000048);
      assert.deepEqual(result.items.map(item => item.sequence), [1000000001, 1000000002, 1000000035, 1000000042, 1000000047, 1000000048]);
      assert.ok(result.items.every(item => item.sessionId === sessionId && item.runId === 'fixture-native-run'));
      assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
      const stream = calls().find(item => item.args[1] === 'stream').args;
      assert.equal(stream[stream.indexOf('--from-sequence-num') + 1], '999999999');
      const next = await call('read_session_events', { ...args, fromSequence: 1000000048 }, context);
      assert.equal(next.terminalResultObserved, false);
      assert.ok(!next.items.some(item => item.type === 'result'));
      mode = 'sse-duplicate';
      assert.equal((await call('read_session_events', args, context)).items.length, result.items.length);
    });
    await t.test('bad/cross-session SSE fails closed while partial and empty windows stay observational', async () => {
      const args = { wakerId, sessionId, fromSequence: 1000000000 }, before = mutations().length;
      for (const state of ['sse-wrong-session', 'sse-bad', 'sse-raw']) {
        mode = state; await rejects(call('read_session_events', args, context), 'WAKE_NATIVE_SCHEMA');
      }
      await rejects(call('read_session_events', { ...args, fromSequence: Number.MAX_SAFE_INTEGER + 1 }, context), 'WAKE_ARGUMENT_INVALID');
      mode = 'sse-partial';
      const partial = await call('read_session_events', args, context);
      assert.equal(partial.partialFrame, true); assert.equal(partial.truncated, true); assert.equal(partial.complete, false);
      assert.ok(!JSON.stringify(partial).includes('PRIVATE_SENTINEL'));
      mode = 'sse-empty';
      const empty = await call('read_session_events', args, context);
      assert.equal(empty.observation, 'no_evidence'); assert.equal(empty.complete, false); assert.equal(empty.items.length, 0);
      assert.equal(mutations().length, before);
    });
    await t.test('SSE item, UTF-8 text, byte and time bounds never upgrade a partial window to complete', async () => {
      const args = { wakerId, sessionId, fromSequence: 1000000000 };
      mode = 'sse-normal';
      const limited = await call('read_session_events', { ...args, limit: 1 }, context);
      assert.equal(limited.items.length, 1); assert.ok(limited.omittedEvents > 0); assert.equal(limited.truncated, true);
      assert.equal(limited.returnedThroughSequence, 1000000001); assert.equal(limited.observedThroughSequence, 1000000048);
      mode = 'sse-long-text';
      const text = await call('read_session_events', args, context);
      assert.equal(text.textTruncated, true); assert.ok(text.textBytes <= 8192);
      assert.ok(text.items.every(item => Buffer.byteLength(item.text ?? '') <= 2048));
      mode = 'sse-maxbuffer';
      const bytes = await call('read_session_events', args, context);
      assert.equal(bytes.stopReason, 'byte_limit'); assert.equal(bytes.complete, false); assert.equal(bytes.truncated, true);
      assert.ok(!JSON.stringify(bytes).includes('PRIVATE_SENTINEL'));
      mode = 'sse-many';
      const frames = await call('read_session_events', args, context);
      assert.equal(frames.frameLimitReached, true); assert.equal(frames.truncated, true); assert.equal(frames.frameCount, 512);
      assert.ok(!JSON.stringify(frames).includes('PRIVATE_SENTINEL'));
      mode = 'sse-timeout';
      const timed = await call('read_session_events', args, context);
      assert.equal(timed.stopReason, 'timeout'); assert.equal(timed.complete, false); assert.equal(timed.observation, 'observed'); assert.equal(timed.truncated, true);
      mode = '';
    });
    await t.test('new Session is not accepted until the returned native ID belongs to the requested Waker and directory', async () => {
      const args = { requestId: 'new-session', wakerId, cwd: workspace, title: 'Offline only', message: 'Offline initial input' };
      const result = await call('create_session', args, context);
      assert.equal(result.state, 'accepted');
      assert.equal(result.sessionId, 'native-created-session');
      const create = mutations().find(item => item.args[1] === 'create');
      assert.ok(create.args.includes('--message'));
      assert.ok(!create.args.includes('--events-json') && !create.args.includes('--idempotency-key'));
      const before = mutations().length;
      await call('create_session', args, context);
      assert.equal(mutations().length, before);
      const interruption = await call('interrupt_session', { requestId: 'interrupt-existing', wakerId, sessionId }, context);
      assert.equal(interruption.state, 'accepted');
      assert.equal(interruption.completion, 'unknown');
    });
  } finally {
    if (priorConfig === undefined) delete process.env.AGENT_QODER_WAKE_CONFIG;
    else process.env.AGENT_QODER_WAKE_CONFIG = priorConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending old Session approval blocks exact sends and interrupts but not an independent new Session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wake-approval-scope-'));
  const home = join(root, 'home'), workspace = join(root, 'project'), log = join(root, 'calls.jsonl');
  mkdirSync(home); mkdirSync(workspace);
  const configPath = join(root, 'operator.json');
  writeFileSync(configPath, JSON.stringify({ cliExecutable: process.execPath, home,
    allowedWakerIds: [wakerId], allowedRoots: [workspace], receiptDir: join(root, 'receipts') }));
  const previous = process.env.AGENT_QODER_WAKE_CONFIG;
  process.env.AGENT_QODER_WAKE_CONFIG = configPath;
  const context = { registrationKey: 'offline-approval-scope', assertCurrent() {},
    messageBudget: { status: () => ({}), check: () => ({ ok: true }) },
    execFile(executable, args, options, callback) {
      return execFile(executable, [fixture, ...args], { ...options, env: { ...options.env,
        WAKE_TEST_MODE: 'pending', WAKE_TEST_CALL_LOG: log, WAKE_TEST_WORKSPACE: workspace,
        WAKE_TEST_CREATED: join(root, 'created') } }, callback);
    } };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  try {
    for (const operation of ['send_session_message', 'interrupt_session']) {
      const args = { requestId: `old-${operation}`, wakerId, sessionId,
        ...(operation === 'send_session_message' ? { message: 'Offline old Session input' } : {}) };
      await assert.rejects(call(operation, args, context), { code: 'WAKE_APPROVAL_PENDING' });
    }
    assert.equal(calls().filter(item => item.args[0] === 'session' && ['send', 'interrupt'].includes(item.args[1])).length, 0);
    const result = await call('create_session', { requestId: 'independent-new-session', wakerId,
      cwd: workspace, message: 'Offline independent input' }, context).catch(error => ({ state: error.code }));
    assert.deepEqual({ state: result.state, createCalls: calls().filter(item => item.args[0] === 'session' && item.args[1] === 'create').length },
      { state: 'accepted', createCalls: 1 });
    assert.ok(calls().filter(item => item.args[0] === 'permission').every(item =>
      item.args[1] === 'approval' && item.args[2] === 'list' && item.args[item.args.indexOf('--session-id') + 1] === sessionId));
  } finally {
    if (previous === undefined) delete process.env.AGENT_QODER_WAKE_CONFIG;
    else process.env.AGENT_QODER_WAKE_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('SSE text budget preserves the safe watermark before an omitted reply and following metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wake-sse-watermark-'));
  const home = join(root, 'home'), workspace = join(root, 'project'), log = join(root, 'calls.jsonl');
  mkdirSync(home); mkdirSync(workspace);
  const configPath = join(root, 'operator.json');
  writeFileSync(configPath, JSON.stringify({ cliExecutable: process.execPath, home,
    allowedWakerIds: [wakerId], allowedRoots: [workspace], receiptDir: join(root, 'receipts') }));
  const previous = process.env.AGENT_QODER_WAKE_CONFIG;
  process.env.AGENT_QODER_WAKE_CONFIG = configPath;
  const context = { assertCurrent() {}, execFile(executable, args, options, callback) {
    return execFile(executable, [fixture, ...args], { ...options, env: { ...options.env,
      WAKE_TEST_MODE: 'sse-budget-tail', WAKE_TEST_CALL_LOG: log, WAKE_TEST_WORKSPACE: workspace,
      WAKE_TEST_CREATED: join(root, 'created') } }, callback);
  } };
  try {
    const first = await call('read_session_events', { wakerId, sessionId, fromSequence: 1000000000 }, context);
    const next = await call('read_session_events', { wakerId, sessionId, fromSequence: first.returnedThroughSequence + 1 }, context);
    assert.deepEqual({ retained: first.items.length, safeThrough: first.returnedThroughSequence,
      observedThrough: first.observedThroughSequence, recoveredReply: next.items.find(item => item.type === 'assistant')?.text },
    { retained: 4, safeThrough: 1000000031, observedThrough: 1000000050, recoveredReply: 'FIFTH_SCOPED_REPLY' });
    assert.equal(first.textBytes, 8192); assert.equal(first.truncated, true); assert.equal(first.complete, false);
    assert.ok(first.items.every(item => item.type === 'assistant' && item.text.length > 0));
    assert.equal(next.returnedThroughSequence, 1000000048); assert.equal(next.consumerConfirmed, false);
    assert.ok(!JSON.stringify([first, next]).includes('PRIVATE_SENTINEL'));
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(item => item.args[0] === 'session' && ['send', 'create', 'interrupt'].includes(item.args[1])).length, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_QODER_WAKE_CONFIG;
    else process.env.AGENT_QODER_WAKE_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('native exclusive SSE cursors preserve inclusive public continuation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wake-sse-inclusive-'));
  const home = join(root, 'home'), workspace = join(root, 'project'), log = join(root, 'calls.jsonl');
  mkdirSync(home); mkdirSync(workspace);
  const configPath = join(root, 'operator.json');
  writeFileSync(configPath, JSON.stringify({ cliExecutable: process.execPath, home,
    allowedWakerIds: [wakerId], allowedRoots: [workspace], receiptDir: join(root, 'receipts') }));
  const previous = process.env.AGENT_QODER_WAKE_CONFIG;
  process.env.AGENT_QODER_WAKE_CONFIG = configPath;
  let mode = 'sse-adjacent';
  const context = { assertCurrent() {}, execFile(executable, args, options, callback) {
    return execFile(executable, [fixture, ...args], { ...options, env: { ...options.env,
      WAKE_TEST_MODE: mode, WAKE_TEST_CALL_LOG: log, WAKE_TEST_WORKSPACE: workspace,
      WAKE_TEST_CREATED: join(root, 'created') } }, callback);
  } };
  const read = args => call('read_session_events', { wakerId, sessionId, ...args }, context);
  try {
    await t.test('the exact requested event is retained for adjacent and gapped histories', async () => {
      for (const value of ['sse-adjacent', 'sse-gap']) {
        mode = value;
        const result = await read({ fromSequence: 1000000396 });
        assert.equal(result.items[0]?.sequence, 1000000396); assert.equal(result.items[0]?.text, 'SCOPED_INPUT_396');
        assert.equal(result.items.length, 3); assert.equal(result.complete, false);
      }
    });
    await t.test('limit plus one continuation does not skip the immediately adjacent reply', async () => {
      mode = 'sse-adjacent';
      const first = await read({ fromSequence: 0, limit: 1 });
      const next = await read({ fromSequence: first.returnedThroughSequence + 1, limit: 1 });
      assert.equal(first.returnedThroughSequence, 1000000396);
      assert.equal(next.items[0]?.sequence, 1000000397); assert.equal(next.items[0]?.text, 'SCOPED_REPLY');
    });
    await t.test('text budget plus one continuation recovers the adjacent fifth reply', async () => {
      mode = 'sse-budget-adjacent';
      const first = await read({ fromSequence: 0 });
      const next = await read({ fromSequence: first.returnedThroughSequence + 1 });
      assert.equal(first.returnedThroughSequence, 1000000004); assert.equal(first.truncated, true);
      assert.equal(next.items[0]?.sequence, 1000000005); assert.equal(next.items[0]?.text, 'FIFTH_SCOPED_REPLY');
    });
    await t.test('zero and maximum safe lower bounds never create a negative or unsafe native cursor', async () => {
      mode = 'sse-boundary';
      await read({ fromSequence: 0 });
      const result = await read({ fromSequence: Number.MAX_SAFE_INTEGER });
      assert.equal(result.items[0]?.sequence, Number.MAX_SAFE_INTEGER);
      const streams = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.args[1] === 'stream').slice(-2);
      assert.deepEqual(streams.map(item => item.args[item.args.indexOf('--from-sequence-num') + 1]), ['0', String(Number.MAX_SAFE_INTEGER - 1)]);
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_QODER_WAKE_CONFIG;
    else process.env.AGENT_QODER_WAKE_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
