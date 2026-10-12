import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ModuleRegistry } from '../agent-core/src/registry.mjs';
import { call, queueOwnerId, claimMailWorker } from './adapter.mjs';
import { canonicalDirectory, readReceiverConfig, receiverBinding, probeReceiver, notifyReceiver, processIdentity, consumptionNotice } from './receivers.mjs';
import { runMailWorker, workerContext } from './worker.mjs';
import { NativeHostClient } from './native-host-client.mjs';
import { checkMessageBudget, validateMessageReceipt } from './runtime/core-contracts.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const target = address => ({ moduleId: 'agent-mail', address });
const source = target('sender');
const send = (requestId, mailbox, body = 'the actual retained body') => ({ requestId, source, body, targets: [{ target: mailbox.target }] });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-mail-receiver-'));
  const dbPath = join(root, 'mail', 'queue.sqlite'), configPath = join(root, 'receivers.json'), home = join(root, 'native');
  mkdirSync(home);
  const cleanup = [];
  const saved = { db: process.env.AGENT_MAIL_DB_PATH, config: process.env.AGENT_MAIL_RECEIVERS_PATH };
  process.env.AGENT_MAIL_DB_PATH = dbPath;
  process.env.AGENT_MAIL_RECEIVERS_PATH = configPath;
  t.after(async () => {
    for (const release of cleanup.reverse()) await release();
    if (saved.db === undefined) delete process.env.AGENT_MAIL_DB_PATH; else process.env.AGENT_MAIL_DB_PATH = saved.db;
    if (saved.config === undefined) delete process.env.AGENT_MAIL_RECEIVERS_PATH; else process.env.AGENT_MAIL_RECEIVERS_PATH = saved.config;
    assert.ok(root.startsWith(join(tmpdir(), 'agent-mail-receiver-')));
    rmSync(root, { recursive: true, force: true });
  });
  const ownerId = queueOwnerId(dbPath);
  const budget = { schemaVersion: 1, totalBytes: 200_000_000,
    allocations: [{ ownerId, bytes: 20_000_000 }, { ownerId: 'other', bytes: 180_000_000 }] };
  const notices = [], reachable = new Map();
  const context = { validateMessageReceipt, assertCurrent() {},
    messageBudget: { status: () => budget, check: input => checkMessageBudget(budget, input) },
    mailReceivers: { probe: async config => ({ reachable: reachable.get(config.receiverId) !== false, reason: 'NATIVE_OFFLINE' }),
      notify: async (config, probe, notice) => { notices.push({ config, notice }); return { state: 'accepted', reason: 'NATIVE_TEST_ACCEPTED' }; } } };
  const configure = ids => writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, receivers: ids.map(receiverId => ({
    receiverId, transport: 'claude-peer', sessionId: receiverId === 'desktop'
      ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: root, home })) }));
  const invoke = (operation, args) => call(operation, args, context);
  const rows = sql => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { root, home, configPath, dbPath, ownerId, budget, context, notices, reachable, configure, invoke, rows, cleanup };
}

test('one retained message reaches independent native consumers and exact correlated replies', async t => {
  const f = fixture(t); f.configure(['cli', 'desktop']);
  const alice = await f.invoke('register', { requestId: 'alice', label: 'sender' });
  const bob = await f.invoke('register', { requestId: 'bob', label: 'receiver' });
  const unrelated = await f.invoke('send', send('unrelated-old', bob, 'do not consume this older business message'));
  const cli = await f.invoke('connect_receiver', { receiverId: 'cli', target: bob.target, consumerId: bob.consumers[0] });
  const desktop = await f.invoke('connect_receiver', { receiverId: 'desktop', target: bob.target });
  assert.notEqual(cli.consumerId, desktop.consumerId);
  const args = { ...send('common-message', bob), source: alice.target, replyTo: { ownerId: alice.ownerId, target: alice.target } };
  const sent = await f.invoke('send', args), deliveryId = sent.results[0].deliveryId;
  assert.equal(f.notices.length, 2);
  assert.ok(f.notices.every(({ notice }) => notice.text.includes(deliveryId) && !notice.text.includes(args.body)));
  assert.equal(f.rows("SELECT COUNT(*) n FROM messages WHERE request_id='common-message'")[0].n, 1);
  assert.equal(sent.results[0].messageReceipt.acceptance.provider.state, 'unknown');
  const before = readFileSync(f.dbPath);
  const contacts = await f.invoke('contacts', {});
  assert.deepEqual(new Set(contacts.contacts.find(row => row.target.address === bob.target.address).consumers), new Set([cli.consumerId, desktop.consumerId]));
  assert.equal((await f.invoke('receivers', {})).receivers.length, 2);
  assert.deepEqual(readFileSync(f.dbPath), before, 'status reads do not wake, consume or write');
  await f.invoke('send', args);
  assert.equal(f.notices.length, 2, 'a sender replay never repeats a native action');
  for (const receiver of [cli, desktop]) {
    const readArgs = { target: bob.target, consumerId: receiver.consumerId, deliveryIds: [deliveryId] };
    const fetched = await f.invoke('confirm_and_fetch', readArgs), message = fetched.batch.messages[0];
    assert.equal(message.body, args.body);
    assert.equal(fetched.batch.messages.length, 1);
    assert.deepEqual(message.replyRoute.target, alice.target);
    await f.invoke('send', { requestId: `reply-${receiver.receiverId}`, source: bob.target,
      targets: [{ target: message.replyRoute.target, consumers: message.replyRoute.consumers }],
      correlation: message.correlation, body: `read: ${message.body}` });
    const ack = { batchId: fetched.batch.batchId, deliveryIds: fetched.batch.deliveryIds };
    assert.equal((await f.invoke('confirm_and_fetch', { ...readArgs, ack })).batch, null);
  }
  const observed = await f.invoke('message_observe', { view: 'detail', deliveryId });
  assert.equal(observed.item.evidence.consumerConfirmed, true);
  const unhandled = await f.invoke('inbox', { target: bob.target, consumerId: bob.consumers[0] });
  assert.deepEqual(unhandled.messages.map(row => row.deliveryId), [unrelated.results[0].deliveryId]);
  const replies = await f.invoke('inbox', { target: alice.target, consumerId: alice.consumers[0] });
  assert.equal(replies.messages.length, 2);
  assert.ok(replies.messages.every(row => row.correlation === args.requestId && row.body === `read: ${args.body}`));
});

