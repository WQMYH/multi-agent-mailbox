import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { nativeFailure, secondaryNativeFailure } from './native-failure.mjs';

const require = createRequire(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeOperations = new Set(['identity', 'list', 'search', 'send', 'send_new_session', 'verify_turn']);
const canonical = path => realpathSync.native(path).replaceAll('\\', '/').toLowerCase();
const active = context => { context.assertCurrent?.(); context.assertLease?.(); };
const sdkFor = context => context.nativeSdk ?? import('@qodercn-ai/qodercn-agent-sdk');
const identity = { productId: 'qoder-cn', version: null, sdkVersion: '1.0.50', runtime: 'qoderclicn' };
const failure = () => Error('Native Qoder operation failed; outcome unknown, never retry through another transport');

export function nativeAvailable(config, context = {}) {
  if (!config.cliExecutable || !isAbsolute(config.cliExecutable)) return false;
  try {
    if (!statSync(config.cliExecutable).isFile()) return false;
    if (!context.nativeSdk) require.resolve('@qodercn-ai/qodercn-agent-sdk');
    return true;
  } catch { return false; }
}

async function scopedSession(sdk, sessionId, config) {
  const info = await sdk.getSessionInfo(sessionId, { dir: config.root });
  if (!info || info.sessionId !== sessionId || !info.cwd || canonical(info.cwd) !== canonical(config.root))
    throw Error('Native Qoder session is outside the operator root');
  return info;
}

// ponytail: bounded public-API pagination; beyond 10,000 history entries needs a locator API.
async function historyLength(sdk, sessionId, config) {
  for (let offset = 0; offset <= 10000; offset += 500) {
    const page = await sdk.getSessionMessages(sessionId, { dir: config.root, view: 'historical', offset, limit: 500 });
    if (!Array.isArray(page) || page.length > 500) throw failure();
    if (page.length < 500 && offset + page.length <= 10000) return offset + page.length;
  }
  throw Error('Native Qoder history lookup incomplete');
}

export async function verifySdkTurn(sdk, saved, args, config, requireIdle = false) {
  let record;
  try { record = typeof saved === 'string' ? JSON.parse(saved) : saved; } catch { return null; }
  if (!record || record.schemaVersion !== 1 || record.requestId !== args.requestId || record.sessionId !== args.sessionId ||
      ![record.requestId, record.sessionId, record.resultId, record.assistantId].every(id => typeof id === 'string' && UUID.test(id)) ||
      !Number.isInteger(record.historyOffset) || record.historyOffset < 0 || record.historyOffset > 10000 ||
      !['completed', 'failed'].includes(record.terminalOutcome) ||
      record.lifecycle !== 'queued-started-completed' ||
      typeof record.completedAt !== 'string' || !Number.isFinite(Date.parse(record.completedAt)) ||
      (record.terminalOutcome === 'completed' ? record.subtype !== 'success' || record.isError !== false :
        !['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'success'].includes(record.subtype) || record.isError !== true)) return null;
  await scopedSession(sdk, args.sessionId, config);
  const messages = await sdk.getSessionMessages(args.sessionId, {
    dir: config.root, view: 'historical', offset: record.historyOffset, limit: 501
  });
  if (!Array.isArray(messages) || messages.length > 500 ||
      messages.some(message => message.session_id !== args.sessionId) ||
      new Set(messages.map(message => message.uuid)).size !== messages.length) return null;
  const input = messages[0], finalIndex = messages.findIndex(message => message.uuid === record.assistantId);
  const inputContent = input?.message?.content;
  const exactInput = inputContent === args.prompt || Array.isArray(inputContent) && inputContent.length === 1 &&
    inputContent[0]?.type === 'text' && inputContent[0].text === args.prompt;
  if (input?.type !== 'user' || input.uuid !== args.requestId || input.parent_tool_use_id !== null ||
      input.message?.role !== 'user' || !exactInput || finalIndex < 1) return null;
  const final = messages[finalIndex];
  if (final.type !== 'assistant' || final.parent_tool_use_id !== null ||
      messages.slice(1, finalIndex).some(message => message.type === 'user' &&
        (typeof message.message?.content === 'string' || message.message?.content?.some?.(part => part.type === 'text')))) return null;
  if (record.terminalOutcome === 'completed' && (final.isApiErrorMessage ||
      !Array.isArray(final.message?.content) || !final.message.content.some(part => part.type === 'text'))) return null;
  if (requireIdle && finalIndex !== messages.length - 1) return null;
  // command_uuid binds this turn; result.uuid identifies a result, not its input.
  return { nativeInputId: record.requestId, nativeTurnId: record.requestId,
    assistantId: record.assistantId, terminalOutcome: record.terminalOutcome };
}

async function send(sdk, operation, args, config, context) {
  let phase = 'preflight', warm, answer, error;
  try {
    if (operation === 'send') {
      if (!args.idleAnchor || !await verifySdkTurn(sdk, args.idleAnchor.native_result, {
        sessionId: args.sessionId, requestId: args.idleAnchor.request_id, prompt: args.idleAnchor.prompt
      }, config, true)) throw Error('Native resume requires a Core-owned session and verified idle boundary; external desktop injection is unsupported');
    } else if (await sdk.getSessionInfo(args.sessionId)) throw Error('Native Qoder session ID already exists');
    const historyOffset = operation === 'send' ? await historyLength(sdk, args.sessionId, config) : 0;
    active(context);
    phase = 'startup';
    warm = await sdk.startup({ initializeTimeoutMs: 15000, options: {
      pathToQoderCLIExecutable: config.cliExecutable, auth: sdk.qodercliAuth(), cwd: config.root,
      ...(operation === 'send' ? { resume: args.sessionId } : { sessionId: args.sessionId }),
      canUseTool: async () => ({ behavior: 'deny', message: 'This headless transport cannot authorize a new tool permission; obtain separate review.' })
    } });
    phase = 'preflight';
    active(context);
    if (operation === 'send' && !await verifySdkTurn(sdk, args.idleAnchor.native_result, {
      sessionId: args.sessionId, requestId: args.idleAnchor.request_id, prompt: args.idleAnchor.prompt
    }, config, true)) throw Error('Native idle evidence changed before dispatch');
    active(context);
    async function* input() {
      active(context);
      yield { type: 'user', uuid: args.requestId, session_id: args.sessionId, client_composed: true,
        message: { role: 'user', content: args.prompt }, parent_tool_use_id: null };
    }
    let lifecycle = 0, assistantId, result, frames = 0;
    phase = 'query';
    for await (const message of warm.query(input())) {
      active(context);
      if (++frames > 10000) throw nativeFailure('frame_validation', 'frame_limit');
      if (!message || message.session_id !== undefined && message.session_id !== args.sessionId)
        throw nativeFailure('frame_validation', 'session_mismatch');
      if (message.type === 'command_lifecycle') {
        if (message.command_uuid !== args.requestId || message.state !== ['queued', 'started', 'completed'][lifecycle])
          throw nativeFailure('frame_validation', 'lifecycle_mismatch');
        lifecycle++;
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        if (lifecycle !== 2 || result || !UUID.test(message.uuid)) throw nativeFailure('frame_validation', 'assistant_invalid');
        assistantId = message.uuid;
      } else if (message.type === 'result') {
        if (result || lifecycle < 2 || !assistantId || !UUID.test(message.uuid) || typeof message.is_error !== 'boolean')
          throw nativeFailure('frame_validation', 'result_invalid');
        result = { resultId: message.uuid, subtype: message.subtype, isError: message.is_error };
      }
    }
    if (lifecycle !== 3 || !result || !assistantId ||
        !['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd'].includes(result.subtype))
      throw nativeFailure('frame_validation', 'terminal_incomplete');
    const nativeResult = { schemaVersion: 1, sessionId: args.sessionId, requestId: args.requestId,
      assistantId, ...result, historyOffset, terminalOutcome: result.isError ? 'failed' : 'completed',
      lifecycle: 'queued-started-completed', completedAt: new Date().toISOString() };
    if (nativeResult.terminalOutcome === 'completed' && result.subtype !== 'success')
      throw nativeFailure('frame_validation', 'terminal_invalid');
    answer = { identity: { ...identity }, value: { accepted: true, sessionId: args.sessionId, requestId: args.requestId }, nativeResult };
  } catch (cause) { error = nativeFailure(phase, `native_${phase}_failed`, cause); }
  if (warm) {
    try { await warm.close(); }
    catch (cause) { error = secondaryNativeFailure(error, 'cleanup', cause); }
  }
  if (error) throw error;
  return answer;
}

export async function native(operation, args, config, context = {}) {
  if (!nativeOperations.has(operation)) throw Error('Unsupported native Qoder operation');
  active(context);
  if (!nativeAvailable(config, context)) throw Error('Configured CN CLI and official CN SDK dependency are required');
  if (operation !== 'identity' && !config.root) throw Error('Operator-owned native Qoder root required');
  let sdk;
  try { sdk = await sdkFor(context); }
  catch (cause) {
    active(context);
    if (operation === 'send' || operation === 'send_new_session') throw nativeFailure('sdk_load', 'sdk_load_failed', cause);
    throw cause;
  }
  active(context);
  if (operation === 'identity') return { identity: { ...identity }, value: { transport: 'native', runtimeState: 'unknown' } };
  if (operation === 'list') {
    const tasks = await sdk.listSessions({ dir: config.root, includeWorktrees: false, limit: args.limit, offset: args.offset });
    if (!Array.isArray(tasks) || tasks.length > args.limit) throw failure();
    const value = tasks.filter(task => task.cwd && canonical(task.cwd) === canonical(config.root))
      .map(task => ({ sessionId: task.sessionId, title: String(task.summary ?? '').slice(0, 512),
        workspaceId: config.workspaceId, cwd: task.cwd, runtimeState: 'unknown', transport: 'native' }));
    active(context);
    return { identity: { ...identity }, value };
  }
  if (operation === 'search') {
    await scopedSession(sdk, args.sessionId, config);
    const hits = [];
    for (let offset = 0; offset < 10000 && hits.length < args.limit; offset += 500) {
      const page = await sdk.getSessionMessages(args.sessionId, { dir: config.root, view: 'historical', offset, limit: 500 });
      active(context);
      if (!Array.isArray(page) || page.length > 500 || page.some(message => message.session_id !== args.sessionId)) throw failure();
      for (const message of page) {
        const content = message.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
        const index = text.toLowerCase().indexOf(args.query.toLowerCase());
        if (index >= 0) hits.push({ messageId: message.uuid, role: message.type,
          snippet: text.slice(Math.max(0, index - 128), index + 384) });
        if (hits.length === args.limit) break;
      }
      if (page.length < 500) return { identity: { ...identity }, value: { hits, complete: true } };
    }
    return { identity: { ...identity }, value: { hits, complete: false } };
  }
  if (operation === 'verify_turn') {
    const proof = await verifySdkTurn(sdk, args.nativeResult, args, config);
    active(context);
    return { identity: { ...identity }, proof, value: {} };
  }
  try { return await send(sdk, operation, args, config, context); }
  catch (cause) { active(context); throw cause; }
}
