import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifySdkTurn } from './native.mjs';

const canonical = path => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function nativeComparableParts(parts) {
  if (!Array.isArray(parts)) return parts;
  // Desktop rendering adds completed hooks, fragment IDs and timing absent from SDK history.
  return parts.filter(part => part.type !== 'hook' || !['succeeded', 'failed'].includes(part.hook?.status))
    .map(part => {
      if (!['text', 'thinking'].includes(part.type)) return part;
      const { id, ...content } = part;
      if (part.type === 'thinking') {
        delete content.startedAt; delete content.completedAt; delete content.durationMs;
      }
      return content;
    });
}
const unsupported = () => Error('Qoder desktop projection contract is unsupported');

// Read only the installed, pure projection chunks; never load Electron's main entry.
export async function loadInstalledProjection(archivePath) {
  if (!isAbsolute(archivePath) || !archivePath.endsWith('.asar')) throw unsupported();
  const fd = openSync(archivePath, 'r'), size = fstatSync(fd).size;
  const read = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0 ||
        length > 4_194_304 || offset < 0 || offset + length > size) throw unsupported();
    const bytes = Buffer.alloc(length);
    for (let done = 0; done < length;) {
      const count = readSync(fd, bytes, done, length - done, offset + done);
      if (!count) throw unsupported();
      done += count;
    }
    return bytes;
  };
  try {
    const lead = read(0, 16), base = 8 + lead.readUInt32LE(4);
    const header = JSON.parse(read(16, lead.readUInt32LE(12)).toString('utf8'));
    const source = path => {
      let entry = header;
      for (const part of path.split('/')) entry = entry?.files?.[part];
      if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size)) throw unsupported();
      return read(base + Number(entry.offset), entry.size).toString('utf8');
    };
    const chunks = header.files?.out?.files?.main?.files?.chunks?.files;
    const find = prefix => {
      const matches = Object.keys(chunks ?? {}).filter(name => name.startsWith(prefix + '-') && name.endsWith('.js'));
      if (matches.length !== 1) throw unsupported();
      return 'out/main/chunks/' + matches[0];
    };
    const paths = ['liveAssistantProjection', 'chatSessionMessageQueries', 'chatSessionSearchProjection'].map(find);
    const cron = 'node_modules/croner/dist/croner.js', allowed = new Set([...paths, cron]);
    const urls = new Map(), loading = new Set();
    const urlFor = async path => {
      if (urls.has(path)) return urls.get(path);
      if (!allowed.has(path) || loading.has(path)) throw unsupported();
      loading.add(path);
      let code = source(path);
      const imports = [...code.matchAll(/\bimport(?:[^;]*?from)?["']([^"']+)["'];/g)];
      for (const match of imports) {
        const dependency = match[1];
        if (['node:crypto', 'node:os'].includes(dependency)) continue;
        const target = dependency === 'croner' ? cron : posix.normalize(posix.join(posix.dirname(path), dependency));
        if (!allowed.has(target)) throw unsupported();
        code = code.replace(match[0], match[0].replace(dependency, await urlFor(target)));
      }
      const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
      urls.set(path, url); loading.delete(path);
      return url;
    };
    const projected = await import(await urlFor(paths[0]));
    const queries = await import(await urlFor(paths[1]));
    const Projection = Object.values(projected).find(value => typeof value === 'function' &&
      typeof value.prototype?.applyAssistant === 'function' && typeof value.prototype?.applyResult === 'function' &&
      typeof value.prototype?.messageStreamMetadata === 'function' && typeof value.prototype?.snapshot === 'function');
    // shortcut: the private export must pass installed-source acceptance again if vendor packaging changes.
    if (!Projection || typeof queries.s !== 'function' || queries.s.length !== 6) throw unsupported();
    return { Projection, writeMessage: queries.s };
  } catch { throw unsupported(); }
  finally { closeSync(fd); }
}