test('new native consumers receive only explicit history and future sends without default ghost subscriptions', async t => {
  const f = fixture(t); f.configure(['desktop']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  const oldArgs = send('pre-binding', mailbox), old = await f.invoke('send', oldArgs);
  const fingerprint = f.rows("SELECT fingerprint FROM requests WHERE request_id='pre-binding'")[0].fingerprint;
  const receiver = await f.invoke('connect_receiver', { receiverId: 'desktop', target: mailbox.target });
  assert.equal(f.notices.length, 0);
  assert.deepEqual((await f.invoke('inbox', { target: mailbox.target, consumerId: receiver.consumerId })).messages, []);
  assert.equal((await f.invoke('send', oldArgs)).results[0].deliveryId, old.results[0].deliveryId);
  assert.equal(f.rows("SELECT fingerprint FROM requests WHERE request_id='pre-binding'")[0].fingerprint, fingerprint);
  const fresh = await f.invoke('send', send('after-binding', mailbox));
  const subscriptions = f.rows(`SELECT consumer_id FROM subscriptions WHERE delivery_id='${fresh.results[0].deliveryId}'`);
  assert.deepEqual(subscriptions.map(row => row.consumer_id), [receiver.consumerId]);
  await assert.rejects(f.invoke('deliver_pending', { receiverId: 'desktop', deliveryIds: [old.results[0].deliveryId] }), /not subscribed/);
  await f.invoke('connect_receiver', { receiverId: 'desktop', target: mailbox.target, deliveryIds: [old.results[0].deliveryId] });
  assert.equal(f.notices.length, 2, 'one future and one explicitly enrolled old delivery');
  assert.equal(f.rows('SELECT COUNT(*) n FROM messages')[0].n, 2);
  assert.equal(f.rows('SELECT schema_version FROM mail_meta')[0].schema_version, 1);
});

test('exact selection cannot replace an open batch or confirm an unrelated retained message', async t => {
  const f = fixture(t);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  const first = (await f.invoke('send', send('first', mailbox))).results[0].deliveryId;
  const second = (await f.invoke('send', send('second', mailbox))).results[0].deliveryId;
  const readArgs = { target: mailbox.target, consumerId: mailbox.consumers[0] };
  const batch = await f.invoke('confirm_and_fetch', { ...readArgs, limit: 1 });
  const before = readFileSync(f.dbPath);
  await assert.rejects(f.invoke('confirm_and_fetch', { ...readArgs, deliveryIds: [second] }), error => error.code === 'MAIL_BATCH_OPEN');
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.deepEqual((await f.invoke('confirm_and_fetch', { ...readArgs, deliveryIds: [first] })).batch, batch.batch);
  await assert.rejects(f.invoke('confirm_and_fetch', { ...readArgs, deliveryIds: [first],
    ack: { batchId: batch.batch.batchId, deliveryIds: [second] } }), /Ack does not match/);
  await f.invoke('confirm_and_fetch', { ...readArgs, deliveryIds: [second],
    ack: { batchId: batch.batch.batchId, deliveryIds: batch.batch.deliveryIds } });
  assert.equal((await f.invoke('inbox', readArgs)).messages[0].deliveryId, second);
});

test('lost native response remains unknown and cannot replay or prune the original even after confirmation', async t => {
  const f = fixture(t); f.configure(['cli']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, consumerId: mailbox.consumers[0] });
  const secret = 'native-auth-token-must-never-escape';
  f.context.mailReceivers.notify = async (config, probe, notice) => { f.notices.push(notice); throw Error(secret); };
  const sent = await f.invoke('send', send('uncertain', mailbox));
  const deliveryId = sent.results[0].deliveryId;
  assert.equal(sent.results[0].nativeDelivery[0].state, 'unknown');
  assert.equal(JSON.stringify(sent).includes(secret), false);
  const replay = await f.invoke('deliver_pending', { receiverId: 'cli', deliveryIds: [deliveryId] });
  assert.equal(replay.results[0].state, 'unknown'); assert.equal(f.notices.length, 1);
  const readArgs = { target: mailbox.target, consumerId: mailbox.consumers[0], deliveryIds: [deliveryId] };
  const fetched = await f.invoke('confirm_and_fetch', readArgs);
  await f.invoke('confirm_and_fetch', { ...readArgs, ack: { batchId: fetched.batch.batchId, deliveryIds: fetched.batch.deliveryIds } });
  const db = new DatabaseSync(f.dbPath), old = Date.now() - 8 * 86400000;
  db.prepare('UPDATE messages SET created_at=?').run(old);
  db.prepare('UPDATE subscriptions SET acked_at=?').run(new Date(old).toISOString()); db.close();
  await f.invoke('send', send('next', mailbox));
  assert.equal(f.rows(`SELECT COUNT(*) n FROM messages WHERE delivery_id='${deliveryId}'`)[0].n, 1);
});

