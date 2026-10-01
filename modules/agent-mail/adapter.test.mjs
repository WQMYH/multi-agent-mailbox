import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ModuleRegistry } from '../agent-core/src/registry.mjs';
import { checkMessageBudget, validateMessageReceipt } from '../agent-core/src/contracts.mjs';
import { call, queueOwnerId } from './adapter.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const cliPath = join(moduleRoot, '..', 'agent-core', 'src', 'cli.mjs');
const mcpPath = join(moduleRoot, '..', 'agent-core', 'src', 'mcp-server.mjs');
const target = address => ({ moduleId: 'agent-mail', address });
const sendArgs = (requestId, addresses = ['alpha'], body = 'same text') => ({
  requestId, source: { moduleId: 'codex', address: 'source-a' }, body, teamId: 'team-label',
  targets: addresses.map(address => ({ target: target(address), consumers: ['reader-a', 'reader-b'] }))
});
const envelope = (operation, args) => ({ moduleId: 'agent-mail', operation, args });

function fixture(t, quota = 1_000_000, allocated = true) {
  const root = mkdtempSync(join(tmpdir(), 'agent-mail-test-'));
  const registryPath = join(root, 'registry.json'), dbPath = join(root, 'mail', 'queue.sqlite');
  process.env.AGENT_MAIL_DB_PATH = dbPath;
  t.after(() => {
    delete process.env.AGENT_MAIL_DB_PATH;
    assert.ok(root.startsWith(join(tmpdir(), 'agent-mail-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  const registry = new ModuleRegistry({ registryPath });
  registry.install(moduleRoot); // Private registry only; no product installation.
  const state = registry.readState();
  state.messageBudget = { schemaVersion: 1, totalBytes: 200_000_000,
    allocations: allocated ? [
      { ownerId: queueOwnerId(dbPath), bytes: quota },
      { ownerId: 'test-other-queue', bytes: 200_000_000 - quota }
    ] : [{ ownerId: 'test-other-queue', bytes: 200_000_000 }] };
  writeFileSync(registryPath, JSON.stringify(state));
  const env = { ...process.env, AGENT_CORE_REGISTRY: registryPath, AGENT_MAIL_DB_PATH: dbPath };
  return { root, registry, registryPath, dbPath, env,
    act: (operation, args) => registry.agentAct(envelope(operation, args)),
    read: (operation, args) => registry.agentRead(envelope(operation, args)) };
}

function cli(f, kind, operation, args) {
  const result = spawnSync(process.execPath, [cliPath, '--registry', f.registryPath, kind], {
    input: JSON.stringify(envelope(operation, args)), encoding: 'utf8', env: f.env, timeout: 20_000
  });
  return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : null };
}

function mcp(f, kind, operation, args) {
  const name = kind === 'read' ? 'agent_read' : 'agent_act';
  const result = spawnSync(process.execPath, [mcpPath], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name, arguments: envelope(operation, args) } }) + '\n',
    encoding: 'utf8', env: f.env, timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  return response.result.isError ? { error: response.result.content[0].text }
    : { value: JSON.parse(response.result.content[0].text) };
}

function cliAsync(f, operation, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--registry', f.registryPath, 'act'], { env: f.env });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
    child.stdin.end(JSON.stringify(envelope(operation, args)));
  });
}