export function projectCompletedTurn(history, record, Projection) {
  if (!Array.isArray(history) || !history.length || !record || !uuid.test(record.requestId ?? '') ||
      !uuid.test(record.sessionId ?? '') || !uuid.test(record.assistantId ?? '') ||
      record.terminalOutcome !== 'completed' || record.lifecycle !== 'queued-started-completed' ||
      record.isError !== false || record.subtype !== 'success' || !Number.isFinite(Date.parse(record.completedAt)))
    throw Error('A verified completed native turn is required for desktop synchronization');
  const input = history[0], final = history.at(-1);
  if (input.type !== 'user' || input.uuid !== record.requestId || input.parent_tool_use_id !== null ||
      input.message?.role !== 'user' || final.type !== 'assistant' || final.uuid !== record.assistantId ||
      history.some(message => message.session_id !== record.sessionId) ||
      new Set(history.map(message => message.uuid)).size !== history.length) throw Error('Native turn identity mismatch');
  const text = typeof input.message.content === 'string' ? input.message.content :
    Array.isArray(input.message.content) && input.message.content.every(part => part.type === 'text') ?
      input.message.content.map(part => part.text).join('\n\n') : undefined;
  if (typeof text !== 'string' || !Number.isFinite(Date.parse(input.timestamp))) throw unsupported();
  const projection = new Projection(input.uuid, input.timestamp, undefined, input.timestamp, input.request_set_id);
  for (const message of history.slice(1)) {
    if (message.type === 'assistant') projection.applyAssistant(message);
    else if (message.type === 'user' && Array.isArray(message.message?.content) &&
        message.message.content.every(part => part.type === 'tool_result')) projection.applyToolResults(message);
    else throw Error('Desktop synchronization does not support this native control/history event');
  }
  // Completion comes from the verified command result, never from the presence of assistant text.
  projection.completedAt = record.completedAt;
  const assistant = projection.snapshot('completed');
  if (!assistant || assistant.id !== 'assistant:' + input.uuid || !assistant.text?.trim() ||
      assistant.tools.some(tool => tool.status === 'running')) throw Error('Desktop projection is not terminal');
  return [
    { id: input.uuid, role: 'user', turnId: input.uuid, text, timestamp: input.timestamp, tools: [] },
    { ...assistant, turnId: input.uuid, status: 'completed' }
  ];
}

