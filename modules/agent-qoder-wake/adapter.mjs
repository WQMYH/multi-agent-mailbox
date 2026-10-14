import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const target = { id: 'qoderwake-cn', kind: 'native-daemon', label: 'Operator-scoped QoderWake CN' };
const stringId = { type: 'string', pattern: ID.source, maxLength: 128 };
const text = { type: 'string', minLength: 1, maxLength: 8000 };
const safeSequence = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const definitions = [
  ['identity', true, {}, [], 'Read the configured native CLI version and daemon identity; no authentication changes. Conversation messages, Run/Trace, terminal stop/resume and approval resolution are not exposed.'],
  ['list_wakers', true, {}, [], 'List only operator-allowed local Wakers.'],
  ['list_sessions', true, { wakerId: stringId }, ['wakerId'], 'List current native Session metadata within the allowed Waker and project directories.'],
  ['session_status', true, { wakerId: stringId, sessionId: stringId }, ['wakerId', 'sessionId'], 'Read one exact existing Session; never derive a Conversation ID.'],
  ['read_session_events', true, { wakerId: stringId, sessionId: stringId, fromSequence: safeSequence,
    limit: { type: 'integer', minimum: 1, maximum: 64 } }, ['wakerId', 'sessionId'], 'Read a bounded native SSE history window from the inclusive fromSequence: input/assistant/result/runtime-state only. No history completeness or consumer confirmation is inferred.'],
  ['list_approvals', true, { wakerId: stringId, sessionId: stringId }, ['wakerId', 'sessionId'], 'Read pending native Tool Guard request coordinates for one exact Session; cannot approve them.'],
  ['request_receipt', true, { requestId: stringId }, ['requestId'], 'Read an adapter receipt without native contact or resend.'],
  ['create_session', false, { requestId: stringId, wakerId: stringId, cwd: { type: 'string', minLength: 1 }, message: text, title: { type: 'string', minLength: 1, maxLength: 512 } }, ['requestId', 'wakerId', 'cwd', 'message'], 'Create one native Session with plain initial user input in an allowed project directory. Native has no caller idempotency key; unknown outcomes never replay.'],
  ['send_session_message', false, { requestId: stringId, wakerId: stringId, sessionId: stringId, message: text }, ['requestId', 'wakerId', 'sessionId', 'message'], 'Send plain user input to an existing live Session, including the proven resident or exact SDK-released waiting-input lifecycles. One native input event ACK is required. No terminal-session recovery, execution or reading is promised.'],
  ['interrupt_session', false, { requestId: stringId, wakerId: stringId, sessionId: stringId }, ['requestId', 'wakerId', 'sessionId'], 'Request interruption of an existing running or idle Session; acknowledgement does not prove it stopped.']
].map(([name, readOnlyHint, properties, required, description]) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint } }));

function canonical(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) { missing.unshift(basename(current)); current = dirname(current); }
  let value = join(realpathSync.native(current), ...missing);
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith('\\\\?\\')) value = value.slice(4);
    value = value.toLowerCase();
  }
  return value;
}
const within = (root, path) => { const rel = relative(root, path); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const absolute = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0');

export function readConfig(env = process.env) {
  const path = env.AGENT_QODER_WAKE_CONFIG ?? join(homedir(), '.codex-agent-core', 'agent-qoder-wake.json');
  try {
    if (!absolute(path)) fail('WAKE_CONFIG_INVALID');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (!plain(config) || Object.keys(config).some(key => !['cliExecutable', 'home', 'allowedWakerIds', 'allowedRoots', 'receiptDir'].includes(key)) ||
        !['cliExecutable', 'home', 'receiptDir'].every(key => absolute(config[key])) ||
        !statSync(config.cliExecutable).isFile() || !statSync(config.home).isDirectory() ||
        !Array.isArray(config.allowedWakerIds) || !config.allowedWakerIds.length || !config.allowedWakerIds.every(id => typeof id === 'string' && ID.test(id)) ||
        new Set(config.allowedWakerIds).size !== config.allowedWakerIds.length ||
        !Array.isArray(config.allowedRoots) || !config.allowedRoots.length || !config.allowedRoots.every(root => absolute(root) && statSync(root).isDirectory())) fail('WAKE_CONFIG_INVALID');
    return { cliExecutable: canonical(config.cliExecutable), home: canonical(config.home), receiptDir: canonical(config.receiptDir),
      allowedWakerIds: [...config.allowedWakerIds].sort(), allowedRoots: config.allowedRoots.map(canonical).sort() };
  } catch { fail('WAKE_CONFIG_INVALID'); }
}

export const receiptOwnerId = config => `agent-qoder-wake:${hash(config.receiptDir).slice(0, 32)}`;
export async function describe() { return structuredClone(definitions); }

function validate(operation, args) {
  const definition = definitions.find(item => item.name === operation);
  if (!definition || !plain(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) fail('WAKE_ARGUMENT_INVALID');
  for (const name of definition.inputSchema.required) if (!Object.hasOwn(args, name)) fail('WAKE_ARGUMENT_INVALID');
  for (const [key, value] of Object.entries(args)) {
    const rule = definition.inputSchema.properties[key];
    if (rule.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) fail('WAKE_ARGUMENT_INVALID');
      continue;
    }
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > (rule.maxLength ?? 4096) ||
        rule.pattern && !ID.test(value)) fail('WAKE_ARGUMENT_INVALID');
  }
  return !definition.annotations.readOnlyHint;
}

