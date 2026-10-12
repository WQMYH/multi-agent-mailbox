import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'qoder-return-observe-'));
const date = '2026-10-02T00:00:00.000Z';
const later = '2026-10-02T00:00:02.000Z';
const receipt = (requestId, signal = 'stop_observed', state = 'accepted') => {
  const event = { schemaVersion: 1, requestId, signal, source: 'runtime_hook', observedAt: date,
    workspaceId: 'workspace-one', sessionId: 'session-one', hookSessionId: 'hook-one', turnId: null,
    evidenceRef: `receipt-${signal}-${requestId}.json`, data: {} };
  return { schemaVersion: 1, dedupKey: `${requestId}:${signal}`, event,
    identity: { requestId, signal, workspaceId: event.workspaceId, sessionId: event.sessionId,
      hookSessionId: event.hookSessionId, targetTaskId: 'task-one', targetCwd: temp, cwd: temp },
    receivedAt: date, sent: state === 'accepted', dispatchAttempted: state !== 'recorded', sendState: state,
    ...(state === 'accepted' ? { hostReceipt: { threadId: 'task-one' }, sentAt: later } : {}) };
};
const put = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
const snapshot = dir => readdirSync(dir).sort().map(name => {
  const path = join(dir, name), stat = lstatSync(path);
  return [name, stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? readFileSync(path).toString('base64') : 'directory'];
});
try {
  // Stage source and canonical dependencies only in temp; never build the repository runtime.
  const staged = join(temp, 'module');
  cpSync(moduleDir, staged, { recursive: true, filter: path => !['work', 'node_modules'].includes(path.split(/[\\/]/).at(-1)) });
  for (const name of ['store-budget.mjs', 'event-recorder.mjs'])
    cpSync(join(moduleDir, '../../qoder-codex-bridge/scripts', name), join(staged, 'runtime', name));
  cpSync(join(moduleDir, '../agent-core/src/contracts.mjs'), join(staged, 'runtime/core-contracts.mjs'));
  const store = join(temp, 'records'); mkdirSync(store);
  const config = { returnModulePath: join(temp, 'never-executed.mjs'), returnDataDir: store };
  writeFileSync(config.returnModulePath, 'throw Error("must never execute configured module")');
  const beforeImport = snapshot(store);
  const { observeReturns, RETURN_READ_LIMITS } = await import(pathToFileURL(join(staged, 'return-observe.mjs')));
  const { storeOwnerId } = await import(pathToFileURL(join(staged, 'runtime/store-budget.mjs')));
  assert.deepEqual(snapshot(store), beforeImport);
  assert.equal(observeReturns(config, { view: 'stats' }).stats.total, 0);
  const good = receipt('good'); put(store, good.event.evidenceRef, good);
  const pending = receipt('pending', 'input_observed', 'recorded'); put(store, pending.event.evidenceRef, pending);
  const uncertain = receipt('uncertain', 'error_observed', 'uncertain');
  uncertain.sendError = 'SECRET raw host error pipe token account'; put(store, uncertain.event.evidenceRef, uncertain);
  const native = receipt('native', 'verified_turn_result');
  native.event.source = 'native_turn_observation'; native.event.turnId = 'native-turn';
  native.event.data = { ownerId: 'native-owner', deliveryId: 'native-delivery', canonicalCwd: temp,
    nativeInputId: 'native-input', nativeTurnId: 'native-turn', assistantId: 'native-assistant',
    terminalOutcome: 'completed', evidenceSource: 'native-history', account: 'SECRET' };
  put(store, native.event.evidenceRef, native);
  put(store, 'message-custom.json', { schemaVersion: 1, selectionToken: 'custom', threadId: 'task-two',
    cwd: temp, messageSha256: 'a'.repeat(64), state: 'accepted', createdAt: date, acceptedAt: later,
    token: 'SECRET', message: 'SECRET injected text is not canonical retained body' });
  put(store, 'host.json', { token: 'SECRET', pipe: 'SECRET' });
  put(store, 'submission-hook.json', { requestId: 'fake' });
  put(store, 'receipt-stop_observed-temp.json.123.tmp', good);
  const outside = join(temp, 'outside'); mkdirSync(outside);
  put(outside, 'receipt-stop_observed-secret.json', receipt('secret'));
  symlinkSync(outside, join(store, 'receipt-stop_observed-link.json'), 'junction');
  mkdirSync(join(store, 'message-directory.json'));
  const before = snapshot(store);
  const observed = observeReturns(config, { view: 'items', limit: 100 });
  assert.equal(observed.ownerId, storeOwnerId(store)); assert.equal(observed.items.length, 5);
  assert.equal(observed.coverage.complete, true);
  assert(!JSON.stringify(observed).includes('SECRET'));
  assert(!JSON.stringify(observed).includes(temp));
  for (const item of observed.items) {
    assert.deepEqual(item.content, { status: 'unavailable', reason: 'not_recorded' });
    assert.equal(item.evidence.consumerConfirmed, 'unknown'); assert.equal(item.evidence.businessAccepted, 'unknown');
    assert.equal(item.idKind, 'reservation');
    assert.equal(Object.hasOwn(item, 'nativeOutcome'), false);
    assert.equal(item.evidence.terminalOutcome, item.requestId === 'native' ? 'completed' : 'unknown');
    assert.equal(observeReturns(config, { view: 'detail', deliveryId: item.deliveryId }).item.deliveryId, item.deliveryId);
  }
  assert.equal(observed.items.find(item => item.requestId === 'good').evidence.providerAccepted, true);
  assert.equal(observed.items.find(item => item.requestId === 'good').evidence.terminalOutcome, 'unknown');
  assert.equal(observed.items.find(item => item.requestId === 'native').evidence.terminalOutcome, 'completed');
  assert.equal(observed.items.find(item => item.requestId === 'pending').evidence.providerAccepted, false);
  assert.equal(observed.items.find(item => item.requestId === 'uncertain').evidence.providerAccepted, 'unknown');
  assert.equal(observeReturns(config, { view: 'detail', requestId: 'good' }).item.trace.events.at(-1).kind, 'host_accepted');
  assert.equal(observeReturns(config, { view: 'stats', correlation: 'not-retained' }).stats.total, 0);
  const ids = [], pages = [];
  let cursor;
  do {
    const page = observeReturns(config, { view: 'items', limit: 2, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map(item => item.deliveryId)); pages.push(page); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
  assert.throws(() => observeReturns(config, { view: 'items', cursor: pages[0].nextCursor, requestId: 'good' }), /cursor/);
  assert.equal(observeReturns(config, { view: 'stats' }).stats.total, 5);
  assert.deepEqual(snapshot(store), before);
  const phaseStore = join(temp, 'phases'); mkdirSync(phaseStore);
  for (const signal of ['input_observed', 'stop_observed']) {
    const record = receipt('shared-request', signal); put(phaseStore, record.event.evidenceRef, record);
  }
  const phaseConfig = { ...config, returnDataDir: phaseStore }, phaseBefore = snapshot(phaseStore);
  const phases = observeReturns(phaseConfig, { view: 'items', requestId: 'shared-request' }).items;
  assert.equal(phases.length, 2);
  assert.throws(() => observeReturns(phaseConfig, { view: 'detail', requestId: 'shared-request' }), /deliveryId is required/);
  for (const phase of phases) {
    const detail = observeReturns(phaseConfig, { view: 'detail', requestId: 'shared-request', deliveryId: phase.deliveryId }).item;
    assert.deepEqual(detail, phase);
    assert.equal(detail.evidence.providerAccepted, true);
    assert.equal(detail.evidence.terminalOutcome, 'unknown');
  }
  assert.deepEqual(snapshot(phaseStore), phaseBefore);
  for (const change of [{ sent: false }, { hostReceipt: { threadId: 'wrong' } }, { sentAt: 'bad' }, { dispatchAttempted: false }]) {
    const bad = receipt('bad'); Object.assign(bad, change); put(store, bad.event.evidenceRef, bad);
    const result = observeReturns(config, { view: 'stats' });
    assert.equal(result.stats.total, 'unknown'); assert.equal(result.stats.observedCount, 5);
    assert.equal(result.coverage.complete, false);
  }
  put(store, 'message-notrecord.json', { credentials: 'SECRET' });
  writeFileSync(join(store, 'receipt-stop_observed-huge.json'), 'x'.repeat(RETURN_READ_LIMITS.fileBytes + 1));
  const invalidBefore = snapshot(store);
  assert(observeReturns(config, { view: 'stats' }).coverage.limitations.includes('record_byte_limit'));
  assert.deepEqual(snapshot(store), invalidBefore);
  const missing = join(temp, 'absent');
  const unavailable = observeReturns({ ...config, returnDataDir: missing }, { view: 'stats' });
  assert.equal(unavailable.ownerId, 'unknown'); assert.equal(unavailable.stats.total, 'unknown');
  assert.throws(() => lstatSync(missing), /ENOENT/);
  const bounded = join(temp, 'bounded'); mkdirSync(bounded);
  for (let n = 0; n <= RETURN_READ_LIMITS.entries; n++) mkdirSync(join(bounded, `irrelevant-${n}`));
  const capped = observeReturns({ ...config, returnDataDir: bounded }, { view: 'stats' });
  assert.equal(capped.stats.total, 'unknown'); assert(capped.coverage.limitations.includes('scan_entry_limit'));
  const byteBounded = join(temp, 'byte-bounded'); mkdirSync(byteBounded);
  for (let n = 0; n < 70; n++) {
    const record = receipt(`byte${n}`); record.ignored = 'x'.repeat(62000);
    put(byteBounded, record.event.evidenceRef, record);
  }
  const byteCapped = observeReturns({ ...config, returnDataDir: byteBounded }, { view: 'stats' });
  assert.equal(byteCapped.stats.total, 'unknown'); assert(byteCapped.coverage.limitations.includes('scan_byte_limit'));
  const fakeHome = join(temp, 'home'); mkdirSync(join(fakeHome, '.codex-agent-core'), { recursive: true });
  put(join(fakeHome, '.codex-agent-core'), 'agent-qoder.json', config);
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  for (const key of Object.keys(env))if(key.startsWith('QODER_'))delete env[key];
  const code = `import { call, describe } from ${JSON.stringify(pathToFileURL(join(staged, 'adapter.mjs')).href)};
    const descriptors = await describe();
    const descriptor = descriptors.find(item => item.name === 'message_observe_return');
    if (!descriptor?.annotations.readOnlyHint || !descriptor.annotations.messageObservationHint ||
      descriptors.filter(item => item.annotations.messageObservationHint).length !== 1) throw Error('bad configured descriptor');
    const result = await call('message_observe_return', { view: 'stats' }, {
      startProviderWorker() { throw Error('host must not start'); }, assertCurrent() { throw Error('live scope must not be required'); }
    });
    if (result.ownerId !== ${JSON.stringify(storeOwnerId(store))} || result.stats.total !== 'unknown') throw Error('bad adapter result');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  console.log('Qoder return observation: offline records, privacy, evidence, pagination, bounds, descriptor and byte-preservation checks passed');
} finally {
  // Only this test-created temporary owner is removed; production paths never enter the test.
  rmSync(temp, { recursive: true, force: true });
}