test('the common dispatcher delivers an offline receiver after recovery and never scans other old pending mail', async t => {
  const f = fixture(t); f.configure(['cli']); f.reachable.set('cli', false);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await f.invoke('send', send('old-unselected', mailbox));
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, consumerId: mailbox.consumers[0] });
  const fresh = await f.invoke('send', send('offline-fresh', mailbox));
  assert.equal(fresh.results[0].nativeDelivery[0].attempted, false);
  assert.equal(f.notices.length, 0);
  const context = { ...f.context, registrationKey: 'test-current-generation', mailDispatcher: true };
  let waits = 0;
  const outcome = await runMailWorker(context, { path: f.dbPath, wait: async () => { waits++; f.reachable.set('cli', true); } });
  assert.equal(outcome.status, 'idle'); assert.equal(waits, 1); assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].notice.text.includes(fresh.results[0].deliveryId));
  assert.equal(f.rows('SELECT COUNT(*) n FROM mail_native_intents')[0].n, 1);
  assert.equal(f.rows('SELECT COUNT(*) n FROM mail_dispatch_worker')[0].n, 0);
  const before = readFileSync(f.dbPath);
  await f.invoke('receivers', {}); await f.invoke('inbox', { target: mailbox.target, consumerId: mailbox.consumers[0] });
  assert.deepEqual(readFileSync(f.dbPath), before);
});

test('registration revocation stops pending native work; worker leases cannot be stolen while current', async t => {
  const f = fixture(t); f.configure(['cli']); f.reachable.set('cli', false);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target });
  await f.invoke('send', send('pending', mailbox));
  let current = true;
  const context = { ...f.context, registrationKey: 'generation', assertCurrent: () => { if (!current) throw Error('disabled'); } };
  assert.equal(claimMailWorker(context, 'owner', 100, f.dbPath), true);
  assert.equal(claimMailWorker(context, 'rival', 200, f.dbPath), false);
  assert.equal(claimMailWorker(context, 'rival', 60101, f.dbPath), true);
  await assert.rejects(runMailWorker(context, { path: f.dbPath, now: () => 120200,
    wait: async () => { current = false; f.reachable.set('cli', true); } }), /disabled/);
  assert.equal(f.notices.length, 0);
  const record = { enabled: 'true', registrationId: 'r', revision: 1 }, registryPath = join(f.root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ modules: { 'agent-mail': record }, messageBudget: f.budget }));
  assert.throws(workerContext(JSON.stringify([registryPath, 'r', 1])).assertCurrent, /disabled/);
});

test('an offline receiver with many old notifications cannot block another live receiver', async t => {
  const f = fixture(t); f.configure(['cli', 'desktop']); f.reachable.set('cli', false); f.reachable.set('desktop', false);
  const offline = await f.invoke('register', { requestId: 'offline', label: 'offline' });
  const online = await f.invoke('register', { requestId: 'online', label: 'online' });
  await f.invoke('connect_receiver', { receiverId: 'cli', target: offline.target });
  await f.invoke('connect_receiver', { receiverId: 'desktop', target: online.target });
  for (let index = 0; index < 10; index++) await f.invoke('send', send(`offline-${index}`, offline));
  await f.invoke('send', send('online-later', online));
  f.reachable.set('desktop', true);
  let waits = 0;
  await runMailWorker({ ...f.context, registrationKey: 'generation' }, { path: f.dbPath, wait: async () => {
    waits++;
    assert.equal(f.notices[0].config.receiverId, 'desktop', 'the later online route advances in the first worker cycle');
    f.reachable.set('cli', true);
  } });
  assert.ok(waits >= 1); assert.equal(f.notices.length, 11);
});

test('budget or registration changes before native dispatch preserve pending or unknown intents without a side effect', async t => {
  const f = fixture(t); f.configure(['cli']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  const before = readFileSync(f.dbPath);
  f.budget.allocations[0].bytes = 100000; f.budget.allocations[1].bytes = 199900000;
  await assert.rejects(f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target }), /budget/);
  assert.deepEqual(readFileSync(f.dbPath), before);
  f.budget.allocations[0].bytes = 20000000; f.budget.allocations[1].bytes = 180000000;
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target });
  let current = true, probes = 0;
  f.context.assertCurrent = () => { if (!current) throw Error('old generation'); };
  f.context.mailReceivers.probe = async () => { if (++probes === 2) current = false; return { reachable: true }; };
  const sent = await f.invoke('send', send('fenced', mailbox));
  assert.equal(sent.results[0].state, 'accepted');
  assert.equal(sent.results[0].nativeDelivery[0].state, 'unknown');
  assert.equal(f.notices.length, 0);
});