export function appendDesktopTurn(databasePath, metadata, messages, writeMessage, assertActive = () => {}) {
  if (!isAbsolute(databasePath) || !existsSync(databasePath) || !uuid.test(metadata.sessionId ?? '') ||
      typeof metadata.cwd !== 'string' || !isAbsolute(metadata.cwd) ||
      typeof metadata.ownerId !== 'string' || !metadata.ownerId || !Array.isArray(messages) || !messages.length)
    throw Error('Invalid desktop synchronization scope');
  const db = new DatabaseSync(databasePath, { open: true, enableForeignKeyConstraints: true });
  let transaction = false;
  try {
    assertActive();
    db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    transaction = true;
    const session = db.prepare('SELECT * FROM chat_sessions WHERE session_id=?').get(metadata.sessionId);
    if (session && (canonical(session.cwd) !== canonical(metadata.cwd) || session.execution_kind !== 'local' ||
        session.archived || session.deleted_at !== null || session.registration_json !== null ||
        metadata.workspaceId && session.workspace_id !== metadata.workspaceId))
      throw Error('Desktop session scope is not writable');
    if (session && !metadata.allowExisting && JSON.parse(session.extra_json).postCoreProjection?.ownerId !== metadata.ownerId)
      throw Error('Desktop session is not owned by this projection');
    if (db.prepare("SELECT 1 FROM chat_session_messages WHERE session_id=? AND status='streaming' LIMIT 1").get(metadata.sessionId))
      throw Error('Desktop session has a live projection');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_session_input_receipts'").get() &&
        db.prepare("SELECT 1 FROM chat_session_input_receipts WHERE session_id=? AND state IN ('accepted','dispatching','unknown') LIMIT 1")
          .get(metadata.sessionId)) throw Error('Desktop session has pending input');
    const tail = db.prepare('SELECT message_id,turn_id,payload_json,status FROM chat_session_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1')
      .get(metadata.sessionId);
    const alreadyPresent = messages.every(message => db.prepare('SELECT 1 FROM chat_session_messages WHERE session_id=? AND message_id=?')
      .get(metadata.sessionId, message.id));
    if (tail && !alreadyPresent) {
      const previous = metadata.expectedPreviousTurn, saved = JSON.parse(tail.payload_json);
      if (!previous || tail.status !== 'completed' || tail.turn_id !== previous.turnId || saved.role !== 'assistant' ||
          saved.text !== previous.text || JSON.stringify(saved.tools) !== JSON.stringify(previous.tools) ||
          JSON.stringify(nativeComparableParts(saved.parts)) !== JSON.stringify(nativeComparableParts(previous.parts)))
        throw Error('Desktop history is not the verified native prefix');
    }
    if (!session) {
      const at = Date.parse(messages[0].timestamp), target = { mode: 'local', host: { id: 'local', kind: 'local', label: 'Local' },
        workspace: { id: 'ws_' + createHash('sha256').update('local\0' + metadata.cwd).digest('hex'), path: metadata.cwd } };
      if (!Number.isFinite(at)) throw Error('Invalid native input timestamp');
      db.prepare(`INSERT INTO chat_sessions
        (session_id,title,cwd,workspace_id,execution_kind,permission_mode,created_at,updated_at,execution_target_json,extra_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(metadata.sessionId, messages[0].text.trim().slice(0,60) || metadata.sessionId,
        metadata.cwd, metadata.workspaceId ?? null, 'local', 'auto', at, at, JSON.stringify(target),
        JSON.stringify({ cliSessionReady: true, source: 'workspace', titleResolved: false, titleRevision: 0,
          provisionalTitle: messages[0].text.trim().slice(0,60), postCoreProjection: { ownerId: metadata.ownerId } }));
    }
    let inserted = 0;
    for (const message of messages) {
      assertActive();
      if (message.turnId !== messages[0].turnId || !message.id || !['user','assistant'].includes(message.role))
        throw Error('Invalid projected message identity');
      const old = db.prepare('SELECT payload_json,status,turn_id,source FROM chat_session_messages WHERE session_id=? AND message_id=?')
        .get(metadata.sessionId, message.id);
      if (old) {
        const saved = JSON.parse(old.payload_json);
        if (old.source !== 'cli-import' || old.status !== 'completed' || old.turn_id !== message.turnId ||
            saved.id !== message.id || saved.role !== message.role || saved.text !== message.text ||
            JSON.stringify(saved.tools) !== JSON.stringify(message.tools) ||
            message.role === 'assistant' && JSON.stringify(saved.parts) !== JSON.stringify(message.parts))
          throw Error('Desktop message collision; existing projection was preserved');
        continue;
      }
      writeMessage(db, metadata.sessionId, message, message.turnId, 'cli-import');
      const stored = db.prepare('SELECT payload_json,turn_id,status,source FROM chat_session_messages WHERE session_id=? AND message_id=?')
        .get(metadata.sessionId, message.id);
      if (!stored || stored.turn_id !== message.turnId || stored.status !== 'completed' || stored.source !== 'cli-import' ||
          JSON.parse(stored.payload_json).text !== message.text) throw unsupported();
      inserted++;
    }
    if (inserted) db.prepare('UPDATE chat_sessions SET updated_at=MAX(updated_at,?) WHERE session_id=?')
      .run(Date.parse(messages.at(-1).completedAt ?? messages.at(-1).timestamp), metadata.sessionId);
    assertActive();
    db.exec('COMMIT');
    transaction = false;
    return { state: 'committed', sessionId: metadata.sessionId, inserted, uiNotification: 'not_emitted' };
  } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export async function synchronizeDesktopTurn({ sdk, record, args, config, databasePath, archivePath, ownerId,
  allowExisting = false, projection, assertActive = () => {} }) {
  assertActive();
  if (!await verifySdkTurn(sdk, record, args, config)) throw Error('Native result/history verification failed');
  const tail = await sdk.getSessionMessages(args.sessionId, { dir: config.root, view: 'historical', offset: record.historyOffset, limit: 501 });
  if (!await verifySdkTurn({ ...sdk, getSessionMessages: async () => tail }, record, args, config))
    throw Error('Native history changed during desktop synchronization');
  const final = tail.findIndex(message => message.uuid === record.assistantId);
  const vendor = projection ?? await loadInstalledProjection(archivePath);
  const messages = projectCompletedTurn(tail.slice(0, final + 1), record, vendor.Projection);
  const input = messages[0].text;
  if (input !== args.prompt) throw Error('Native input changed during desktop synchronization');
  let previousInput, previousProjection;
  for (let offset = 0; offset < record.historyOffset; offset += 500) {
    const prefix = await sdk.getSessionMessages(args.sessionId, { dir: config.root, view: 'historical',
      offset, limit: Math.min(500, record.historyOffset - offset) });
    if (prefix.length !== Math.min(500, record.historyOffset - offset) || prefix.some(message => message.session_id !== args.sessionId))
      throw Error('Native history prefix changed during synchronization');
    for (const message of prefix) {
      if (message.type === 'user' && message.parent_tool_use_id === null &&
          (typeof message.message?.content === 'string' || message.message?.content?.some?.(part => part.type === 'text'))) {
        previousInput = message.uuid;
        previousProjection = new vendor.Projection(message.uuid, message.timestamp, undefined, message.timestamp, message.request_set_id);
      }
      else if (previousProjection && message.type === 'assistant') previousProjection.applyAssistant(message);
      else if (previousProjection && message.type === 'user' && Array.isArray(message.message?.content) &&
          message.message.content.every(part => part.type === 'tool_result')) previousProjection.applyToolResults(message);
    }
  }
  // Compare the native aggregate, not the last text fragment; this never writes or completes the previous turn.
  const previousAssistant = previousProjection?.snapshot();
  assertActive();
  return appendDesktopTurn(databasePath, { sessionId: args.sessionId, cwd: config.root,
    workspaceId: config.workspaceId, ownerId, allowExisting,
    expectedPreviousTurn: previousInput && previousAssistant ? { turnId: previousInput, text: previousAssistant.text,
      tools: previousAssistant.tools, parts: previousAssistant.parts } : undefined },
  messages, vendor.writeMessage, assertActive);
}
