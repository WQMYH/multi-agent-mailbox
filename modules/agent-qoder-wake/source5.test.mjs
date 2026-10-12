import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { call } from './adapter.mjs';

const fixture = fileURLToPath(new URL('./test/fixture-cli.mjs', import.meta.url));
const wakerId = 'abcdef123456', sessionId = '00000000-0000-4000-8000-000000000010';

test('source5 observed released lifecycle and exact native plain-user ACK', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wake-source5-'));
  const home = join(root, 'home'), workspace = join(root, 'project'), log = join(root, 'calls.jsonl'), receipts = join(root, 'receipts');
  mkdirSync(home); mkdirSync(workspace);
  const configPath = join(root, 'operator.json');
  writeFileSync(configPath, JSON.stringify({ cliExecutable: process.execPath, home,
    allowedWakerIds: [wakerId], allowedRoots: [workspace], receiptDir: receipts }));
  const previous = process.env.AGENT_QODER_WAKE_CONFIG;
  process.env.AGENT_QODER_WAKE_CONFIG = configPath;
  let mode = '';
  const context = { registrationKey: 'offline-source5', assertCurrent() {},
    messageBudget: { status: () => ({}), check: () => ({ ok: true }) },
    execFile(executable, args, options, callback) {
      return execFile(executable, [fixture, ...args], { ...options, env: { ...options.env, WAKE_TEST_MODE: mode,
        WAKE_TEST_CALL_LOG: log, WAKE_TEST_WORKSPACE: workspace, WAKE_TEST_CREATED: join(root, 'created') } }, callback);
    } };
  const sends = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.args[0] === 'session' && item.args[1] === 'send').length; } catch { return 0; } };
  const interrupts = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.args[0] === 'session' && item.args[1] === 'interrupt').length; } catch { return 0; } };
  const input = requestId => ({ requestId, wakerId, sessionId, message: 'Offline scoped user input' });
  const recordText = requestId => readdirSync(receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(join(receipts, name), 'utf8'))
    .find(text => JSON.parse(text).requestId === requestId);
  try {
    await t.test('naturally released waiting-input Session can submit once under its exact ready lifecycle', async () => {
      mode = 'released-ready';
      const result = await call('send_session_message', input('released-follow-up'), context).catch(error => ({ state: error.code }));
      assert.equal(result.state, 'accepted');
      assert.deepEqual(result.nativeAck, { eventId: 'fixture-user-event', sequence: 1000000051 });
    });
    await t.test('plain user ACK persists one exact event coordinate without claiming completion', async () => {
      mode = 'ack-valid';
      const result = await call('send_session_message', input('exact-ack'), context);
      assert.equal(result.state, 'accepted');
      assert.deepEqual(result.nativeAck, { eventId: 'fixture-user-event', sequence: 1000000051 });
      const saved = JSON.parse(recordText('exact-ack'));
      assert.deepEqual(saved.nativeAck, result.nativeAck);
      assert.equal(result.completion, 'unknown'); assert.equal(result.consumerConfirmed, false);
      assert.ok(!recordText('exact-ack').includes('Offline scoped user input'));
    });
    await t.test('terminal, unknown, wrong-route, restart-required and pending lifecycles cannot dispatch', async () => {
      const before = sends();
      for (const value of ['released-not-ready', 'released-restart', 'released-active-pid', 'released-no-pid', 'released-route', 'released-profile', 'released-transport', 'released-terminal']) {
        mode = value;
        await assert.rejects(call('send_session_message', input(`reject-${value}`), context), { code: 'WAKE_SESSION_NOT_LIVE' });
      }
      mode = 'released-pending';
      await assert.rejects(call('send_session_message', input('released-pending'), context), { code: 'WAKE_APPROVAL_PENDING' });
      mode = 'released-ready';
      await assert.rejects(call('interrupt_session', { requestId: 'released-noop-interrupt', wakerId, sessionId }, context), { code: 'WAKE_SESSION_NOT_LIVE' });
      assert.equal(sends(), before);
    });
    await t.test('empty, multiple, malformed and error ACKs stay unknown forever without re-dispatch', async () => {
      for (const value of ['ack-zero-success', 'ack-empty', 'ack-multi', 'ack-bad-id', 'ack-bad-sequence', 'ack-unsafe-sequence', 'ack-negative-sequence', 'ack-error', 'ack-entry-error']) {
        mode = value;
        const args = input(`invalid-${value}`), result = await call('send_session_message', args, context);
        assert.equal(result.state, 'unknown'); assert.equal(result.nativeAck, undefined);
        const original = recordText(args.requestId), before = sends();
        mode = 'ack-valid';
        assert.equal((await call('send_session_message', args, context)).state, 'unknown');
        assert.equal(sends(), before); assert.equal(recordText(args.requestId), original);
        assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
      }
    });
    await t.test('interrupt event ACK accepts typed string/null metadata without claiming native stopping', async () => {
      for (const value of ['interrupt-ack-valid', 'interrupt-ack-null']) {
        mode = value;
        const args = { requestId: value, wakerId, sessionId }, result = await call('interrupt_session', args, context);
        assert.equal(result.state, 'accepted');
        assert.deepEqual(result.nativeAck, { eventId: 'console-interrupt:control-request:fixture-request', sequence: 1000000191 });
        assert.deepEqual(JSON.parse(recordText(args.requestId)).nativeAck, result.nativeAck);
        assert.equal(result.completion, 'unknown'); assert.equal(result.consumerConfirmed, false);
        assert.equal(result.runtimeState, undefined); assert.ok(!recordText(args.requestId).includes('SIMULATED_STATE'));
      }
    });
    await t.test('invalid interrupt ACK remains unchanged unknown on same-ID retry', async () => {
      for (const value of ['interrupt-ack-bool', 'interrupt-ack-empty', 'interrupt-ack-multi', 'interrupt-ack-bad-type',
        'interrupt-ack-false', 'interrupt-ack-error', 'interrupt-ack-denied', 'interrupt-ack-bad-coordinate']) {
        mode = value;
        const args = { requestId: value, wakerId, sessionId }, result = await call('interrupt_session', args, context);
        assert.equal(result.state, 'unknown'); assert.equal(result.nativeAck, undefined);
        const original = recordText(args.requestId), before = interrupts();
        mode = 'interrupt-ack-valid';
        assert.equal((await call('interrupt_session', args, context)).state, 'unknown');
        assert.equal(interrupts(), before); assert.equal(recordText(args.requestId), original);
        assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
      }
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_QODER_WAKE_CONFIG;
    else process.env.AGENT_QODER_WAKE_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