test('a short Core CLI starts the common worker and its exact pending delivery arrives after the receiver becomes available', { timeout: 30000 }, async t => {
  if (process.platform !== 'win32') return t.skip('the supplied native Windows PID identity fixture requires Windows');
  const f = fixture(t), registryPath = join(f.root, 'registry.json');
  const core = new ModuleRegistry({ registryPath }); core.install(moduleRoot);
  const state = core.readState(); state.messageBudget = f.budget; writeFileSync(registryPath, JSON.stringify(state));
  f.cleanup.push(() => core.disable('agent-mail'));
  mkdirSync(join(f.home, 'server', 'instances'), { recursive: true });
  const token = 'isolated_cli_native_token_for_test'; writeFileSync(join(f.home, 'server.token'), token);
  const sessionId = 'session-isolated-test';
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 1, receivers: [{ receiverId: 'kimi', transport: 'kimi-server', sessionId, cwd: f.root, home: f.home }] }));
  let online = false, attempts = 0, delivered;
  const delivery = new Promise(resolve => { delivered = resolve; });
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') return response.end(JSON.stringify(online ? { code: 0, data: {
      id: sessionId, metadata: { cwd: f.root }, busy: false, archived: false, pending_interaction: 'none' } } : { code: 40401 }));
    let body = ''; request.on('data', value => { body += value; }); request.on('end', () => {
      attempts++; const prompt = JSON.parse(body);
      response.end(JSON.stringify({ code: 0, data: { prompt_id: prompt.prompt_id, status: 'queued' } })); delivered(prompt);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); f.cleanup.push(() => server.close());
  const identity = await processIdentity(process.pid); assert.ok(identity, 'Windows process identity is readable for the isolated test server');
  const instancePath = join(f.home, 'server', 'instances', 'isolated.json');
  const instance = { server_id: 'isolated', pid: process.pid, host: '127.0.0.1', port: server.address().port, started_at: new Date().toISOString() };
  writeFileSync(instancePath, JSON.stringify(instance));
  const mailbox = await core.agentAct({ moduleId: 'agent-mail', operation: 'register', args: { requestId: 'isolated', label: 'isolated receiver' } });
  await core.agentAct({ moduleId: 'agent-mail', operation: 'connect_receiver', args: { receiverId: 'kimi', target: mailbox.target, consumerId: mailbox.consumers[0] } });
  const cli = join(moduleRoot, '..', 'agent-core', 'src', 'cli.mjs');
  const sent = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--registry', registryPath, 'act'], { windowsHide: true,
      env: { ...process.env, AGENT_MAIL_DB_PATH: f.dbPath, AGENT_MAIL_RECEIVERS_PATH: f.configPath } });
    let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(errors)));
    child.stdin.end(JSON.stringify({ moduleId: 'agent-mail', operation: 'send', args: send('offline-via-core-cli', mailbox) }));
  });
  assert.equal(sent.results[0].state, 'accepted'); assert.equal(sent.results[0].nativeDelivery[0].attempted, false);
  online = true; writeFileSync(instancePath, JSON.stringify({ ...instance, heartbeat_at: new Date().toISOString() }));
  const timeout = setTimeout(() => delivered(null), 20000);
  const prompt = await delivery; clearTimeout(timeout); assert.ok(prompt, 'the exited CLI worker delivers after native recovery');
  assert.ok(prompt.content[0].text.includes(sent.results[0].deliveryId));
  assert.equal(prompt.content[0].text.includes('the actual retained body'), false);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && (f.rows("SELECT state FROM mail_native_intents")[0].state !== 'accepted' || f.rows('SELECT COUNT(*) n FROM mail_dispatch_worker')[0].n))
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.rows('SELECT state FROM mail_native_intents')[0].state, 'accepted');
  assert.equal(f.rows('SELECT COUNT(*) n FROM mail_dispatch_worker')[0].n, 0);
  assert.equal(attempts, 1);
  const fetched = await core.agentAct({ moduleId: 'agent-mail', operation: 'confirm_and_fetch', args: {
    target: mailbox.target, consumerId: mailbox.consumers[0], deliveryIds: [sent.results[0].deliveryId] } });
  assert.equal(fetched.batch.messages[0].body, 'the actual retained body');
});

test('multiprocess notification contenders claim one original delivery and issue one native side effect', async t => {
  const f = fixture(t); f.configure(['cli']); f.reachable.set('cli', false);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  const deliveryId = (await f.invoke('send', send('original', mailbox))).results[0].deliveryId;
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, consumerId: mailbox.consumers[0], deliveryIds: [deliveryId] });
  let attempts = 0;
  const server = createServer((request, response) => { attempts++; request.resume(); response.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/notification`;
  const script = `import { call } from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'adapter.mjs')).href)};
    import { checkMessageBudget } from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'runtime/core-contracts.mjs')).href)};
    const budget = ${JSON.stringify(f.budget)};
    const context = { assertCurrent() {}, messageBudget: { status: () => budget, check: input => checkMessageBudget(budget, input) },
      mailReceivers: { probe: async () => ({ reachable: true }), notify: async () => {
        await fetch(${JSON.stringify(url)}, { method: 'POST', body: 'notification' }); return { state: 'accepted', reason: 'NATIVE_TEST_ACCEPTED' }; } } };
    console.log(JSON.stringify(await call('deliver_pending', { receiverId: 'cli', deliveryIds: [${JSON.stringify(deliveryId)}] }, context)));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true,
      env: { ...process.env, AGENT_MAIL_DB_PATH: f.dbPath, AGENT_MAIL_RECEIVERS_PATH: f.configPath } });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
  });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(attempts, 1);
  assert.ok(results.every(result => ['accepted', 'unknown'].includes(result.results[0].state)));
  assert.equal(f.rows('SELECT COUNT(*) n FROM messages')[0].n, 1);
  assert.equal(f.rows('SELECT COUNT(*) n FROM mail_native_intents')[0].n, 1);
});