function assertActive(config, context, mutating = false) {
  if (mutating && (typeof context.registrationKey !== 'string' || !context.registrationKey || typeof context.assertCurrent !== 'function')) fail('WAKE_CORE_CONTEXT_REQUIRED');
  try { context.assertCurrent?.(); } catch { fail('WAKE_REGISTRATION_CHANGED'); }
  if (hash(readConfig()) !== hash(config)) fail('WAKE_CONFIG_CHANGED');
}

async function capture(config, args, context, observing = false) {
  assertActive(config, context);
  const env = { ...process.env, QODERWAKE_HOME: config.home };
  // The operator home selects the native daemon; do not inherit another Waker's injected daemon URL.
  delete env.QODERWAKE_DAEMON_URL;
  let output;
  try {
    output = await new Promise((accept, reject) => (context.execFile ?? execFile)(config.cliExecutable, args,
      { cwd: config.home, env, encoding: 'utf8', timeout: observing ? 7000 : 15000, maxBuffer: 262144, windowsHide: true },
      (error, stdout) => {
        const stopReason = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'byte_limit' : error?.killed === true ? 'timeout' : 'eof';
        if (error && (!observing || stopReason === 'eof')) reject(error);
        else accept({ stdout, stopReason });
      }));
  } catch { fail('WAKE_NATIVE_UNAVAILABLE'); }
  assertActive(config, context);
  if (typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > 262144) fail('WAKE_NATIVE_SCHEMA');
  return output;
}
async function native(config, args, context) { return (await capture(config, args, context)).stdout; }
async function json(config, args, context) {
  const output = await native(config, [...args, '--json'], context);
  try { return JSON.parse(output); } catch { fail('WAKE_NATIVE_SCHEMA'); }
}
async function identity(config, context) {
  const [versionText, state] = await Promise.all([native(config, ['--version'], context), json(config, ['status'], context)]);
  const version = versionText.trim();
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version) || !plain(state) || typeof state.running !== 'boolean' || typeof state.reachable !== 'boolean' ||
      !Number.isSafeInteger(state.pid) || state.pid < 1 || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) fail('WAKE_NATIVE_SCHEMA');
  return { productId: 'qoderwake-cn', version, home: config.home,
    daemon: { running: state.running, reachable: state.reachable, pid: state.pid, port: state.port } };
}
const project = (value, fields) => Object.fromEntries(fields.filter(key => typeof value[key] === 'string' && value[key].length <= 4096).map(key => [key, value[key]]));
const array = value => { if (!Array.isArray(value) || value.length > 1000 || value.some(item => !plain(item))) fail('WAKE_NATIVE_SCHEMA'); return value; };
function wakerId(config, value) { if (!config.allowedWakerIds.includes(value)) fail('WAKE_TARGET_OUTSIDE_SCOPE'); }
function root(config, value) {
  if (!absolute(value) || !existsSync(value) || !statSync(value).isDirectory()) fail('WAKE_TARGET_OUTSIDE_SCOPE');
  const path = canonical(value);
  if (!config.allowedRoots.some(allowed => within(allowed, path))) fail('WAKE_TARGET_OUTSIDE_SCOPE');
  return path;
}
async function waker(config, id, context) {
  wakerId(config, id);
  const value = await json(config, ['waker', 'get', '--waker-id', id], context);
  if (!plain(value) || value.agentId !== id || typeof value.name !== 'string' || typeof value.status !== 'string') fail('WAKE_NATIVE_SCHEMA');
  return project(value, ['agentId', 'name', 'status', 'workspace']);
}
async function sessions(config, id, context) {
  await waker(config, id, context);
  const values = array(await json(config, ['session', 'list', '--waker-id', id], context));
  return values.flatMap(value => {
    if (value.agentId !== id || !ID.test(value.sessionId ?? '') || typeof value.status !== 'string' || !absolute(value.cwd)) fail('WAKE_NATIVE_SCHEMA');
    let cwd;
    try { cwd = root(config, value.cwd); } catch (error) { if (error.code === 'WAKE_TARGET_OUTSIDE_SCOPE') return []; throw error; }
    if (value.pid !== undefined && value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid < 1) ||
        value.runtimeRestartRequired !== undefined && typeof value.runtimeRestartRequired !== 'boolean') fail('WAKE_NATIVE_SCHEMA');
    return [{ ...project(value, ['sessionId', 'agentId', 'title', 'status', 'runtimeState', 'runtimePresence',
      'sdkTranscriptState', 'runtimeRoute', 'lifecycleProfile', 'selectedRuntimeTransport']), cwd,
      ...(value.pid === undefined ? {} : { pid: value.pid }),
      ...(value.runtimeRestartRequired === undefined ? {} : { runtimeRestartRequired: value.runtimeRestartRequired }) }];
  });
}
async function session(config, args, context) {
  const value = (await sessions(config, args.wakerId, context)).find(item => item.sessionId === args.sessionId);
  if (!value) fail('WAKE_TARGET_OUTSIDE_SCOPE');
  return value;
}
async function approvals(config, args, context) {
  const argv = ['permission', 'approval', 'list', '--waker-id', args.wakerId, ...(args.sessionId ? ['--session-id', args.sessionId] : [])];
  return array(await json(config, argv, context)).map(value => {
    if (value.agentId !== undefined && value.agentId !== args.wakerId || value.wakerId !== undefined && value.wakerId !== args.wakerId ||
        args.sessionId && value.sessionId !== undefined && value.sessionId !== args.sessionId) fail('WAKE_NATIVE_SCHEMA');
    return project(value, ['requestId', 'sessionId', 'status']);
  });
}