test('CLI and MCP discovery publish the complete mail input contract without creating a mailbox', async t => {
  const f = fixture(t);
  const discovered = await f.registry.agentDiscover({ moduleId: 'agent-mail' });
  const cliResult = spawnSync(process.execPath, [cliPath, '--registry', f.registryPath, 'discover'], {
    input: JSON.stringify({ moduleId: 'agent-mail' }), encoding: 'utf8', env: f.env, timeout: 20_000
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.deepEqual(JSON.parse(cliResult.stdout), discovered);
  const mcpResult = spawnSync(process.execPath, [mcpPath], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'agent_discover', arguments: { moduleId: 'agent-mail' } } }) + '\n',
    encoding: 'utf8', env: f.env, timeout: 20_000
  });
  assert.equal(mcpResult.status, 0, mcpResult.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(mcpResult.stdout).result.content[0].text), discovered);
  assert.equal(existsSync(f.dbPath), false);
  const schemas = Object.fromEntries(discovered.operations.map(op => [op.name, op.inputSchema]));
  const send = schemas.send.properties, entry = send.targets.items.properties;
  assert.deepEqual(send.source.required, ['moduleId', 'address']);
  assert.equal(entry.target.properties.moduleId.const, 'agent-mail');
  assert.deepEqual(send.targets.items.required, ['target']);
  assert.equal(entry.consumers.uniqueItems, true);
  assert.equal(entry.consumers.maxItems, 8);
  assert.equal(send.targets.maxItems, 16);
  assert.match(send.body.description, /8192 UTF-8 bytes/);
  assert.match(send.source.description, /not authenticated human authority/);
  assert.match(send.replyTo.description, /complete replyRoute/);
  assert.deepEqual(send.replyTo.required, ['ownerId', 'target']);
  assert.deepEqual(schemas.inbox.properties.target, entry.target);
  const ack = schemas.confirm_and_fetch.properties.ack;
  assert.deepEqual(ack.required, ['batchId', 'deliveryIds']);
  assert.equal(ack.properties.deliveryIds.maxItems, 32);
  for (const schema of [send.source, entry.target, send.targets.items, send.replyTo, ack])
    assert.equal(schema.additionalProperties, false);
  for (const value of ['request-1', 'mail:uuid', 'sender_name'])
    assert.ok(new RegExp(send.requestId.pattern).test(value));
  for (const value of ['', 'bad name', 'x'.repeat(129)])
    assert.equal(new RegExp(send.requestId.pattern).test(value), false);
  discovered.operations.find(op => op.name === 'send').inputSchema.properties.source.required.push('mutated');
  assert.deepEqual((await f.registry.agentDiscover({ moduleId: 'agent-mail' })).operations.find(op => op.name === 'send').inputSchema.properties.source.required,
    ['moduleId', 'address'], 'caller edits must not alter later discovery');
});

test('register and contacts label schemas match runtime Unicode and control constraints', async t => {
  const f = fixture(t);
  const operations = (await f.registry.agentDiscover({ moduleId: 'agent-mail' })).operations;
  const schema = operations.find(op => op.name === 'register').inputSchema.properties.label;
  assert.deepEqual(schema, operations.find(op => op.name === 'contacts').inputSchema.properties.label);
  const valid = ['测试', ' padded label ', '😀'.repeat(65), '😀'.repeat(128)];
  const invalid = ['', ' ', '\u00a0\ufeff', 'name\n', 'name\r', 'name\u007f', 'x\u2028\u0000', '😀'.repeat(129)];
  for (const [index, value] of [...valid, ...invalid].entries()) {
    const allowed = typeof value === 'string' && [...value].length >= schema.minLength &&
      [...value].length <= schema.maxLength && new RegExp(schema.pattern, 'u').test(value);
    assert.equal(allowed, valid.includes(value));
    if (allowed) {
      const registered = await f.act('register', { requestId: `label-${index}`, label: value });
      assert.equal(registered.label, value);
      assert.equal((await f.read('contacts', { label: value })).contacts.length, 1);
    } else {
      await assert.rejects(f.act('register', { requestId: `label-${index}`, label: value }), /label must/);
      await assert.rejects(f.read('contacts', { label: value }), /label must/);
    }
  }
});