test('trusted configuration rejects model-selected paths and secrets and isolates disabled or changed bindings', async t => {
  const f = fixture(t); f.configure(['cli']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await assert.rejects(f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, configPath: 'arbitrary' }), /Unknown/);
  const secret = 'do-not-print-this-credential';
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 1, receivers: [{ receiverId: 'cli', token: secret }] }));
  assert.throws(() => readReceiverConfig(), error => !error.message.includes(secret) && error.code === 'MAIL_RECEIVER_CONFIG_INVALID');
  f.configure(['cli']); await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target });
  const config = JSON.parse(readFileSync(f.configPath, 'utf8')); config.receivers[0].enabled = false;
  writeFileSync(f.configPath, JSON.stringify(config));
  assert.equal((await f.invoke('receivers', {})).receivers[0].reason, 'RECEIVER_DISABLED');
  config.receivers[0].enabled = true; config.receivers[0].sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  writeFileSync(f.configPath, JSON.stringify(config));
  assert.equal((await f.invoke('receivers', {})).receivers[0].reason, 'RECEIVER_BINDING_CHANGED');
  await assert.rejects(f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target }), /immutable/);
  assert.equal(f.notices.length, 0);
});

test('Claude native driver uses peer authentication and reports only submission; stale process metadata fails closed', async t => {
  const f = fixture(t); f.configure(['cli']);
  const config = readReceiverConfig()[0], directory = join(f.home, 'sessions'); mkdirSync(directory);
  const peerToken = '0123456789abcdef0123456789abcdef', startFt = '134361887241595820';
  const metadata = { sessionId: config.sessionId, pid: 123, cwd: f.root, procStart: startFt, pidDomain: 'win32:test',
    peerProtocol: 1, messagingSocketPath: '\\\\.\\pipe\\isolated-agent-mail-test' };
  writeFileSync(join(directory, '123.json'), JSON.stringify(metadata));
  writeFileSync(join(directory, '123.unique.key'), JSON.stringify({ peerToken, procStart: startFt, pidDomain: metadata.pidDomain }));
  const services = { processIdentity: async () => ({ startFt, startMs: 1 }) };
  const probe = await probeReceiver(config, services); assert.equal(probe.reachable, true);
  const { EventEmitter } = await import('node:events');
  const socket = new EventEmitter(); let written;
  socket.destroy = () => {}; socket.end = text => { written = text; socket.emit('finish'); };
  const notice = { nativeId: '11111111-1111-5111-8111-111111111111', text: 'only original delivery coordinates' };
  const result = notifyReceiver(config, probe, notice, { connect: () => { queueMicrotask(() => socket.emit('connect')); return socket; } });
  assert.equal((await result).state, 'submitted');
  const frames = written.trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames[0], { type: 'auth', token: peerToken });
  assert.deepEqual(frames[1], { type: 'user', session_id: config.sessionId, msg_id: notice.nativeId,
    message: { role: 'user', content: notice.text }, priority: 'next' });
  assert.equal(JSON.stringify(await result).includes(peerToken), false);
  assert.equal((await probeReceiver(config, { processIdentity: async () => ({ startFt: '134361887241595821', startMs: 1 }) })).reachable, false);
});

test('Kimi native driver uses the same session API and preserves queued, blocked, refused and uncertain outcomes', async t => {
  const f = fixture(t), directory = join(f.home, 'server', 'instances'); mkdirSync(directory, { recursive: true });
  const token = 'isolated_native_token_for_test_only'; writeFileSync(join(f.home, 'server.token'), token);
  const config = { receiverId: 'kimi', transport: 'kimi-server', sessionId: 'session-existing', home: canonicalDirectory(f.home), cwd: canonicalDirectory(f.root), enabled: true };
  writeFileSync(join(directory, 'instance.json'), JSON.stringify({ host: '127.0.0.1', port: 12345, pid: 1, started_at: '2026-01-01T00:00:00Z' }));
  const services = { processIdentity: async () => ({ startFt: '0', startMs: Date.parse('2025-12-31') }), fetch: async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(url, 'http://127.0.0.1:12345/api/v1/sessions/session-existing');
    assert.equal(options.method, 'GET');
    return { ok: true, json: async () => ({ code: 0, data: { id: config.sessionId, metadata: { cwd: f.root }, busy: false, archived: false } }) };
  } };
  const probe = await probeReceiver(config, services); assert.equal(probe.reachable, true);
  const notice = { nativeId: '11111111-1111-5111-8111-111111111111', text: 'fetch the retained original' };
  for (const [code, status, expected] of [[0, 'queued', 'accepted'], [0, 'blocked', 'held'], [40912, null, 'refused'], [40927, null, 'unknown']]) {
    const response = await notifyReceiver(config, probe, notice, { fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:12345/api/v1/sessions/session-existing/prompts');
      assert.deepEqual(JSON.parse(options.body), { prompt_id: notice.nativeId, content: [{ type: 'text', text: notice.text }] });
      return { ok: true, json: async () => ({ code, data: { prompt_id: notice.nativeId, status } }) };
    } });
    assert.equal(response.state, expected); assert.equal(JSON.stringify(response).includes(token), false);
  }
  const unknown = await notifyReceiver(config, probe, notice, { fetch: async () => { throw Error(token); } });
  assert.equal(unknown.state, 'unknown'); assert.equal(JSON.stringify(unknown).includes(token), false);
  assert.equal(receiverBinding({ ...config, enabled: false }), receiverBinding(config));
});

