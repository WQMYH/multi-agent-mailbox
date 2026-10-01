import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { checkMessageBudget } from '../agent-core/src/contracts.mjs';
import { claimWorker, desktop, queueOwnerId, releaseWorker, renewWorker, reservePermission } from './desktop.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-physical-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir: directory };
  const path = join(directory, 'send-queue.sqlite'), trace = [];
  const state = { quota: 10_000_000 };
  const budget = () => ({ schemaVersion: 1, totalBytes: 20_000_000, allocations: [
    { ownerId: queueOwnerId(config), bytes: state.quota },
    { ownerId: 'other-owner', bytes: 20_000_000 - state.quota }
  ] });
  const sizes = () => Object.fromEntries(readdirSync(directory).map(name => [name, statSync(join(directory, name)).size]));
  const context = { providerWorker: true, registrationKey: 'physical-test', messageBudget: {
    status: budget,
    check: input => {
      const result = checkMessageBudget(budget(), input);
      trace.push({ ...result, files: sizes() });
      return result;
    }
  } };
  const args = (requestId, prompt = 'x') => ({ sessionId: 'session-a', requestId, prompt, workspaceId: 'workspace', cwd: 'E:/owned' });
  const send = (id, prompt) => desktop('send', args(id, prompt), config, context);
  return { config, path, trace, state, context, sizes, send };
}

test('9000-byte owner rejects dirty-page growth before marker or native action', async t => {
  const f = fixture(t); f.state.quota = 9000;
  await assert.rejects(f.send('small'), error => error.code === 'QODER_BUDGET_BLOCKED');
  assert.ok(Object.values(f.sizes()).reduce((a, b) => a + b, 0) <= 9000);
  assert.equal(existsSync(join(f.config.deliveryDir, 'small.json')), false);
  assert.equal(f.trace.at(-1).projectedBytes, 131072);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n, 0); }
  finally { db.close(); }
});

test('permission-first persists owner identity, rejects a hard-link alias and rolls back below its exact peak budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-permission-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configs = Object.fromEntries(['p-first','p-alias','p-tight'].map(name => {
    const deliveryDir = join(root, name); mkdirSync(deliveryDir);
    return [name, { cdpPort: 0, workspaceId: 'workspace', root: 'E:/owned', deliveryDir }];
  }));
  const context = (config, quota, trace = []) => {
    const ownerId = queueOwnerId(config);
    const budget = () => ({ schemaVersion: 1, totalBytes: 20_000_000, allocations: [
      { ownerId, bytes: quota }, { ownerId: 'other-owner', bytes: 20_000_000 - quota }
    ] });
    return { messageBudget: { status: budget, check: input => {
      const result = checkMessageBudget(budget(), input); trace.push(result); return result;
    } } };
  };
  const text = JSON.stringify({ sessionId: 'session-a', toolUseId: 'permission-a', state: 'reserved-outcome-unknown' });
  const first = configs['p-first'], firstPath = join(first.deliveryDir, 'send-queue.sqlite'), trace = [];
  assert.equal(reservePermission(first, context(first, 10_000_000, trace), 'a'.repeat(64), text), true);
  const required = Math.max(...trace.map(row => row.projectedBytes));
  const db = new DatabaseSync(firstPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ['queue_meta']);
    assert.deepEqual({ ...db.prepare('SELECT owner_id,queue_path FROM queue_meta').get() }, {
      owner_id: queueOwnerId(first), queue_path: realpathSync.native(firstPath).replaceAll('\\', '/').toLowerCase()
    });
  } finally { db.close(); }

  const alias = configs['p-alias'], aliasPath = join(alias.deliveryDir, 'send-queue.sqlite');
  linkSync(firstPath, aliasPath);
  assert.deepEqual([statSync(firstPath).dev, statSync(firstPath).ino], [statSync(aliasPath).dev, statSync(aliasPath).ino]);
  assert.throws(() => reservePermission(alias, context(alias, 10_000_000), 'b'.repeat(64), text), /owner identity changed/);
  assert.equal(existsSync(join(alias.deliveryDir, `permission-${'b'.repeat(64)}.json`)), false);

  const tight = configs['p-tight'], tightPath = join(tight.deliveryDir, 'send-queue.sqlite'), tightKey = 'c'.repeat(64);
  assert.throws(() => reservePermission(tight, context(tight, required - 1), tightKey, text),
    error => error.code === 'QODER_BUDGET_BLOCKED');
  assert.equal(existsSync(join(tight.deliveryDir, `permission-${tightKey}.json`)), false);
  const rolledBack = new DatabaseSync(tightPath, { readOnly: true });
  try { assert.equal(rolledBack.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n, 0); }
  finally { rolledBack.close(); }
  assert.equal(reservePermission(tight, context(tight, required), tightKey, text), true);
  assert.ok(readdirSync(tight.deliveryDir).reduce((sum, name) => sum + statSync(join(tight.deliveryDir, name)).size, 0) <= required);
  t.diagnostic(JSON.stringify({ permissionFirstRequiredPeak: required,
    finalBytes: readdirSync(tight.deliveryDir).reduce((sum, name) => sum + statSync(join(tight.deliveryDir, name)).size, 0) }));
});