test('registered sessions discover exact routes and reply using only received metadata across CLI and MCP', async t => {
  const f = fixture(t, 2_000_000);
  assert.deepEqual((await f.read('contacts', {})).contacts, []);
  assert.equal(existsSync(f.dbPath), false, 'discovery is not registration');
  const alice = cli(f, 'act', 'register', { requestId: 'alice-session', label: '测试智能体' }).value;
  const bob = mcp(f, 'act', 'register', { requestId: 'bob-session', label: '测试智能体' }).value;
  assert.ok(alice && bob);
  assert.notEqual(alice.target.address, bob.target.address, 'labels are not routing identities');
  assert.equal(bob.presence, 'unknown');
  assert.deepEqual(bob.capabilities, { delivery: 'pull', nativeWake: false });
  const before = readFileSync(f.dbPath);
  const page = mcp(f, 'read', 'contacts', { label: '测试智能体', limit: 1 }).value;
  const rest = cli(f, 'read', 'contacts', { label: '测试智能体', limit: 1, afterAddress: page.nextAfterAddress }).value;
  assert.deepEqual(new Set([...page.contacts, ...rest.contacts].map(c => c.target.address)),
    new Set([alice.target.address, bob.target.address]));
  assert.equal(rest.nextAfterAddress, null);
  assert.deepEqual(readFileSync(f.dbPath), before, 'listing routes does not modify the queue');
  const args = { requestId: 'alice-to-bob', source: alice.target,
    targets: [{ target: bob.target }], body: 'Please reply.',
    replyTo: { ownerId: alice.ownerId, target: alice.target } };
  const sent = cli(f, 'act', 'send', args).value;
  assert.equal(sent.results[0].state, 'accepted');
  const readArgs = { target: bob.target, consumerId: bob.consumers[0] };
  const received = mcp(f, 'act', 'confirm_and_fetch', readArgs).value;
  const message = received.batch.messages[0];
  assert.deepEqual(message.replyRoute, { ownerId: alice.ownerId, target: alice.target, consumers: alice.consumers });
  const reply = mcp(f, 'act', 'send', { requestId: 'bob-reply', source: bob.target,
    targets: [{ target: message.replyRoute.target, consumers: message.replyRoute.consumers }],
    correlation: message.correlation, body: 'Received.', replyTo: { ownerId: bob.ownerId, target: bob.target } }).value;
  assert.equal(reply.results[0].state, 'accepted');
  const returnMail = cli(f, 'read', 'inbox', { target: alice.target, consumerId: alice.consumers[0] }).value.messages;
  assert.equal(returnMail[0].correlation, args.requestId);
  assert.deepEqual(returnMail[0].source, bob.target);
  assert.deepEqual(returnMail[0].replyRoute.consumers, bob.consumers);
  assert.deepEqual(mcp(f, 'act', 'send', args).value, sent, 'reconciled request retains original receipt');
  const ack = { batchId: received.batch.batchId, deliveryIds: received.batch.deliveryIds };
  assert.equal(cli(f, 'act', 'confirm_and_fetch', { ...readArgs, ack }).value.batch, null);
  assert.equal(mcp(f, 'act', 'confirm_and_fetch', { ...readArgs, ack }).value.batch, null);
});

test('contact registration is durable, concurrent-idempotent and cannot redirect a prior session', async t => {
  const f = fixture(t, 2_000_000);
  const args = { requestId: 'session-key', label: 'pi' };
  const registrations = await Promise.all(Array.from({ length: 5 }, () => cliAsync(f, 'register', args)));
  assert.equal(new Set(registrations.map(c => c.target.address)).size, 1);
  const original = registrations[0];
  assert.deepEqual(mcp(f, 'act', 'register', args).value, original);
  await assert.rejects(f.act('register', { ...args, label: 'someone-else' }), /conflict/);
  const replacement = await f.act('register', { requestId: 'new-session-key', label: 'pi' });
  assert.notEqual(replacement.target.address, original.target.address);
  const send = { requestId: 'old-session-send', source: target('sender'), body: 'Original only', targets: [{ target: original.target }] };
  assert.equal((await f.act('send', send)).results[0].state, 'accepted');
  assert.equal((await f.read('inbox', { target: original.target, consumerId: original.consumers[0] })).messages.length, 1);
  assert.equal((await f.read('inbox', { target: replacement.target, consumerId: replacement.consumers[0] })).messages.length, 0);
  for (const consumers of [null, [], ['guessed-reader'], replacement.consumers])
    await assert.rejects(f.act('send', { ...send, requestId: 'bad-route', targets: [{ target: original.target, consumers }] }));
  await assert.rejects(f.act('send', { ...send, requestId: 'unknown-route', targets: [{ target: target('absent') }] }), /consumers/);
  assert.equal((await f.read('contacts', { label: 'pi' })).contacts.length, 2);
});

test('additive contacts preserve legacy mail and fingerprints; tight or unallocated registration rolls back', async t => {
  const f = fixture(t, 2_000_000);
  const old = sendArgs('legacy-mail');
  const receipt = await f.act('send', old);
  const raw = new DatabaseSync(f.dbPath, { readOnly: true });
  const fingerprint = raw.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(old.requestId).fingerprint;
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='mail_contacts'").get().n, 0);
  raw.close();
  await f.act('register', { requestId: 'new-registration', label: 'new recipient' });
  assert.deepEqual(await f.act('send', old), receipt);
  const reopened = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(reopened.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(old.requestId).fingerprint, fingerprint);
  assert.equal(reopened.prepare('SELECT schema_version FROM mail_meta').get().schema_version, 1);
  reopened.close();
  const absent = fixture(t, 500_000, false);
  await assert.rejects(absent.act('register', { requestId: 'unallocated', label: 'blocked' }), /budget/);
  assert.equal(existsSync(dirname(absent.dbPath)), false);
  const tight = fixture(t, 150_000);
  await assert.rejects(tight.act('register', { requestId: 'tight', label: 'blocked' }), /budget/);
  assert.deepEqual((await tight.read('contacts', {})).contacts, []);
});