test('Codex native host verifies the bound current thread and uses the existing MCP message primitive', async t => {
  const f = fixture(t), script = join(f.root, 'isolated-host.mjs'), hostConfigPath = join(f.root, 'host-config.json');
  writeFileSync(script, '// isolated fixture; the actual process transport is supplied below');
  writeFileSync(hostConfigPath, JSON.stringify({ threadId: 'root-current-thread', cwd: f.root,
    script, pipePath: '\\\\.\\pipe\\codex-browser-use-isolated-test' }));
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 1, receivers: [{ receiverId: 'root',
    transport: 'codex-host', sessionId: 'root-current-thread', cwd: f.root, home: f.home, hostConfigPath }] }));
  const config = readReceiverConfig()[0], frames = [];
  let mismatch = false;
  class FixtureHostClient extends NativeHostClient {
    constructor(binding) {
      super(binding, { spawnProcess: (exe, args, options) => {
        assert.equal(args[0], script); assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, '\\\\.\\pipe\\codex-browser-use-isolated-test');
        assert.equal(options.windowsHide, true);
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new PassThrough(); child.unref = () => {}; child.kill = () => { child.killed = true; return true; };
        child.stdin.on('data', chunk => {
          for (const line of chunk.toString().trim().split('\n')) {
            const frame = JSON.parse(line); frames.push(frame);
            let result;
            if (frame.method === 'initialize') result = { protocolVersion: '2025-06-18' };
            else if (frame.method === 'tools/call') {
              assert.equal(frame.params._meta.codexThreadId, 'root-current-thread');
              const value = frame.params.name === 'read_thread' ? { thread: { id: mismatch ? 'foreign-thread' : 'root-current-thread', cwd: f.root, status: 'running' } }
                : { threadId: 'root-current-thread' };
              result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
            }
            if (result) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n'));
          }
        });
        return child;
      } });
    }
  }
  const probe = await probeReceiver(config, { HostClient: FixtureHostClient }); assert.equal(probe.reachable, true);
  const result = await notifyReceiver(config, probe, { nativeId: '11111111-1111-5111-8111-111111111111', text: 'only retained mail coordinates' }, { HostClient: FixtureHostClient });
  assert.equal(result.state, 'accepted'); assert.equal(result.reason, 'CODEX_HOST_NATIVE_ACCEPTED');
  const sends = frames.filter(frame => frame.params?.name === 'send_message_to_thread');
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].params.arguments, { threadId: config.sessionId, prompt: 'only retained mail coordinates' });
  assert.ok(frames.filter(frame => frame.params?.name === 'read_thread').every(frame => frame.params.arguments.maxOutputCharsPerItem === 0));
  mismatch = true;
  assert.equal((await probeReceiver(config, { HostClient: FixtureHostClient })).reachable, false);
  assert.equal(frames.filter(frame => frame.params?.name === 'send_message_to_thread').length, 1);
});

test('optional common Core CLI context comes only from operator configuration and does not rebind the native session', async t => {
  const f = fixture(t); f.configure(['cli']);
  const originalConfig = readReceiverConfig()[0], config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  config.coreClient = { cliPath: join(moduleRoot, '..', 'agent-core', 'src', 'cli.mjs'), registryPath: join(f.root, 'private-registry.json') };
  writeFileSync(f.configPath, JSON.stringify(config));
  assert.equal(receiverBinding(readReceiverConfig()[0]), receiverBinding(originalConfig));
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await assert.rejects(f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, coreClient: config.coreClient }), /Unknown/);
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target });
  await f.invoke('send', send('operator-client', mailbox));
  assert.ok(f.notices[0].notice.text.includes(JSON.stringify(config.coreClient.registryPath)));
  assert.ok(f.notices[0].notice.text.includes(JSON.stringify(f.dbPath)));
  const directory = await f.invoke('receivers', {});
  assert.equal(JSON.stringify(directory).includes(config.coreClient.registryPath), false);
});

test('native hold and refusal remain separate from consumption and are never replayed', async t => {
  const f = fixture(t); f.configure(['cli']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target });
  for (const state of ['held', 'refused']) {
    f.context.mailReceivers.notify = async (config, probe, notice) => { f.notices.push(notice); return { state, reason: `NATIVE_${state.toUpperCase()}` }; };
    const sent = await f.invoke('send', send(state, mailbox)), deliveryId = sent.results[0].deliveryId;
    assert.equal(sent.results[0].nativeDelivery[0].state, state);
    assert.equal((await f.invoke('deliver_pending', { receiverId: 'cli', deliveryIds: [deliveryId] })).results[0].state, state);
    assert.equal((await f.invoke('message_observe', { view: 'detail', deliveryId })).item.evidence.consumerConfirmed, false);
  }
  assert.equal(f.notices.length, 2);
});