function eventWindow(stdout, sessionId, fromSequence, limit) {
  const frames = stdout.replaceAll('\r\n', '\n').split('\n\n');
  const tail = frames.pop();
  if (tail.split('\n').some(line => line && !line.startsWith(':') && !/^(data|event|id|retry):/.test(line))) fail('WAKE_NATIVE_SCHEMA');
  const partialFrame = tail.split('\n').some(line => line.startsWith('data:'));
  const items = [];
  const seen = new Map();
  const validId = value => typeof value === 'string' && ID.test(value);
  let lastSequence, frameCount = 0, omittedEvents = 0, textBytes = 0, textTruncated = false, frameLimitReached = false, projectionStopped = false;
  const clippedText = value => {
    let result = '', bytes = 0;
    const maximum = Math.min(2048, 8192 - textBytes);
    for (const character of value) {
      const size = Buffer.byteLength(character);
      if (bytes + size > maximum) break;
      result += character; bytes += size;
    }
    textBytes += bytes;
    if (Buffer.byteLength(value) > bytes) textTruncated = true;
    return result;
  };
  for (const frame of frames) {
    const lines = frame.split('\n').filter(line => line && !line.startsWith(':'));
    if (!lines.length) continue;
    if (lines.some(line => !/^(data|event|id|retry):/.test(line))) fail('WAKE_NATIVE_SCHEMA');
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (frameCount >= 512) { frameLimitReached = true; break; }
    let event;
    try { event = JSON.parse(data); } catch { fail('WAKE_NATIVE_SCHEMA'); }
    frameCount++;
    if (!plain(event) || event.session_id !== sessionId || !validId(event.event_id) ||
        !Number.isSafeInteger(event.sequence_num) || event.sequence_num < fromSequence ||
        typeof event.event_type !== 'string' || event.event_type.length > 128 || !plain(event.payload)) fail('WAKE_NATIVE_SCHEMA');
    if (seen.has(event.event_id)) { if (seen.get(event.event_id) !== data) fail('WAKE_NATIVE_SCHEMA'); continue; }
    if (lastSequence !== undefined && event.sequence_num <= lastSequence) fail('WAKE_NATIVE_SCHEMA');
    seen.set(event.event_id, data);
    lastSequence = event.sequence_num;
    const payload = event.payload, kind = event.event_type;
    if (payload.session_id !== undefined && payload.session_id !== sessionId) fail('WAKE_NATIVE_SCHEMA');
    if (!['user', 'assistant', 'result', 'runtime.state.changed'].includes(kind)) continue;
    if (!validId(payload.run_id) || payload.runtime_run_id !== undefined && !validId(payload.runtime_run_id) ||
        payload.runtime_epoch !== undefined && (!Number.isSafeInteger(payload.runtime_epoch) || payload.runtime_epoch < 0)) fail('WAKE_NATIVE_SCHEMA');
    const item = { eventId: event.event_id, sessionId, sequence: event.sequence_num, type: kind, runId: payload.run_id,
      ...(payload.runtime_run_id === undefined ? {} : { runtimeRunId: payload.runtime_run_id }),
      ...(payload.runtime_epoch === undefined ? {} : { runtimeEpoch: payload.runtime_epoch }) };
    let content;
    if (kind === 'user' || kind === 'assistant') {
      if (!plain(payload.message) || payload.message.role !== kind || !Array.isArray(payload.message.content)) fail('WAKE_NATIVE_SCHEMA');
      const blocks = payload.message.content.filter(block => plain(block) && block.type === 'text');
      if (blocks.some(block => typeof block.text !== 'string')) fail('WAKE_NATIVE_SCHEMA');
      content = blocks.map(block => block.text).join('\n');
    } else if (kind === 'result') {
      if (typeof payload.result !== 'string' || typeof payload.is_error !== 'boolean' || !validId(payload.subtype)) fail('WAKE_NATIVE_SCHEMA');
      item.subtype = payload.subtype; item.isError = payload.is_error; content = payload.result;
    } else {
      if (!validId(payload.state) || payload.previous_state != null && !validId(payload.previous_state)) fail('WAKE_NATIVE_SCHEMA');
      item.state = payload.state;
      if (payload.previous_state != null) item.previousState = payload.previous_state;
    }
    if (projectionStopped || items.length >= limit) { omittedEvents++; continue; }
    if (content !== undefined) {
      item.text = clippedText(content);
      if (content.length && !item.text.length) { projectionStopped = true; omittedEvents++; continue; }
    }
    items.push(item);
  }
  return { items, frameCount, ...(lastSequence === undefined ? {} : { observedThroughSequence: lastSequence }),
    ...(items.length ? { returnedThroughSequence: items.at(-1).sequence } : {}), partialFrame, omittedEvents, textBytes, textTruncated, frameLimitReached };
}