test('page-growth threshold rolls back, then accepts the same request with sufficient peak capacity', async t => {
  const f = fixture(t);
  await assert.rejects(f.send('head'), /cdpPort required/); // Native transport is disabled, not mocked successful.
  const bootstrapPeak = Math.max(...f.trace.map(row => row.projectedBytes));
  const before = readFileSync(f.path), physical = Object.values(f.sizes()).reduce((a, b) => a + b, 0);
  f.state.quota = physical + before.length / 4096 * 4104 + 131072;
  f.trace.length = 0;
  let required;
  await assert.rejects(f.send('tail', 'x'.repeat(32768)), error => {
    required = error.budget.projectedBytes;
    return error.code === 'QODER_BUDGET_BLOCKED';
  });
  assert.deepEqual(readFileSync(f.path), before, 'protected head and main database remain byte-identical');
  assert.ok(f.trace.filter(row => row.ok).length >= 3, 'pre-DML peak check passed; dirty-page check rejected');
  assert.ok(f.trace.at(-1).files['send-queue.sqlite-journal'] > 0);
  assert.equal(existsSync(join(f.config.deliveryDir, 'tail.json')), false);
  f.state.quota = required;
  assert.equal((await f.send('tail', 'x'.repeat(32768))).delivery, 'queued');
  assert.ok(statSync(f.path).size > before.length);
  assert.ok(Object.values(f.sizes()).reduce((a, b) => a + b, 0) <= required);
  t.diagnostic(JSON.stringify({ case: 'threshold', bootstrapPeak, quota: required, files: f.sizes(), rejected: f.trace.find(row => !row.ok) }));
});

test('legacy migration dirty pages and journal are budgeted without dropping legacy data', t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec(`CREATE TABLE sends (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, cwd TEXT NOT NULL, prompt TEXT NOT NULL,
    fingerprint TEXT NOT NULL, state TEXT NOT NULL, native_ack INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  ); INSERT INTO sends(request_id,session_id,workspace_id,cwd,prompt,fingerprint,state,created_at)
    VALUES('old','session-a','workspace','e:/owned','protected','fingerprint','needs_attention','2026-09-26T00:00:00.000Z')`);
  db.close();
  const before = readFileSync(f.path);
  f.state.quota = before.length + before.length / 4096 * 4104 + 131072;
  let required;
  assert.throws(() => claimWorker(f.config, f.context, 'token'), error => {
    required = error.budget.projectedBytes;
    return error.code === 'QODER_BUDGET_BLOCKED';
  });
  assert.deepEqual(readFileSync(f.path), before);
  assert.ok(f.trace.at(-1).files['send-queue.sqlite-journal'] > 0, 'migration ran but never committed');
  f.state.quota = required + 16384;
  assert.equal(claimWorker(f.config, f.context, 'token'), true);
  assert.equal(renewWorker(f.config, 'token', Date.now(), f.context), true);
  releaseWorker(f.config, 'token', f.context);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT prompt,correlation FROM sends').get().prompt, 'protected');
    assert.equal(check.prepare('SELECT prompt,correlation FROM sends').get().correlation, 'old');
  } finally { check.close(); }
  // Lease paths share the same guard, including when an allocation is reduced.
  f.state.quota = statSync(f.path).size;
  assert.throws(() => renewWorker(f.config, 'token', Date.now(), f.context), { code: 'QODER_BUDGET_BLOCKED' });
  assert.throws(() => releaseWorker(f.config, 'token', f.context), { code: 'QODER_BUDGET_BLOCKED' });
});