test('native Codex cleanup failures preserve a known admission and cannot mask a primary dispatch failure', async t => {
  const f = fixture(t), script = join(f.root, 'helper.mjs'), hostConfigPath = join(f.root, 'host-config.json');
  writeFileSync(script, '// fixture');
  writeFileSync(hostConfigPath, JSON.stringify({ threadId: 'root-current-thread', cwd: f.root,
    script, pipePath: '\\\\.\\pipe\\isolated-host-test' }));
  const config = { receiverId: 'root', transport: 'codex-host', sessionId: 'root-current-thread',
    cwd: canonicalDirectory(f.root), home: canonicalDirectory(f.home), hostConfigPath, enabled: true };
  let failDispatch = false;
  class FailingCleanupClient {
    async initialize() {}
    async call(name) {
      if (name === 'read_thread') return { thread: { id: config.sessionId, cwd: f.root } };
      if (failDispatch) throw Error('private primary native diagnostic');
      return { threadId: config.sessionId };
    }
    close() { throw Error('private secondary cleanup diagnostic'); }
  }
  const services = { HostClient: FailingCleanupClient }, probe = await probeReceiver(config, services);
  const notice = { nativeId: '11111111-1111-5111-8111-111111111111', text: 'notify original delivery' };
  assert.equal(probe.reachable, true);
  const accepted = await notifyReceiver(config, probe, notice, services);
  assert.deepEqual(accepted, { state: 'accepted', reason: 'CODEX_HOST_NATIVE_ACCEPTED_CLEANUP_FAILED' });
  failDispatch = true;
  const unknown = await notifyReceiver(config, probe, notice, services);
  assert.deepEqual(unknown, { state: 'unknown', reason: 'CODEX_HOST_DISPATCH_UNKNOWN_CLEANUP_FAILED' });
  assert.equal(JSON.stringify([accepted, unknown]).includes('private'), false);
});

test('Codex issuer context stays the operator while a different verified target receives the notification', async t => {
  const f = fixture(t), script = join(f.root, 'helper.mjs'), hostConfigPath = join(f.root, 'host-config.json'), targetCwd = join(f.root, 'target');
  mkdirSync(targetCwd); writeFileSync(script, '// fixture');
  writeFileSync(hostConfigPath, JSON.stringify({ threadId: 'operator-root', cwd: f.root, script,
    pipePath: '\\\\.\\pipe\\isolated-host-test' }));
  const config = { receiverId: 'target', transport: 'codex-host', sessionId: 'other-native-target',
    cwd: canonicalDirectory(targetCwd), home: canonicalDirectory(f.home), hostConfigPath, enabled: true };
  const frames = []; let wrongIssuer = false, wrongTargetCwd = false;
  class FixtureHostClient extends NativeHostClient {
    constructor(binding) {
      super(binding, { spawnProcess: () => {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new PassThrough(); child.kill = () => { child.killed = true; return true; };
        child.stdin.on('data', chunk => {
          for (const line of chunk.toString().trim().split('\n')) {
            const frame = JSON.parse(line); frames.push(frame);
            let result;
            if (frame.method === 'initialize') result = { protocolVersion: '2025-06-18' };
            else if (frame.method === 'tools/call') {
              assert.equal(frame.params._meta.codexThreadId, 'operator-root');
              const targetId = frame.params.arguments.threadId;
              const value = frame.params.name === 'send_message_to_thread' ? { threadId: targetId }
                : { thread: { id: wrongIssuer && targetId === 'operator-root' ? 'foreign-issuer' : targetId,
                  cwd: targetId === 'operator-root' || wrongTargetCwd ? f.root : targetCwd, status: 'running' } };
              result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
            }
            if (result) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n'));
          }
        });
        return child;
      } });
    }
  }
  const services = { HostClient: FixtureHostClient }, probe = await probeReceiver(config, services);
  assert.equal(probe.reachable, true);
  assert.deepEqual(frames.filter(frame => frame.params?.name === 'read_thread').map(frame => frame.params.arguments.threadId), ['operator-root', 'other-native-target']);
  const notice = { nativeId: '11111111-1111-5111-8111-111111111111', text: 'read original delivery' };
  assert.equal((await notifyReceiver(config, probe, notice, services)).state, 'accepted');
  const sent = frames.filter(frame => frame.params?.name === 'send_message_to_thread');
  assert.equal(sent.length, 1); assert.equal(sent[0].params.arguments.threadId, 'other-native-target');
  wrongIssuer = true;
  assert.equal((await probeReceiver(config, services)).reachable, false);
  wrongIssuer = false; wrongTargetCwd = true;
  assert.equal((await probeReceiver(config, services)).reachable, false);
  assert.equal((await notifyReceiver(config, probe, notice, services)).state, 'unknown');
  assert.equal(frames.filter(frame => frame.params?.name === 'send_message_to_thread').length, 1, 'identity failures occur before dispatch');
});