test('CLI and MCP share the Core route; inbox is byte-for-byte read-only', async t => {
  const f = fixture(t);
  const args = sendArgs('request-1', ['alpha', 'beta']);
  const sent = cli(f, 'act', 'send', args);
  assert.equal(sent.status, 0, sent.stderr);
  assert.deepEqual(sent.value.results.map(result => result.state), ['accepted', 'accepted']);
  assert.ok(sent.value.results.every(result => result.messageReceipt.acceptance.provider.state === 'unknown'));
  assert.deepEqual(mcp(f, 'act', 'send', args).value, sent.value, 'same ID and content re-fetch the same durable receipts');
  const bytes = readFileSync(f.dbPath);
  const preview = mcp(f, 'read', 'inbox', { target: target('alpha'), consumerId: 'reader-a' }).value;
  assert.equal(preview.messages.length, 1);
  assert.equal(preview.consumption, 'unconfirmed_preview');
  assert.deepEqual(readFileSync(f.dbPath), bytes);
  assert.equal(existsSync(`${f.dbPath}-journal`), false);
  assert.match(mcp(f, 'act', 'inbox', { target: target('alpha'), consumerId: 'reader-a' }).error, /read-only/);
  assert.equal(cli(f, 'read', 'send', args).status, 1);
  assert.equal(cli(f, 'act', 'resend', args).status, 1);
  assert.deepEqual(readFileSync(f.dbPath), bytes, 'unsupported dispatch did not reach storage');
  assert.equal(cli(f, 'act', 'send', { ...args, body: 'different' }).status, 1);
  assert.match(cli(f, 'act', 'send', { ...args, body: 'different' }).stderr, /requestId conflict/);
  const fresh = cli(f, 'act', 'send', sendArgs('request-2', ['alpha']));
  assert.equal(fresh.value.results[0].state, 'accepted');
  assert.notEqual(fresh.value.results[0].deliveryId, sent.value.results[0].deliveryId);
});

test('Qoder and ZCode may choose mail addresses while their dedicated adapters are registered', async t => {
  const f = fixture(t);
  f.registry.install(join(moduleRoot, '..', 'agent-qoder'));
  f.registry.install(join(moduleRoot, '..', 'agent-zcode'));
  assert.deepEqual(f.registry.list().map(module => module.id).sort(), ['agent-mail', 'agent-qoder', 'agent-zcode']);
  const args = { ...sendArgs('mail-channel-choice', ['agent-qoder', 'agent-zcode']),
    source: { moduleId: 'agent-qoder', address: 'qoder-sender' } };
  const sent = await f.act('send', args);
  assert.deepEqual(sent.results.map(result => result.state), ['accepted', 'accepted']);
  assert.ok(sent.results.every(result => result.messageReceipt.target.moduleId === 'agent-mail' &&
    result.messageReceipt.acceptance.provider.state === 'unknown'));
  for (const address of ['agent-qoder', 'agent-zcode']) {
    const inbox = await f.read('inbox', { target: target(address), consumerId: 'reader-a' });
    assert.equal(inbox.messages.length, 1);
    assert.deepEqual(inbox.messages[0].source, args.source);
    const fetched = await f.act('confirm_and_fetch', { target: target(address), consumerId: 'reader-a' });
    assert.equal(fetched.batch.messages[0].deliveryId, inbox.messages[0].deliveryId);
    const confirmed = await f.act('confirm_and_fetch', { target: target(address), consumerId: 'reader-a',
      ack: { batchId: fetched.batch.batchId, deliveryIds: fetched.batch.deliveryIds } });
    assert.equal(confirmed.confirmed.batchId, fetched.batch.batchId);
  }
});