async function readEvents(config, args, context) {
  const fromSequence = args.fromSequence ?? 0;
  const output = await capture(config, ['session', 'stream', '--session-id', args.sessionId, '--from-sequence-num', String(Math.max(0, fromSequence - 1))], context, true);
  const window = eventWindow(output.stdout, args.sessionId, fromSequence, args.limit ?? 32);
  return { sessionId: args.sessionId, fromSequence, ...window, observation: window.items.length ? 'observed' : 'no_evidence',
    complete: false, consumerConfirmed: false, terminalResultObserved: window.items.some(item => item.type === 'result'),
    stopReason: output.stopReason, truncated: window.partialFrame || window.omittedEvents > 0 || window.textTruncated || window.frameLimitReached || output.stopReason !== 'eof',
    bounds: { timeoutMs: 7000, maxBytes: 262144, maxFrames: 512, maxEvents: args.limit ?? 32, maxTextBytes: 8192, maxEventTextBytes: 2048 } };
}

const receiptPath = (config, requestId) => join(config.receiptDir, `${hash(requestId)}.json`);
const validAck = ack => plain(ack) && Object.keys(ack).length === 2 &&
  typeof ack.eventId === 'string' && ID.test(ack.eventId) && Number.isSafeInteger(ack.sequence) && ack.sequence >= 0;