test('native session aliases cannot bypass a prior unknown intent after operator configuration is renamed', async t => {
  const f = fixture(t); f.configure(['cli']);
  const mailbox = await f.invoke('register', { requestId: 'recipient', label: 'recipient' });
  await f.invoke('connect_receiver', { receiverId: 'cli', target: mailbox.target, consumerId: mailbox.consumers[0] });
  f.context.mailReceivers.notify = async (config, probe, notice) => { f.notices.push(notice); throw Error('lost response'); };
  const sent = await f.invoke('send', send('original-unknown', mailbox)), deliveryId = sent.results[0].deliveryId;
  assert.equal(sent.results[0].nativeDelivery[0].state, 'unknown');
  const config = JSON.parse(readFileSync(f.configPath, 'utf8')), alias = { ...config.receivers[0], receiverId: 'alias' };
  const original = config.receivers[0];
  config.receivers = [alias]; writeFileSync(f.configPath, JSON.stringify(config));
  const before = readFileSync(f.dbPath);
  await assert.rejects(f.invoke('connect_receiver', { receiverId: 'alias', target: mailbox.target, deliveryIds: [deliveryId] }),
    error => error.code === 'MAIL_RECEIVER_CONFLICT');
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.equal(f.notices.length, 1); assert.equal(f.rows('SELECT COUNT(*) n FROM mail_native_intents')[0].n, 1);
  assert.equal(f.rows('SELECT state FROM mail_native_intents')[0].state, 'unknown');
  config.receivers = [original, alias]; writeFileSync(f.configPath, JSON.stringify(config));
  assert.throws(() => readReceiverConfig(), error => error.code === 'MAIL_RECEIVER_CONFIG_INVALID');
});

test('Kimi authentication refusal is distinguished from an offline session without reading a denied body', async t => {
  const f = fixture(t), directory = join(f.home, 'server', 'instances'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(f.home, 'server.token'), 'isolated_native_token_for_test');
  const config = { receiverId: 'kimi', transport: 'kimi-server', sessionId: 'session-existing',
    home: canonicalDirectory(f.home), cwd: canonicalDirectory(f.root), enabled: true };
  const instance = { host: '127.0.0.1', port: 12345, pid: 1, started_at: '2026-01-01T00:00:00Z' };
  writeFileSync(join(directory, 'instance.json'), JSON.stringify(instance));
  for (const status of [401, 403]) {
    const services = { processIdentity: async () => ({ startFt: '0', startMs: Date.parse('2025-12-31') }), fetch: async () => ({
      ok: false, status, json: async () => { throw Error('denied bodies must not be needed'); }
    }) };
    const probe = await probeReceiver(config, services);
    assert.deepEqual(probe, { reachable: false, reason: 'KIMI_AUTH_REFUSED' });
    const result = await notifyReceiver(config, { instance }, { nativeId: '11111111-1111-5111-8111-111111111111', text: 'original delivery coordinates' }, services);
    assert.deepEqual(result, { state: 'refused', reason: 'KIMI_PROMPT_AUTH_REFUSED' });
  }
});

test('changing issuer paths or unused home cannot give one Codex receiving session two native identities', async t => {
  const f = fixture(t), receiver = { receiverId: 'target', transport: 'codex-host', sessionId: 'other-native-target',
    cwd: f.root, home: f.home, hostConfigPath: join(f.root, 'issuer-one.json') };
  const alias = { ...receiver, receiverId: 'alias', hostConfigPath: join(f.root, 'issuer-two.json'), home: f.root };
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 1, receivers: [receiver, alias] }));
  assert.throws(() => readReceiverConfig(), error => error.code === 'MAIL_RECEIVER_CONFIG_INVALID');
  assert.equal(receiverBinding(receiver), receiverBinding(alias), 'issuer path and unused home are not the receiving native identity');
});

test('operator-selected Core CLI context governs discovery, fetch, any requested reply and exact acknowledgement without MCP fallback', t => {
  const f = fixture(t), coreClient = { cliPath: join(moduleRoot, '..', 'agent-core', 'src', 'cli.mjs'), registryPath: join(f.root, 'private-registry.json') };
  const route = { ownerId: f.ownerId, target: target('recipient'), consumerId: 'reader', deliveryId: 'mail:original', queuePath: f.dbPath };
  const configured = consumptionNotice(route, coreClient), ordinary = consumptionNotice(route);
  assert.match(configured, /Use only the operator-selected Core CLI instance for all mail discovery, reading, any requested reply send, and acknowledgement/);
  assert.ok(configured.includes(JSON.stringify({ ...coreClient, queuePath: f.dbPath })));
  assert.ok(configured.includes('{"moduleId":"agent-mail"} as JSON stdin for discover'));
  assert.match(configured, /Do not mix these calls with loaded MCP or another registry/);
  assert.equal(configured.includes('Use the existing Core agent_discover/agent_read/agent_act tools'), false);
  assert.equal(configured.includes('when the currently loaded MCP schema lacks deliveryIds'), false);
  assert.match(configured, /If that message requests a reply/);
  assert.match(configured, /Do not automatically reply to a receipt/);
  assert.ok(configured.includes(JSON.stringify({ target: route.target, consumerId: route.consumerId, deliveryIds: [route.deliveryId] })));
  assert.match(ordinary, /Use the existing Core agent_discover\/agent_read\/agent_act tools/);
  assert.equal(ordinary.includes('operator-selected Core CLI instance'), false);
});

test('null and non-object native host frames fail pending requests without escaping the line callback', async () => {
  for (const frame of [null, true, 1, 'frame', []]) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    const client = new NativeHostClient({ threadId: 'issuer', script: 'isolated-fixture', pipePath: '\\\\.\\pipe\\isolated-fixture' },
      { spawnProcess: () => child, timeoutMs: 1000 });
    const rejected = assert.rejects(client.request('tools/call', {}), /disconnected/);
    try {
      assert.doesNotThrow(() => child.stdout.write(JSON.stringify(frame) + '\n'));
      await rejected;
      assert.equal(client.closed, true); assert.equal(client.pending.size, 0);
      await assert.rejects(client.request('tools/call', {}), /disconnected/);
    } finally { client.close(); }
  }
});