test('exact per-consumer batches survive ACK loss and reject guessed or foreign confirmations', async t => {
  const f = fixture(t);
  for (const requestId of ['r1', 'r2', 'r3']) assert.equal((await f.act('send', sendArgs(requestId))).results[0].state, 'accepted');
  const preview = await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' });
  assert.equal(preview.messages.length, 3);
  const first = cli(f, 'act', 'confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a', limit: 2 }).value;
  assert.equal(first.batch.messages.length, 2);
  const repeat = mcp(f, 'act', 'confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a', limit: 1 }).value;
  assert.deepEqual(repeat.batch, first.batch, 'unconfirmed batch is redelivered unchanged after a restart');
  const ack = { batchId: first.batch.batchId, deliveryIds: first.batch.deliveryIds };
  await assert.rejects(f.act('confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-b', ack }), /Ack does not match/);
  await assert.rejects(f.act('confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a',
    ack: { ...ack, deliveryIds: [ack.deliveryIds[0]] } }), /Ack does not match/);
  const second = cli(f, 'act', 'confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a', ack }).value;
  assert.deepEqual(second.confirmed, ack);
  assert.equal(second.batch.messages.length, 1);
  const lostAck = mcp(f, 'act', 'confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a', ack }).value;
  assert.deepEqual(lostAck.batch, second.batch, 'retrying a lost ACK does not skip the next batch');
  assert.equal((await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' })).messages.length, 1);
  assert.equal((await f.read('inbox', { target: target('alpha'), consumerId: 'reader-b' })).messages.length, 3,
    'the other consumer has its own confirmation state');
});

test('multiprocess same-target writes remain FIFO and other targets can advance', async t => {
  const f = fixture(t, 3_000_000);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    cliAsync(f, 'send', sendArgs(`parallel-${i}`, ['alpha']))));
  assert.ok(results.every(result => result.results[0].state === 'accepted'));
  const inbox = await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' });
  assert.equal(inbox.messages.length, 12);
  assert.deepEqual(inbox.messages.map(message => message.sequence),
    [...inbox.messages.map(message => message.sequence)].sort((a, b) => a - b));
  assert.equal(new Set(inbox.messages.map(message => message.deliveryId)).size, 12);
  const retries = await Promise.all(Array.from({ length: 6 }, () =>
    cliAsync(f, 'send', sendArgs('same-parallel-id', ['alpha']))));
  assert.equal(new Set(retries.map(result => result.results[0].deliveryId)).size, 1,
    'concurrent retries have one durable delivery');
  const blocked = await f.act('confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a', limit: 1 });
  assert.equal(blocked.batch.messages.length, 1);
  const other = await f.act('send', sendArgs('other-target', ['beta']));
  assert.equal(other.results[0].state, 'accepted');
  const fetched = await f.act('confirm_and_fetch', { target: target('beta'), consumerId: 'reader-a' });
  assert.equal(fetched.batch.messages[0].requestId, 'other-target');
});

test('a partial multi-target send returns stable accepted receipts and can finish after capacity is granted', async t => {
  const f = fixture(t, 340_000);
  const args = sendArgs('partial-request', Array.from({ length: 8 }, (_, i) => `target-${i}`), 'x'.repeat(8192));
  const first = await f.act('send', args);
  const accepted = first.results.filter(result => result.state === 'accepted');
  const rejected = first.results.filter(result => result.state === 'rejected');
  assert.ok(accepted.length > 0 && rejected.length > 0);
  assert.ok(rejected.every(result => result.reason === 'MAIL_BUDGET_BLOCKED'));
  const state = f.registry.readState();
  state.messageBudget.allocations.find(allocation => allocation.ownerId === queueOwnerId(f.dbPath)).bytes = 1_000_000;
  state.messageBudget.allocations.find(allocation => allocation.ownerId === 'test-other-queue').bytes = 199_000_000;
  writeFileSync(f.registryPath, JSON.stringify(state));
  const retried = await f.act('send', args);
  assert.ok(retried.results.every(result => result.state === 'accepted'));
  for (const result of accepted) assert.equal(retried.results.find(next => next.target.address === result.target.address).deliveryId,
    result.deliveryId, 'a retry does not redeliver an already accepted target');
  assert.equal(retried.results.length, 8);
});

test('concurrent same-ID admission has one receipt even near the physical limit', async t => {
  const f = fixture(t, 340_000);
  const args = sendArgs('tight-parallel', ['alpha'], 'x'.repeat(8192));
  const results = await Promise.all(Array.from({ length: 8 }, () => cliAsync(f, 'send', args)));
  assert.ok(results.every(result => result.results[0].state === 'accepted'));
  assert.equal(new Set(results.map(result => result.results[0].deliveryId)).size, 1);
});