test('read and write paths reject closed WAL before transient helpers can exceed budget', async t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE protected(value); INSERT INTO protected VALUES(1)');
  db.close();
  const before = readFileSync(f.path);
  assert.equal(before.length, 8192); f.state.quota = 20_000;
  assert.equal(existsSync(`${f.path}-wal`), false); assert.equal(existsSync(`${f.path}-shm`), false);
  const shared = new SharedArrayBuffer(16), counters = new Int32Array(shared);
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const a = new Int32Array(workerData.shared);
    parentPort.postMessage('ready');
    while (!Atomics.load(a,0)) {
      let total=0,helpers=0;
      for(const name of readdirSync(workerData.directory)) try {
        const size=statSync(join(workerData.directory,name)).size; total+=size;
        if(name.endsWith('-wal')||name.endsWith('-shm'))helpers+=size;
      } catch {}
      Atomics.store(a,1,Math.max(Atomics.load(a,1),total));
      Atomics.store(a,2,Math.max(Atomics.load(a,2),helpers));
      Atomics.add(a,3,1);
    }
  `, { eval: true, workerData: { directory: f.config.deliveryDir, shared } });
  let productPeak, productHelpers, calibrationPeak, calibrationHelpers;
  try {
    await once(worker, 'message');
    for (let index = 0; index < 32; index++) {
      await assert.rejects(desktop('queue_status', {
        sessionId: 'session-a', workspaceId: 'workspace', cwd: 'E:/owned'
      }, f.config, f.context), /requires DELETE journal mode/);
      assert.throws(() => claimWorker(f.config, f.context, `token-${index}`), /requires DELETE journal mode/);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    [productPeak, productHelpers] = [counters[1], counters[2]];
    assert.deepEqual(readFileSync(f.path), before);
    Atomics.store(counters, 1, 0); Atomics.store(counters, 2, 0);
    const probe = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(probe.prepare('SELECT value FROM protected').get().value, 1);
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally { probe.close(); }
    [calibrationPeak, calibrationHelpers] = [counters[1], counters[2]];
  } finally {
    const exit = once(worker, 'exit'); Atomics.store(counters, 0, 1); await exit;
  }
  assert.equal(productPeak, 8192); assert.equal(productHelpers, 0);
  assert.ok(calibrationPeak > f.state.quota); assert.ok(calibrationHelpers >= 32_768,
    'sampler catches the transient WAL index that the guarded paths must avoid');
  t.diagnostic(JSON.stringify({ mainBytes: before.length, quota: f.state.quota,
    guardedPeak: productPeak, guardedHelperBytes: productHelpers, calibrationPeak, calibrationHelpers }));
});

test('independent filesystem sampler records commit coexistence beneath the reserved bound', async t => {
  const f = fixture(t);
  await assert.rejects(f.send('head'), /cdpPort required/);
  // All data is temporary; polling is test-only and cannot observe every VFS write.
  const shared = new SharedArrayBuffer(16), counters = new Int32Array(shared);
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const a = new Int32Array(workerData.shared);
    parentPort.postMessage('ready');
    while (!Atomics.load(a,0)) {
      let total=0,journal=0;
      for(const name of readdirSync(workerData.directory)) {
        try { const size=statSync(join(workerData.directory,name)).size; total+=size; if(name.endsWith('-journal'))journal+=size; } catch {}
      }
      Atomics.store(a,1,Math.max(Atomics.load(a,1),total));
      Atomics.store(a,2,Math.max(Atomics.load(a,2),journal));
      Atomics.add(a,3,1);
    }
  `, { eval: true, workerData: { directory: f.config.deliveryDir, shared } });
  try {
    await once(worker, 'message');
    f.trace.length = 0;
    assert.equal((await f.send('large-tail', 'x'.repeat(512000))).delivery, 'queued');
  } finally {
    const exit = once(worker, 'exit'); Atomics.store(counters, 0, 1); await exit;
  }
  const reservedPeak = Math.max(...f.trace.map(row => row.projectedBytes));
  assert.ok(counters[3] > 0); assert.ok(counters[2] > 0);
  assert.ok(counters[1] <= reservedPeak);
  assert.ok(Object.values(f.sizes()).reduce((a, b) => a + b, 0) <= reservedPeak);
  const versionDb = new DatabaseSync(':memory:');
  const sqlite = versionDb.prepare('SELECT sqlite_version() AS v').get().v; versionDb.close();
  t.diagnostic(JSON.stringify({ case: 'sampled-not-exact-peak', sqlite,
    samples: counters[3], sampledBytes: counters[1], sampledJournalBytes: counters[2], reservedPeak, finalFiles: f.sizes() }));
});