function singleEventAck(result, interrupt = false) {
  if (Object.keys(result).some(key => key !== 'results' && !(interrupt && key === 'runtimeState')) ||
      !Array.isArray(result.results) || result.results.length !== 1) return null;
  if (Object.hasOwn(result, 'runtimeState') && result.runtimeState !== null &&
      (typeof result.runtimeState !== 'string' || result.runtimeState.length > 128)) return null;
  const value = result.results[0];
  if (!plain(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'event_id') || !Object.hasOwn(value, 'sequence_num')) return null;
  const ack = { eventId: value.event_id, sequence: value.sequence_num };
  return validAck(ack) ? ack : null;
}
function readReceipt(config, requestId) {
  const path = receiptPath(config, requestId);
  if (!existsSync(path)) return null;
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || statSync(path).size > 8192) fail('WAKE_RECEIPT_INVALID');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!plain(record) || record.schemaVersion !== 1 || record.requestId !== requestId || !/^[0-9a-f]{64}$/.test(record.fingerprint ?? '') ||
        !['unknown', 'accepted'].includes(record.state) || !['create_session', 'send_session_message', 'interrupt_session'].includes(record.operation) || !ID.test(record.address ?? '') ||
        record.nativeAck !== undefined && !validAck(record.nativeAck)) fail('WAKE_RECEIPT_INVALID');
    return record;
  } catch { fail('WAKE_RECEIPT_INVALID'); }
}
function budget(config, context, additionalBytes) {
  const usedBytes = existsSync(config.receiptDir) ? readdirSync(config.receiptDir).reduce((bytes, name) => {
    const path = join(config.receiptDir, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('WAKE_RECEIPT_INVALID');
    return bytes + stat.size;
  }, 0) : 0;
  if (!context.messageBudget?.status?.() || context.messageBudget.check({ ownerId: receiptOwnerId(config), usedBytes, additionalBytes })?.ok !== true) fail('WAKE_BUDGET_BLOCKED');
}
async function locked(config, context, action) {
  assertActive(config, context, true);
  budget(config, context, 0);
  mkdirSync(config.receiptDir, { recursive: true });
  const path = join(config.receiptDir, '.lock'), deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) fail('WAKE_RECEIPT_BUSY'); await delay(20); assertActive(config, context, true); }
  }
  try { assertActive(config, context, true); return action(); }
  finally { closeSync(fd); unlinkSync(path); }
}
function publicReceipt(config, record, deduplicated = false) {
  const ownerId = receiptOwnerId(config), deliveryId = `wake:${hash(record.requestId).slice(0, 40)}`;
  return { requestId: record.requestId, operation: record.operation, state: record.state, ownerId, deliveryId, deduplicated,
    ...(typeof record.sessionId === 'string' && ID.test(record.sessionId) ? { sessionId: record.sessionId } : {}),
    ...(record.nativeAck === undefined ? {} : { nativeAck: { ...record.nativeAck } }),
    completion: 'unknown', consumerConfirmed: false,
    messageReceipt: { schemaVersion: 1, requestId: record.requestId, deliveryId, ownerId,
      target: { moduleId: 'agent-qoder-wake', address: record.address }, correlation: record.requestId,
      acceptance: { owner: { state: 'accepted', evidence: deliveryId },
        provider: record.state === 'accepted' ? { state: 'accepted', evidence: deliveryId } : { state: 'unknown' } } } };
}
async function mutate(operation, args, config, context, initialIdentity) {
  assertActive(config, context, true);
  const fingerprint = hash([operation, Object.keys(args).sort().map(key => [key, args[key]]), config, context.registrationKey]);
  let prior = readReceipt(config, args.requestId);
  if (prior) { if (prior.fingerprint !== fingerprint) fail('WAKE_REQUEST_CONFLICT'); return publicReceipt(config, prior, true); }
  const employee = await waker(config, args.wakerId, context);
  if (employee.status !== 'online') fail('WAKE_TARGET_NOT_READY');
  let argv;
  if (operation === 'create_session') {
    const cwd = root(config, args.cwd);
    argv = ['session', 'create', '--waker-id', args.wakerId, '--cwd', cwd, '--message', args.message, ...(args.title ? ['--title', args.title] : [])];
  } else {
    const current = await session(config, args, context);
    const residentInput = operation === 'send_session_message' && current.status === 'stopped' &&
      current.runtimeState === 'waiting_input' && current.runtimePresence === 'idle_resident';
    const releasedInput = operation === 'send_session_message' && current.status === 'stopped' &&
      current.runtimeState === 'waiting_input' && current.runtimePresence === 'released' && current.pid === null &&
      current.sdkTranscriptState === 'ready' && current.runtimeRestartRequired === false && current.runtimeRoute === 'sdk_local' &&
      current.lifecycleProfile === 'console_conversation' && current.selectedRuntimeTransport === 'process';
    const terminal = ['unknown', 'released', 'terminal', 'terminal_stopped', 'terminated', 'closed'].includes(current.runtimeState) ||
      ['unknown', 'terminal', 'absent'].includes(current.runtimePresence) || current.runtimePresence === 'released' && !releasedInput;
    if (terminal || current.runtimeRestartRequired === true || !['running', 'idle'].includes(current.status) && !residentInput && !releasedInput) fail('WAKE_SESSION_NOT_LIVE');
    argv = operation === 'send_session_message'
      ? ['session', 'send', '--session-id', args.sessionId, '--message', args.message]
      : ['session', 'interrupt', '--session-id', args.sessionId];
    if ((await approvals(config, args, context)).length) fail('WAKE_APPROVAL_PENDING');
  }
  if (hash(await identity(config, context)) !== hash(initialIdentity)) fail('WAKE_NATIVE_IDENTITY_CHANGED');
  const record = { schemaVersion: 1, requestId: args.requestId, operation, fingerprint, address: args.sessionId ?? args.wakerId,
    state: 'unknown', createdAt: new Date().toISOString() };
  prior = await locked(config, context, () => {
    const existing = readReceipt(config, args.requestId);
    if (existing) { if (existing.fingerprint !== fingerprint) fail('WAKE_REQUEST_CONFLICT'); return existing; }
    const content = JSON.stringify(record);
    budget(config, context, Buffer.byteLength(content));
    assertActive(config, context, true);
    const fd = openSync(receiptPath(config, args.requestId), 'wx', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    return null;
  });
  if (prior) return publicReceipt(config, prior, true);
  try {
    assertActive(config, context, true);
    const result = await json(config, argv, context);
    if (!plain(result) || result.success === false || result.accepted === false) return publicReceipt(config, record);
    if (result.sessionId !== undefined && (!ID.test(result.sessionId) || args.sessionId && result.sessionId !== args.sessionId)) return publicReceipt(config, record);
    let ack;
    if (operation === 'create_session') {
      if (typeof result.sessionId !== 'string' || !(await sessions(config, args.wakerId, context)).some(item => item.sessionId === result.sessionId && item.cwd === root(config, args.cwd))) return publicReceipt(config, record);
      record.sessionId = result.sessionId;
    } else {
      ack = singleEventAck(result, operation === 'interrupt_session');
      if (!ack) return publicReceipt(config, record);
    }
    const accepted = { ...record, ...(ack ? { nativeAck: ack } : {}), state: 'accepted', acceptedAt: new Date().toISOString() };
    await locked(config, context, () => {
      const path = receiptPath(config, args.requestId), temporary = `${path}.tmp`, content = JSON.stringify(accepted);
      if (readReceipt(config, args.requestId)?.fingerprint !== fingerprint) fail('WAKE_REQUEST_CONFLICT');
      budget(config, context, Buffer.byteLength(content));
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      assertActive(config, context, true);
      renameSync(temporary, path);
    });
    return publicReceipt(config, accepted);
  } catch { return publicReceipt(config, record); }
}

export async function call(operation, args = {}, context = {}) {
  try {
    const mutating = validate(operation, args), config = readConfig();
    args = structuredClone(args);
    assertActive(config, context, mutating);
    if (operation === 'request_receipt') {
      const record = readReceipt(config, args.requestId);
      return record ? publicReceipt(config, record) : { requestId: args.requestId, state: 'not_found', retrySafe: false };
    }
    const current = await identity(config, context);
    if (operation === 'identity') return { identity: current, target: { ...target } };
    if (!current.daemon.running || !current.daemon.reachable) fail('WAKE_TARGET_NOT_READY');
    if (mutating) return mutate(operation, args, config, context, current);
    if (operation === 'list_wakers') return { identity: current, items: array(await json(config, ['local', 'employee', 'list'], context))
      .filter(value => config.allowedWakerIds.includes(value.agentId)).map(value => project(value, ['agentId', 'name', 'status', 'workspace'])) };
    if (operation === 'list_sessions') return { identity: current, items: await sessions(config, args.wakerId, context) };
    const selected = await session(config, args, context);
    if (operation === 'session_status') return { identity: current, session: selected };
    if (operation === 'read_session_events') return { identity: current, ...await readEvents(config, args, context) };
    return { identity: current, items: await approvals(config, args, context) };
  } catch (error) {
    if (typeof error?.code === 'string' && /^WAKE_[A-Z_]+$/.test(error.code)) fail(error.code);
    fail('WAKE_IO_UNAVAILABLE');
  }
}