test('retention prunes only fully confirmed old records', async t => {
  const f = fixture(t);
  await f.act('send', sendArgs('finished-old'));
  await f.act('send', sendArgs('protected-old'));
  for (const consumerId of ['reader-a', 'reader-b']) {
    const batch = await f.act('confirm_and_fetch', { target: target('alpha'), consumerId, limit: 1 });
    await f.act('confirm_and_fetch', { target: target('alpha'), consumerId,
      ack: { batchId: batch.batch.batchId, deliveryIds: batch.batch.deliveryIds }, limit: 1 });
  }
  const database = new DatabaseSync(f.dbPath);
  try {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    database.prepare('UPDATE messages SET created_at=?').run(Date.parse(old));
    database.prepare("UPDATE subscriptions SET acked_at=? WHERE delivery_id=(SELECT delivery_id FROM messages WHERE request_id='finished-old')")
      .run(old);
  } finally { database.close(); }
  assert.equal((await f.act('send', sendArgs('new-message'))).results[0].state, 'accepted');
  const pending = await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' });
  assert.deepEqual(pending.messages.map(message => message.requestId), ['protected-old', 'new-message']);
  const verify = new DatabaseSync(f.dbPath, { readOnly: true });
  try { assert.deepEqual(verify.prepare('SELECT request_id FROM messages ORDER BY seq').all().map(row => row.request_id),
    ['protected-old', 'new-message']); }
  finally { verify.close(); }
});

test('a stale registration guard rolls back an in-flight local admission', async t => {
  const f = fixture(t);
  const budget = f.registry.messageBudget();
  let checks = 0;
  const context = { assertCurrent: () => { if (++checks === 4) throw Error('old registration generation'); },
    validateMessageReceipt, messageBudget: { status: () => budget,
      check: input => checkMessageBudget(budget, input) } };
  const outcome = await call('send', sendArgs('stale-generation'), context);
  assert.equal(outcome.results[0].state, 'rejected');
  assert.match(outcome.results[0].detail, /old registration generation/);
  assert.deepEqual((await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' })).messages, []);
});

test('unallocated owner rejects before file creation; bounded protected data backpressures', async t => {
  const absent = fixture(t, 500_000, false);
  const refused = await absent.act('send', sendArgs('not-allocated'));
  assert.equal(refused.results[0].state, 'rejected');
  assert.equal(refused.results[0].reason, 'MAIL_BUDGET_BLOCKED');
  assert.equal(existsSync(dirname(absent.dbPath)), false);
  // Independent private registry and owner; the full 200 MB remains explicitly allocated.
  const f = fixture(t, 340_000);
  let accepted = 0, rejected;
  for (let i = 0; i < 60; i++) {
    const result = (await f.act('send', sendArgs(`capacity-${i}`, ['alpha'], 'x'.repeat(8192)))).results[0];
    if (result.state === 'rejected') { rejected = result; break; }
    assert.equal(result.state, 'accepted'); accepted++;
  }
  assert.ok(accepted > 0, 'the quota admits at least one message');
  assert.equal(rejected?.reason, 'MAIL_BUDGET_BLOCKED');
  assert.equal((await f.act('send', sendArgs('capacity-0', ['alpha'], 'x'.repeat(8192)))).results[0].state,
    'accepted', 'a protected receipt remains retrievable after backpressure');
  assert.equal((await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' })).messages.length, accepted);
  const batch = await f.act('confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a' });
  assert.ok(batch.batch?.messages.length > 0, 'previously accepted mail remains claimable at capacity');
  const acknowledged = await f.act('confirm_and_fetch', { target: target('alpha'), consumerId: 'reader-a',
    ack: { batchId: batch.batch.batchId, deliveryIds: batch.batch.deliveryIds } });
  assert.equal(acknowledged.confirmed.batchId, batch.batch.batchId);
  const used = readdirSync(dirname(f.dbPath)).reduce((sum, name) => sum + statSync(join(dirname(f.dbPath), name)).size, 0);
  assert.ok(used <= 340_000, `physical owner bytes ${used} exceeded quota`);
  t.diagnostic(JSON.stringify({ accepted, usedBytes: used, quota: 340_000 }));
  f.registry.disable('agent-mail');
  await assert.rejects(f.act('send', sendArgs('old-generation')), /Module disabled/);
  assert.equal((await f.read('inbox', { target: target('alpha'), consumerId: 'reader-a' }).catch(e => e.message)),
    'Module disabled: agent-mail');
});
