import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { call, describe } from './adapter.mjs';
import { desktop, queueOwnerId, runQueueCycle, observeVerifiedTurn } from './desktop.mjs';
import { verifySdkTurn } from './native.mjs';
import { checkMessageBudget, validateMessageReceipt } from './runtime/core-contracts.mjs';

function desktopFixture(config, context) {
  config.desktopDatabasePath = join(config.root, 'main.sqlite');
  config.desktopArchivePath = join(config.root, 'app.asar');
  const db = new DatabaseSync(config.desktopDatabasePath);
  db.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY,title TEXT,cwd TEXT,workspace_id TEXT,
    execution_kind TEXT,permission_mode TEXT,created_at INTEGER,updated_at INTEGER,execution_target_json TEXT,
    extra_json TEXT,archived INTEGER DEFAULT 0,deleted_at INTEGER,registration_json TEXT);
    CREATE TABLE chat_session_messages (session_id TEXT,message_id TEXT,turn_id TEXT,sequence INTEGER,
    payload_json TEXT,status TEXT,source TEXT,PRIMARY KEY(session_id,message_id),UNIQUE(session_id,sequence),
    FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id));`);
  db.close();
  context.desktopProjection = {
    Projection: class {
      constructor(id, timestamp) { this.id = 'assistant:' + id; this.timestamp = timestamp; }
      applyAssistant(message) { this.text = [this.text, message.message.content.map(part => part.text).join('\n\n')].filter(Boolean).join('\n\n'); }
      snapshot(status) { return { id: this.id, role: 'assistant', text: this.text, timestamp: this.timestamp,
        completedAt: this.completedAt, status, tools: [], parts: [{ type: 'text', text: this.text }] }; }
    },
    writeMessage: (db, sessionId, message, turnId, source) => db.prepare(`INSERT INTO chat_session_messages
      VALUES (?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM chat_session_messages WHERE session_id=?),1),?,?,?)`)
      .run(sessionId,message.id,turnId,sessionId,JSON.stringify(message),'completed',source)
  };
  return () => {
    const db = new DatabaseSync(config.desktopDatabasePath, { readOnly: true });
    try { return db.prepare('SELECT * FROM chat_session_messages ORDER BY sequence').all(); } finally { db.close(); }
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qoder-native-'));
  const config = { root, deliveryDir: join(root, 'delivery'), cliExecutable: join(root, 'qoderclicn.exe'),
    workspaceId: '11111111-1111-4111-8111-111111111111' };
  writeFileSync(config.cliExecutable, 'offline fake, never executed');
  const state = { sessions: new Map(), starts: [], inputs: [], closes: 0, fault: null, startupHook: null,
    closeFault: false, privateError: Error('private SDK stderr must not escape') };
  const sdk = {
    qodercliAuth: () => ({ kind: 'native-login' }),
    getSessionInfo: async (id, options) => {
      const session = state.sessions.get(id);
      return session && (!options?.dir || options.dir === session.cwd) ? { sessionId: id, cwd: session.cwd, summary: 'fixture' } : undefined;
    },
    listSessions: async options => [...state.sessions].filter(([, session]) => session.cwd === options.dir)
      .slice(options.offset, options.offset + options.limit).map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, summary: 'fixture' })),
    getSessionMessages: async (id, options) => state.sessions.get(id)?.messages.slice(options.offset ?? 0,
      (options.offset ?? 0) + (options.limit ?? 500)) ?? [],
    startup: async ({ options }) => {
      state.starts.push(options); state.startupHook?.();
      if (state.fault === 'startup') throw state.privateError;
      return { close: () => {
        state.closes++;
        if (state.closeFault === 'sync') throw state.privateError;
        if (state.closeFault) return Promise.reject(state.privateError);
      }, query: input => (async function* () {
        const messages = [];
        for await (const value of input) messages.push(value);
        assert.equal(messages.length, 1);
        const value = messages[0], sessionId = options.resume ?? options.sessionId;
        assert.equal(value.session_id, sessionId);
        state.inputs.push(value);
        const session = state.sessions.get(sessionId) ?? { cwd: options.cwd, messages: [] };
        state.sessions.set(sessionId, session);
        const assistantId = randomUUID(), resultId = randomUUID();
        const frame = (type, extra) => ({ type, uuid: randomUUID(), session_id: sessionId, ...extra });
        yield frame('command_lifecycle', { state: 'queued', command_uuid: value.uuid });
        if (state.fault === 'crash') throw state.privateError;
        session.messages.push({ ...value, timestamp: '2026-10-09T01:00:00Z' });
        yield frame('command_lifecycle', { state: 'started', command_uuid: state.fault === 'foreign-command' ? randomUUID() : value.uuid });
        const assistant = frame('assistant', { uuid: assistantId, parent_tool_use_id: null, timestamp: '2026-10-09T01:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'offline result' }], stop_reason: 'end_turn' } });
        session.messages.push(assistant); yield assistant;
        if (state.fault === 'multiple-assistants') {
          const later = { ...assistant, uuid: randomUUID() };
          session.messages.push(later); yield later;
        }
        yield frame('result', { uuid: resultId, session_id: state.fault === 'foreign-session' ? randomUUID() : sessionId,
          subtype: 'success', is_error: false, stop_reason: 'end_turn' });
        if (state.fault !== 'missing-completion') yield frame('command_lifecycle', { state: 'completed', command_uuid: value.uuid });
      })() };
    }
  };
  const ownerId = queueOwnerId(config), budget = { schemaVersion: 1, totalBytes: 20_000_000,
    allocations: [{ ownerId, bytes: 20_000_000 }] };
  const context = { nativeSdk: sdk, providerWorker: true, validateMessageReceipt,
    messageBudget: { status: () => budget, check: input => checkMessageBudget(budget, input) } };
  const path = join(config.deliveryDir, 'send-queue.sqlite');
  const row = requestId => {
    const db = new DatabaseSync(path);
    try { return db.prepare('SELECT * FROM sends WHERE request_id=?').get(requestId); } finally { db.close(); }
  };
  const envKeys = ['USERPROFILE', 'HOME', 'QODER_CLI_EXECUTABLE', 'QODER_DESKTOP_CDP_PORT',
    'QODER_CONTROL_ROOT', 'QODER_CONTROL_WORKSPACE_ID', 'QODER_DELIVERY_DIR'];
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.USERPROFILE = root; process.env.HOME = root;
  process.env.QODER_CLI_EXECUTABLE = config.cliExecutable; delete process.env.QODER_DESKTOP_CDP_PORT;
  process.env.QODER_CONTROL_ROOT = root; process.env.QODER_CONTROL_WORKSPACE_ID = config.workspaceId;
  process.env.QODER_DELIVERY_DIR = config.deliveryDir;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('This offline native test must not contact CDP or a network'); };
  t.after(() => {
    globalThis.fetch = fetchBefore;
    for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const invoke = (operation, args, selectedConfig = config, services = context) =>
    desktop(operation, operation === 'message_observe' ? args : { ...args, workspaceId: config.workspaceId, cwd: config.root }, selectedConfig, services);
  return { config, context, state, sdk, row, path, invoke };
}

test('native discovery works without CDP; scoped reads do not start a CLI or infer idle', async t => {
  const f = fixture(t), sessionId = randomUUID(), outsideId = randomUUID();
  f.state.sessions.set(sessionId, { cwd: f.config.root, messages: [{ type: 'user', uuid: randomUUID(), session_id: sessionId,
    parent_tool_use_id: null, message: { role: 'user', content: 'find this native passage' } }] });
  f.state.sessions.set(outsideId, { cwd: join(f.config.root, 'outside'), messages: [] });
  const descriptors = await describe({ ...f.context, desktopCapabilities: async () => [] });
  for (const name of ['identity', 'list_tasks', 'search_task', 'send_new_session', 'queue_status', 'message_observe'])
    assert(descriptors.some(operation => operation.name === name));
  for (const name of ['models', 'interrupt', 'respond_permission', 'read_interactions'])
    assert(!descriptors.some(operation => operation.name === name));
  const list = await call('list_tasks', { limit: 1 }, f.context);
  assert.equal(list.value[0].sessionId, sessionId); assert.equal(list.value[0].runtimeState, 'unknown');
  const hits = await call('search_task', { sessionId, query: 'native' }, f.context);
  assert.equal(hits.value.hits.length, 1); assert.equal(hits.value.hits[0].messageId, f.state.sessions.get(sessionId).messages[0].uuid);
  assert.equal(hits.value.hits[0].turnId, undefined);
  await assert.rejects(call('search_task', { sessionId: outsideId, query: 'native' }, f.context), /operator root/);
  await assert.rejects(call('send', { sessionId, requestId: randomUUID(), prompt: 'not authorized for injection' }, f.context), /unknown\/unsupported/);
  assert.equal(f.state.starts.length, 0); assert.equal(existsSync(f.path), false);
  delete process.env.QODER_CLI_EXECUTABLE;
  const local = await describe({ desktopCapabilities: async () => [] });
  assert.deepEqual(local.map(operation => operation.name).sort(), ['launch', 'message_observe', 'queue_status', 'recover_queue'].sort());
  process.env.QODER_CLI_EXECUTABLE = join(f.config.root, 'missing-cn-cli.exe');
  process.env.QODER_DESKTOP_CDP_PORT = '19327';
  const unavailable = await describe({ desktopCapabilities: async () => ['identity', 'list', 'send', 'models'] });
  assert(unavailable.some(operation => operation.name === 'models'));
  for (const name of ['identity', 'list_tasks', 'send']) assert(!unavailable.some(operation => operation.name === name));
});

test('Core-created native sends retain actual unequal UUIDs, receipts, persistent proof and FIFO resume', async t => {
  const f = fixture(t), sessionId = randomUUID(), requestId = randomUUID();
  const args = { sessionId, requestId, prompt: 'first isolated message', correlation: 'root:source1' };
  const receipt = await call('send_new_session', args, f.context);
  assert.equal(receipt.nativeAck, true); assert.equal(receipt.messageReceipt.correlation, args.correlation);
  assert.equal(receipt.messageReceipt.ownerId, queueOwnerId(f.config));
  assert.equal(receipt.messageReceipt.acceptance.provider.state, 'accepted');
  assert.equal(f.state.inputs[0].client_composed, true, 'governed prompts are literal messages, not native slash commands');
  const first = f.row(requestId), record = JSON.parse(first.native_result);
  assert.equal(first.transport, 'native'); assert.notEqual(record.resultId, requestId);
  assert.notEqual(record.assistantId, requestId); assert.equal(first.observed_at, null);
  assert.equal(f.state.starts[0].pathToQoderCLIExecutable, f.config.cliExecutable);
  assert.deepEqual(f.state.starts[0].auth, { kind: 'native-login' });
  assert.equal(f.state.starts[0].model, undefined); assert.equal(f.state.starts[0].permissionMode, undefined);
  assert.equal((await f.state.starts[0].canUseTool('Bash', {})).behavior, 'deny');
  await runQueueCycle(f.config, f.context);
  const fact = await observeVerifiedTurn({ sessionId, requestId, deliveryId: `qoder-delivery:${requestId}` }, f.config, f.context);
  assert.equal(fact.nativeInputId, requestId); assert.equal(fact.nativeTurnId, requestId);
  assert.equal(fact.assistantId, record.assistantId); assert.equal(fact.evidenceSource, 'qoder-cn:sdk-command-result');
  const secondId = randomUUID();
  const second = await call('send', { sessionId, requestId: secondId, prompt: 'second managed message' }, f.context);
  assert.equal(second.nativeAck, true); assert.equal(f.state.starts[1].resume, sessionId);
  await runQueueCycle(f.config, f.context); assert(f.row(secondId).observed_at);
  assert.equal((await call('send', { sessionId, requestId: secondId, prompt: 'second managed message' }, f.context)).delivery, 'not-resent');
  assert.equal(f.state.inputs.length, 2); assert.equal(f.state.closes, 2);
});

test('native observation never releases a tail from missing input, foreign scope or interleaved history', async t => {
  const f = fixture(t), sessionId = randomUUID(), requestId = randomUUID(), nextId = randomUUID();
  await f.invoke('send_new_session', { sessionId, requestId, prompt: 'first' });
  const history = f.state.sessions.get(sessionId).messages, genuine = structuredClone(history);
  const next = await f.invoke('send', { sessionId, requestId: nextId, prompt: 'next' }, f.config, {
    ...f.context, nativeSdk: { ...f.sdk, getSessionMessages: async () => [] }
  });
  assert.equal(next.delivery, 'queued');
  for (const bad of [genuine.slice(1), genuine.map(message => ({ ...message, session_id: randomUUID() })),
    [genuine[0], { ...genuine[0], uuid: randomUUID() }, genuine[1]]]) {
    f.state.sessions.get(sessionId).messages = bad;
    await runQueueCycle(f.config, f.context);
    assert.equal(f.row(requestId).observed_at, null); assert.equal(f.row(nextId).state, 'queued');
    assert.equal(f.state.inputs.length, 1);
  }
  f.state.sessions.get(sessionId).messages = genuine;
  await runQueueCycle(f.config, f.context);
  assert(f.row(requestId).observed_at); assert.equal(f.state.inputs.length, 2);
});

test('Core creation is not a perpetual idle grant: later external history prevents a second writer', async t => {
  const f = fixture(t), sessionId = randomUUID(), requestId = randomUUID();
  await f.invoke('send_new_session', { sessionId, requestId, prompt: 'owned' });
  await runQueueCycle(f.config, f.context);
  f.state.sessions.get(sessionId).messages.push({ type: 'user', uuid: randomUUID(), session_id: sessionId,
    parent_tool_use_id: null, message: { role: 'user', content: 'outside writer' } });
  const nextId = randomUUID();
  await assert.rejects(f.invoke('send', { sessionId, requestId: nextId, prompt: 'must not run' }), /outcome unknown/);
  assert.equal(f.row(nextId).state, 'needs_attention'); assert.equal(f.state.inputs.length, 1);
  assert.equal(f.state.starts.length, 1);
});

test('bad native lifecycle/result or transport failure stays protected and never changes transport on duplicate', async t => {
  for (const fault of ['foreign-command', 'foreign-session', 'missing-completion', 'crash']) {
    await t.test(fault, async child => {
      const f = fixture(child), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'one attempt' };
      f.state.fault = fault;
      await assert.rejects(f.invoke('send_new_session', args), /outcome unknown/);
      assert.equal(f.row(args.requestId).state, 'needs_attention'); assert.equal(f.row(args.requestId).transport, 'native');
      const switched = { ...f.config, cdpPort: 19327 }; delete switched.cliExecutable;
      const duplicate = await f.invoke('send_new_session', args, switched);
      assert.equal(duplicate.delivery, 'not-resent'); assert.equal(duplicate.completion, 'unknown');
      assert.equal(f.state.starts.length, 1); assert.equal(f.state.inputs.length, 1);
      assert(existsSync(join(f.config.deliveryDir, `${args.requestId}.json`)));
    });
  }
});

test('native failures retain bounded phase codes and private cause, not SDK/frame secrets', async t => {
  for (const [fault, phase, code] of [
    ['startup', 'startup', 'native_startup_failed'], ['crash', 'query', 'native_query_failed'],
    ['foreign-command', 'frame_validation', 'lifecycle_mismatch'], ['foreign-session', 'frame_validation', 'session_mismatch'],
    ['missing-completion', 'frame_validation', 'terminal_incomplete']
  ]) await t.test(fault, async child => {
    const f = fixture(child), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'one attempt' };
    f.state.fault = fault;
    const secret = 'account-extra=SECRET-AUTH-123'; f.state.privateError = Error(secret);
    let captured;
    await assert.rejects(f.invoke('send_new_session', args), error => {
      captured = error;
      assert.deepEqual(error.diagnostics.primary, { phase, code });
      assert.equal(error.diagnostics.retrySafe, false);
      if (['startup', 'crash'].includes(fault)) assert.equal(error.cause, f.state.privateError);
      for (const output of [error.message, error.stack, inspect(error), JSON.stringify(error)]) assert(!output.includes(secret));
      return true;
    });
    const saved = f.row(args.requestId);
    assert.equal(saved.state, 'needs_attention'); assert.equal(saved.native_ack, 0); assert.equal(saved.native_result, null);
    assert.deepEqual(JSON.parse(saved.failure_diagnostics), captured.diagnostics);
    const bytes = readFileSync(f.path), marker = readFileSync(join(f.config.deliveryDir, `${args.requestId}.json`));
    const status = await f.invoke('queue_status', { sessionId: args.sessionId });
    assert.deepEqual(status.items[0].failureDiagnostics, captured.diagnostics);
    const detail = await f.invoke('message_observe', { view: 'detail', requestId: args.requestId });
    assert.deepEqual(detail.item.failureDiagnostics, captured.diagnostics);
    assert(!JSON.stringify({ status, detail }).includes(secret));
    assert.deepEqual(readFileSync(f.path), bytes);
    const duplicate = await f.invoke('send_new_session', args);
    assert.equal(duplicate.delivery, 'not-resent'); assert.equal(f.state.starts.length, 1);
    assert.deepEqual(readFileSync(join(f.config.deliveryDir, `${args.requestId}.json`)), marker);
  });
});

test('sync/async close failures cannot replace a primary query error or invent acceptance', async t => {
  for (const [queryFails, closeFault] of [[true, 'sync'], [true, 'async'], [false, 'async']]) await t.test(`${queryFails}/${closeFault}`, async child => {
    const f = fixture(child), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'once' };
    f.state.closeFault = closeFault; if (queryFails) f.state.fault = 'crash';
    await assert.rejects(f.invoke('send_new_session', args), error => {
      assert.deepEqual(error.diagnostics.primary, queryFails ? { phase: 'query', code: 'native_query_failed' }
        : { phase: 'cleanup', code: 'native_close_failed' });
      assert.deepEqual(error.diagnostics.cleanup, { phase: 'cleanup', code: 'native_close_failed' });
      assert.equal(error.cleanupCause, f.state.privateError);
      assert(!inspect(error).includes(f.state.privateError.message)); return true;
    });
    assert.equal(f.state.closes, 1); assert.equal(f.state.inputs.length, 1);
    assert.equal(f.row(args.requestId).state, 'needs_attention'); assert.equal(f.row(args.requestId).native_ack, 0);
  });
});

test('queue finalization failure preserves primary and close errors, dispatch marker and no-replay', async t => {
  for (const queryFails of [true, false]) await t.test(String(queryFails), async child => {
    const f = fixture(child), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'once' };
    let block = false; const check = f.context.messageBudget.check;
    const privateBudgetError = Object.assign(Error('private budget path/token'), { code: 'QODER_BUDGET_BLOCKED' });
    f.context.messageBudget.check = input => { if (block) throw privateBudgetError; return check(input); };
    f.state.startupHook = () => { block = true; };
    if (queryFails) { f.state.fault = 'crash'; f.state.closeFault = true; }
    await assert.rejects(f.invoke('send_new_session', args), error => {
      assert.deepEqual(error.diagnostics.primary, queryFails ? { phase: 'query', code: 'native_query_failed' }
        : { phase: 'queue_finalize', code: 'queue_finalize_failed' });
      assert.deepEqual(error.diagnostics.finalization, { phase: 'queue_finalize', code: 'queue_finalize_failed' });
      if (queryFails) assert.deepEqual(error.diagnostics.cleanup, { phase: 'cleanup', code: 'native_close_failed' });
      assert.equal(error.finalizationCause, privateBudgetError); assert.equal(error.code, 'QODER_BUDGET_BLOCKED');
      assert(!inspect(error).includes(privateBudgetError.message)); return true;
    });
    block = false;
    const saved = f.row(args.requestId), marker = readFileSync(join(f.config.deliveryDir, `${args.requestId}.json`));
    assert.equal(saved.state, 'dispatching'); assert.equal(saved.native_ack, 0); assert.equal(saved.failure_diagnostics, null);
    assert.equal((await f.invoke('send_new_session', args)).delivery, 'not-resent');
    assert.equal(f.state.starts.length, 1); assert.deepEqual(f.row(args.requestId), saved);
    assert.deepEqual(readFileSync(join(f.config.deliveryDir, `${args.requestId}.json`)), marker);
  });
});

test('legacy diagnostic-free queues remain read-only; multiple root assistants remain valid', async t => {
  const f = fixture(t), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'once' };
  f.state.fault = 'multiple-assistants';
  assert.equal((await f.invoke('send_new_session', args)).nativeAck, true);
  assert.equal(JSON.parse(f.row(args.requestId).native_result).assistantId, f.state.sessions.get(args.sessionId).messages.at(-1).uuid);
  const db = new DatabaseSync(f.path); db.exec('ALTER TABLE sends DROP COLUMN failure_diagnostics'); db.close();
  const before = readFileSync(f.path);
  assert.equal((await f.invoke('queue_status', { sessionId: args.sessionId })).items[0].failureDiagnostics, undefined);
  assert.equal((await f.invoke('message_observe', { view: 'detail', requestId: args.requestId })).item.failureDiagnostics, undefined);
  assert.deepEqual(readFileSync(f.path), before);
});

test('revocation during native handshake closes only the owned connection and sends no user input', async t => {
  const f = fixture(t), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'do not dispatch' };
  let revoked = false;
  f.context.assertCurrent = () => { if (revoked) throw Error('registration revoked'); };
  f.state.startupHook = () => { revoked = true; };
  await assert.rejects(f.invoke('send_new_session', args), /revoked/);
  assert.equal(f.state.inputs.length, 0); assert.equal(f.state.closes, 1);
  assert(existsSync(join(f.config.deliveryDir, `${args.requestId}.json`)));
});

test('stored SDK terminal metadata alone cannot stand in for exact input/history evidence', async t => {
  const f = fixture(t), args = { sessionId: randomUUID(), requestId: randomUUID(), prompt: 'bound input' };
  await f.invoke('send_new_session', args);
  const record = JSON.parse(f.row(args.requestId).native_result);
  assert.equal((await verifySdkTurn(f.sdk, record, args, f.config)).nativeInputId, args.requestId);
  assert.equal(await verifySdkTurn(f.sdk, { ...record, requestId: randomUUID() }, args, f.config), null);
  assert.equal(await verifySdkTurn(f.sdk, record, { ...args, prompt: 'unrelated body' }, f.config), null);
  assert.equal(await verifySdkTurn(f.sdk, { ...record, lifecycle: 'started' }, args, f.config), null);
  f.state.sessions.get(args.sessionId).messages[0].message.content = [{ type: 'text', text: args.prompt }];
  assert.equal((await verifySdkTurn(f.sdk, record, args, f.config)).nativeInputId, args.requestId);
});

test('normal native send synchronizes desktop turns once; read calls do not write or resend', async t => {
  const f = fixture(t), readDesktop = desktopFixture(f.config, f.context), sessionId = randomUUID();
  const firstId = randomUUID(), nextId = randomUUID();
  const receipt = await f.invoke('send_new_session', { sessionId, requestId: firstId, prompt: 'first displayed input' });
  assert.equal(receipt.nativeAck, true); assert.equal(receipt.desktopHistory.state, 'committed');
  assert.equal(receipt.desktopHistory.inserted, 2);
  await runQueueCycle(f.config, f.context);
  const firstRows = readDesktop();
  const next = await f.invoke('send', { sessionId, requestId: nextId, prompt: 'second displayed input' });
  assert.equal(next.desktopHistory.inserted, 2);
  await runQueueCycle(f.config, f.context);
  assert.deepEqual(readDesktop().slice(0,2), firstRows);
  assert.equal(readDesktop().length, 4);
  const status = await f.invoke('queue_status', { sessionId });
  assert(status.items.every(row => row.desktopHistory.state === 'committed'));
  const before = readDesktop();
  await desktop('message_observe', { view: 'items' }, f.config, f.context);
  await f.invoke('queue_status', { sessionId });
  await runQueueCycle(f.config, f.context);
  assert.deepEqual(readDesktop(), before); assert.equal(f.state.inputs.length, 2);
});

test('desktop writer failure does not lose native acceptance; explicit recovery projects without a new native send', async t => {
  const f = fixture(t), readDesktop = desktopFixture(f.config, f.context), sessionId = randomUUID(), requestId = randomUUID();
  const writer = f.context.desktopProjection.writeMessage;
  f.context.desktopProjection.writeMessage = () => { throw Error('isolated desktop writer unavailable'); };
  const receipt = await f.invoke('send_new_session', { sessionId, requestId, prompt: 'preserve this native send' });
  assert.equal(receipt.nativeAck, true); assert.equal(receipt.desktopHistory.state, 'failed');
  assert.equal(f.row(requestId).state, 'awaiting_observation'); assert.equal(readDesktop().length, 0);
  f.context.desktopProjection.writeMessage = writer;
  await runQueueCycle(f.config, f.context);
  assert(f.row(requestId).observed_at); assert.equal(readDesktop().length, 0, 'ordinary cycles do not retry a known failure');
  const recovered = await runQueueCycle(f.config, { ...f.context, retryDesktopHistory: true });
  assert.equal(recovered.desktopHistory[0].state, 'committed'); assert.equal(readDesktop().length, 2);
  assert.equal(f.state.inputs.length, 1); assert.equal(f.state.starts.length, 1);
});
