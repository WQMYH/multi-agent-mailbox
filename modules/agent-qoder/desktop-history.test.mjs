import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendDesktopTurn, synchronizeDesktopTurn } from './desktop-history.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-desktop-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'main.sqlite'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY,title TEXT,cwd TEXT,workspace_id TEXT,
    execution_kind TEXT,permission_mode TEXT,created_at INTEGER,updated_at INTEGER,execution_target_json TEXT,
    extra_json TEXT,archived INTEGER DEFAULT 0,deleted_at INTEGER,registration_json TEXT);
    CREATE TABLE chat_session_messages (session_id TEXT,message_id TEXT,turn_id TEXT,sequence INTEGER,
    payload_json TEXT,status TEXT,source TEXT,PRIMARY KEY(session_id,message_id),UNIQUE(session_id,sequence),
    FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id));`);
  db.close();
  const sessionId = randomUUID(), requestId = randomUUID();
  const metadata = { sessionId, ownerId: 'qoder-queue:test', cwd: directory, workspaceId: randomUUID() };
  const messages = id => [
    { id, turnId: id, role: 'user', text: 'actual input', timestamp: '2026-10-09T01:00:00Z', tools: [] },
    { id: 'assistant:' + id, turnId: id, role: 'assistant', text: 'actual reply', timestamp: '2026-10-09T01:00:01Z',
      completedAt: '2026-10-09T01:00:02Z', tools: [], parts: [{ id: 'text:1', type: 'text', text: 'actual reply' }] }
  ];
  // The writer is a seam for vendor serialization; transaction/collision behavior uses real SQLite.
  const write = (db, sid, message, turnId, source) => db.prepare(`INSERT INTO chat_session_messages
    VALUES (?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM chat_session_messages WHERE session_id=?),1),?,?,?)`)
    .run(sid,message.id,turnId,sid,JSON.stringify(message),'completed',source);
  const read = query => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(query).all(); } finally { db.close(); } };
  return { path, metadata, messages: messages(requestId), next: () => messages(randomUUID()), write, read };
}

test('desktop registration and complete projection commit once; identical synchronization is a no-op', t => {
  const f = fixture(t);
  assert.equal(appendDesktopTurn(f.path, f.metadata, f.messages, f.write).inserted, 2);
  const saved = f.read('SELECT * FROM chat_session_messages ORDER BY sequence');
  assert.equal(appendDesktopTurn(f.path, f.metadata, f.messages, f.write).inserted, 0);
  assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence'), saved);
  assert.deepEqual(saved.map(x => [x.sequence,x.turn_id]), [[1,f.messages[0].id],[2,f.messages[0].id]]);
  assert.equal(JSON.parse(f.read('SELECT extra_json FROM chat_sessions')[0].extra_json).postCoreProjection.ownerId, f.metadata.ownerId);
});

test('later turns append only to the verified prefix, never reorder previous rows', t => {
  const f = fixture(t);
  appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
  const before = f.read('SELECT * FROM chat_session_messages ORDER BY sequence'), next = f.next();
  assert.throws(() => appendDesktopTurn(f.path, f.metadata, next, f.write), /verified native prefix/);
  const metadata = { ...f.metadata, expectedPreviousTurn: { turnId: f.messages[0].id, text: 'actual reply',
    tools: f.messages[1].tools, parts: f.messages[1].parts } };
  appendDesktopTurn(f.path, metadata, next, f.write);
  assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence').slice(0,2), before);
  assert.deepEqual(f.read('SELECT sequence FROM chat_session_messages ORDER BY sequence').map(x=>x.sequence), [1,2,3,4]);
});

test('changed content and other owners preserve all existing desktop records', t => {
  const f = fixture(t);
  appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
  const before = f.read('SELECT * FROM chat_session_messages');
  const changed = structuredClone(f.messages); changed[1].text = 'fabricated reply';
  assert.throws(() => appendDesktopTurn(f.path, f.metadata, changed, f.write), /collision/);
  assert.throws(() => appendDesktopTurn(f.path, { ...f.metadata, ownerId: 'other-owner' }, f.messages, f.write), /not owned/);
  assert.throws(() => appendDesktopTurn(f.path, { ...f.metadata, cwd: tmpdir() }, f.messages, f.write), /not writable/);
  assert.deepEqual(f.read('SELECT * FROM chat_session_messages'), before);
});

test('desktop-only completed hooks, fragment IDs and thinking timing do not hide a verified native prefix', t => {
  for (const allowExisting of [false, true]) {
    const f = fixture(t);
    const nativeParts = [
      { id: 'sdk:thinking:0', type: 'thinking', text: 'verified thought', status: 'completed', parentToolUseId: null },
      { id: 'sdk:text:0', type: 'text', text: 'actual reply', parentToolUseId: null }
    ];
    f.messages[1].parts = nativeParts;
    appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
    const rendered = structuredClone(f.messages[1]);
    rendered.parts = [
      { id: 'hook:start', type: 'hook', hook: { event: 'SessionStart', status: 'succeeded' } },
      { ...nativeParts[0], id: 'chatcmpl:thinking:0', startedAt: '2026-10-09T01:00:00Z',
        completedAt: '2026-10-09T01:00:01Z', durationMs: 1000 },
      { ...nativeParts[1], id: 'assistant-segment:1:text:1' },
      { id: 'hook:stop', type: 'hook', hook: { event: 'Stop', status: 'failed', exitCode: 1 } }
    ];
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE chat_session_messages SET payload_json=? WHERE message_id=?')
      .run(JSON.stringify(rendered), rendered.id);
    if (allowExisting) db.exec("UPDATE chat_sessions SET extra_json='{}'; UPDATE chat_session_messages SET source='live'");
    db.close();
    const before = f.read('SELECT * FROM chat_session_messages ORDER BY sequence'), next = f.next();
    const metadata = { ...f.metadata, allowExisting, expectedPreviousTurn: { turnId: f.messages[0].id,
      text: rendered.text, tools: rendered.tools, parts: nativeParts } };
    for (const mutate of [
      parts => { parts[1].text = 'different native text'; },
      parts => { parts[0].text = 'different native thought'; },
      parts => { parts[1].parentToolUseId = 'different-tool'; },
      parts => { parts[0].status = 'running'; },
      parts => { parts.reverse(); }
    ]) {
      const parts = structuredClone(nativeParts); mutate(parts);
      assert.throws(() => appendDesktopTurn(f.path, { ...metadata,
        expectedPreviousTurn: { ...metadata.expectedPreviousTurn, parts } }, next, f.write), /verified native prefix/);
      assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence'), before);
    }
    assert.equal(appendDesktopTurn(f.path, metadata, next, f.write).inserted, 2);
    assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence').slice(0, 2), before);
  }
});

test('a running or unknown desktop hook still prevents prefix adoption', t => {
  for (const status of ['running', 'unknown']) {
    const f = fixture(t);
    appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
    const rendered = structuredClone(f.messages[1]);
    rendered.parts.push({ id: 'hook:pending', type: 'hook', hook: { event: 'Stop', status } });
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE chat_session_messages SET payload_json=? WHERE message_id=?')
      .run(JSON.stringify(rendered), rendered.id); db.close();
    const before = f.read('SELECT * FROM chat_session_messages ORDER BY sequence');
    assert.throws(() => appendDesktopTurn(f.path, { ...f.metadata, expectedPreviousTurn: {
      turnId: f.messages[0].id, text: 'actual reply', tools: [], parts: f.messages[1].parts } }, f.next(), f.write),
    /verified native prefix/);
    assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence'), before);
  }
});

test('writer failure rolls back registration and half-written turns', t => {
  const f = fixture(t);
  let count = 0;
  const failed = (...args) => { if (++count === 2) throw Error('writer failed'); return f.write(...args); };
  assert.throws(() => appendDesktopTurn(f.path, f.metadata, f.messages, failed), /writer failed/);
  assert.deepEqual(f.read('SELECT * FROM chat_sessions'), []);
  assert.deepEqual(f.read('SELECT * FROM chat_session_messages'), []);
  assert.throws(() => appendDesktopTurn(f.path, f.metadata, f.messages, () => {}), /unsupported/);
  assert.deepEqual(f.read('SELECT * FROM chat_sessions'), []);
});

test('archived and pending native registrations are never reopened by synchronization', t => {
  for (const column of ['archived','registration_json']) {
    const f = fixture(t); appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
    const db = new DatabaseSync(f.path);
    db.prepare(`UPDATE chat_sessions SET ${column}=?`).run(column === 'archived' ? 1 : '{}'); db.close();
    assert.throws(() => appendDesktopTurn(f.path, f.metadata, f.messages, f.write), /not writable/);
    assert.equal(f.read('SELECT * FROM chat_session_messages').length, 2);
  }
});

test('live desktop inputs and revocation roll back without changing retained history', t => {
  const f = fixture(t);
  appendDesktopTurn(f.path, f.metadata, f.messages, f.write);
  const before = f.read('SELECT * FROM chat_session_messages'), db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE chat_session_input_receipts (session_id TEXT,state TEXT)');
  db.prepare('INSERT INTO chat_session_input_receipts VALUES (?,?)').run(f.metadata.sessionId, 'dispatching'); db.close();
  assert.throws(() => appendDesktopTurn(f.path, f.metadata, f.messages, f.write), /pending input/);
  assert.deepEqual(f.read('SELECT * FROM chat_session_messages'), before);
  const g = fixture(t);
  let calls = 0;
  assert.throws(() => appendDesktopTurn(g.path, g.metadata, g.messages, g.write,
    () => { if (++calls === 3) throw Error('registration revoked'); }), /revoked/);
  assert.deepEqual(g.read('SELECT * FROM chat_session_messages'), []);
  assert.deepEqual(g.read('SELECT * FROM chat_sessions'), []);
});

test('successive native turns compare the aggregated text and completed tools, not only the last text', async t => {
  for (const withTool of [false, true]) {
    const f = fixture(t), sessionId = f.metadata.sessionId;
    const user = (id, text) => ({ type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null,
      timestamp: '2026-10-09T01:00:00Z', message: { role: 'user', content: text } });
    const assistant = content => ({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
      parent_tool_use_id: null, message: { role: 'assistant', content } });
    const firstId = randomUUID(), secondId = randomUUID(), toolId = 'read-1';
    const prefix = [user(firstId, 'first'), assistant([{ type: 'text', text: 'first fragment' }])];
    if (withTool) prefix.push(assistant([{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: 'fixture.txt' } }]),
      { type: 'user', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'fixture contents' }] } });
    prefix.push(assistant([{ type: 'text', text: 'final fragment' }]));
    const history = [...prefix, user(secondId, 'second'), assistant([{ type: 'text', text: 'second reply' }])];
    const record = (id, offset, final) => ({ schemaVersion: 1, requestId: id, sessionId, historyOffset: offset,
      assistantId: final.uuid, resultId: randomUUID(), lifecycle: 'queued-started-completed',
      terminalOutcome: 'completed', subtype: 'success', isError: false, completedAt: '2026-10-09T01:00:02Z' });
    // Faithful aggregate seam: the installed vendor projection is separately checked against its actual chunk.
    class Projection {
      constructor(id, timestamp) { this.id = 'assistant:' + id; this.timestamp = timestamp; this.parts = []; this.tools = []; }
      applyAssistant(message) {
        for (const part of message.message.content) {
          if (part.type === 'text') this.parts.push({ id: message.uuid, type: 'text', text: part.text });
          else if (part.type === 'tool_use') this.tools.push({ id: part.id, name: part.name, status: 'running', input: part.input });
        }
      }
      applyToolResults(message) {
        for (const part of message.message.content) Object.assign(this.tools.find(tool => tool.id === part.tool_use_id),
          { status: 'completed', output: part.content });
      }
      snapshot(status) { return { id: this.id, role: 'assistant', timestamp: this.timestamp, completedAt: this.completedAt,
        status, text: this.parts.map(part => part.text).join('\n\n'), parts: this.parts, tools: this.tools }; }
    }
    const sdk = { getSessionInfo: async () => ({ sessionId, cwd: f.metadata.cwd }),
      getSessionMessages: async (_id, options) => history.slice(options.offset, options.offset + options.limit) };
    const common = { sdk, config: { root: f.metadata.cwd, workspaceId: f.metadata.workspaceId },
      databasePath: f.path, ownerId: f.metadata.ownerId, projection: { Projection, writeMessage: f.write } };
    const first = record(firstId, 0, prefix.at(-1)), second = record(secondId, prefix.length, history.at(-1));
    assert.equal((await synchronizeDesktopTurn({ ...common, record: first,
      args: { requestId: firstId, sessionId, prompt: 'first' } })).inserted, 2);
    const before = f.read('SELECT * FROM chat_session_messages ORDER BY sequence');
    assert.equal(JSON.parse(before[1].payload_json).text, 'first fragment\n\nfinal fragment');
    assert.equal(JSON.parse(before[1].payload_json).tools.length, withTool ? 1 : 0);
    assert.equal((await synchronizeDesktopTurn({ ...common, record: second,
      args: { requestId: secondId, sessionId, prompt: 'second' } })).inserted, 2);
    assert.deepEqual(f.read('SELECT * FROM chat_session_messages ORDER BY sequence').slice(0,2), before);
    assert.equal((await synchronizeDesktopTurn({ ...common, record: second,
      args: { requestId: secondId, sessionId, prompt: 'second' } })).inserted, 0);
  }
});
