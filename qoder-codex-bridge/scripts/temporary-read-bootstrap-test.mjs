import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'temporary-read-bootstrap-')));
const data = join(root, 'data'), workspace = join(root, 'workspace'), stateDir = join(root, 'state');
for (const dir of [data, workspace, stateDir]) fs.mkdirSync(dir);
const oldThread = randomUUID(), target = randomUUID(), second = randomUUID(), sessionId = randomUUID();
const policyPath = join(root, 'policy.json'), tunnelConfig = join(root, 'tunnel.json');
let stopping = false, beforeSessionReply;
const owner = createServer((_req, res) => {
  beforeSessionReply?.();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ sessionId, supervisorPid: process.pid, stopping }));
});
await new Promise(done => owner.listen(0, '127.0.0.1', done));
const ownerUrl = `http://127.0.0.1:${owner.address().port}`;
fs.writeFileSync(join(stateDir, 'status.json'), JSON.stringify({ sessionId, supervisorPid: process.pid, controlUrl: ownerUrl }));
fs.writeFileSync(tunnelConfig, JSON.stringify({ schemaVersion: 1, readPolicy: policyPath, stateDir }));
const oldPolicy = { schemaVersion: 2, mode: 'temporary', sessionId: randomUUID(), ownerPid: process.pid,
  ownerUrl, threadIds: [oldThread], workspaceRoots: [workspace] };
fs.writeFileSync(policyPath, JSON.stringify(oldPolicy));
const host = join(root, 'host.mjs'), sent = join(root, 'sent');
fs.writeFileSync(host, `import{createInterface}from'node:readline';import fs from'node:fs';
const ids=${JSON.stringify([oldThread, target, second])},cwd=${JSON.stringify(workspace)};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-06-18'};
else if(m.params?.name==='list_threads')result={content:[{type:'text',text:JSON.stringify({pinnedThreads:[],threads:ids.map(id=>({id,kind:'codex',cwd,title:id}))})}]};
else if(m.params?.name==='read_thread')result={content:[{type:'text',text:JSON.stringify({thread:{id:m.params.arguments.threadId,kind:'codex',cwd,title:'fixture'},turns:[],page:{hasMore:false}})}]};
else {fs.writeFileSync(${JSON.stringify(sent)},'unexpected write');throw Error('No sending in this fixture');}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
fs.writeFileSync(join(data, 'host-config.json'), JSON.stringify({ threadId: oldThread, cwd: workspace,
  script: host, pipePath: '\\\\.\\pipe\\bootstrap-fixture' }));
const program = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const { grantTemporaryThreadRead, loadReadPolicy } = await import(pathToFileURL(join(dirname(program), 'codex-read.mjs')).href);
const children = new Set();
function server(extraEnv = {}) {
  const child = spawn(process.execPath, [program], { env: { ...process.env, QODER_PLUGIN_DATA: data,
    CODEX_CHAT_READ_CONFIG: policyPath, CODEX_CHAT_READ_SESSION: sessionId, CODEX_CHAT_TUNNEL_CONFIG: tunnelConfig,
    CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: JSON.stringify({ schemaVersion: 1, kind: 'privateConnection',
      principalId: 'private-fixture', readSessionId: sessionId }), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(child); child.stderr.resume();
  let id = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line), waiter = pending.get(m.id);
    if (waiter) { pending.delete(m.id); clearTimeout(waiter.timer); waiter.resolve(m.result); }
  });
  child.on('exit', () => { children.delete(child); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Server exited')); } });
  return { async call(name, args) {
    const result = await new Promise((resolveCall, reject) => {
      const n = ++id, timer = setTimeout(() => reject(Error('Fixture request timed out')), 10000);
      pending.set(n, { resolve: resolveCall, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    return { isError: result.isError, value: JSON.parse(result.content[0].text) };
  }, async close() { if (!children.has(child)) return; const ended = new Promise(done => child.once('exit', done)); child.kill(); await ended; } };
}
try {
  const rpc = server();
  const before = fs.readFileSync(policyPath, 'utf8');
  const denied = await rpc.call('read_codex', { kind: 'thread', threadId: target });
  assert.equal(denied.value.error, 'read_not_authorized');
  assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
  assert(!(await rpc.call('select_codex_task', { threadId: target })).isError);
  assert.equal(fs.readFileSync(policyPath, 'utf8'), before, 'Selecting without explicit consent grants nothing');
  const granted = await rpc.call('select_codex_task', { threadId: target, grantReadAccess: true });
  assert(!granted.isError, `Explicit current-interval grant failed: ${JSON.stringify(granted.value)}`);
  assert.equal(granted.value.readAccess.sessionId, sessionId);
  const current = JSON.parse(fs.readFileSync(policyPath));
  assert.deepEqual(current.threadIds, [target], 'No old thread scope is restored');
  assert.deepEqual(current.workspaceRoots, [], 'No old file scope is restored');
  assert.equal(current.mode, 'temporary'); assert.equal(current.ownerPid, process.pid);
  assert(!(await rpc.call('read_codex', { kind: 'thread', threadId: target })).isError);
  assert.equal((await rpc.call('read_codex', { kind: 'thread', threadId: oldThread })).value.error, 'read_target_not_allowed');
  const another = await rpc.call('select_codex_task', { threadId: second, grantReadAccess: true });
  assert(!another.isError);
  assert.deepEqual(new Set(JSON.parse(fs.readFileSync(policyPath)).threadIds), new Set([target, second]));
  await rpc.close();

  // The deadline can elapse during the final supervisor await, after earlier checks passed.
  let closed = false;
  const expectedPolicy = loadReadPolicy(policyPath, { env: { CODEX_CHAT_READ_SESSION: sessionId } });
  const beforeLateGrant = fs.readFileSync(policyPath, 'utf8');
  beforeSessionReply = () => { closed = true; };
  await assert.rejects(grantTemporaryThreadRead(policyPath, randomUUID(), { expectedPolicy,
    usageInterval: { mode: 'temporary', sessionId, ownerPid: process.pid, ownerUrl }, env: { CODEX_CHAT_READ_SESSION: sessionId },
    assertActive: async () => { assert(!closed); },
    assertWritable: () => { if (closed) throw Object.assign(Error('host_timeout'), { code: 'host_timeout' }); }
  }), error => error.code === 'host_timeout');
  assert(closed); assert.equal(fs.readFileSync(policyPath, 'utf8'), beforeLateGrant, 'No late permission write after timeout');
  beforeSessionReply = undefined;

  const saved = fs.readFileSync(policyPath, 'utf8');
  const wrongSession = server({ CODEX_CHAT_READ_SESSION: randomUUID() });
  assert.equal((await wrongSession.call('select_codex_task', { threadId: target, grantReadAccess: true })).value.error, 'read_not_authorized');
  assert.equal(fs.readFileSync(policyPath, 'utf8'), saved); await wrongSession.close();
  const noDelegation = server({ CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: '' });
  assert.equal((await noDelegation.call('select_codex_task', { threadId: target, grantReadAccess: true })).value.error, 'read_not_authorized');
  assert.equal(fs.readFileSync(policyPath, 'utf8'), saved); await noDelegation.close();
  const stopped = server(); stopping = true;
  assert.equal((await stopped.call('select_codex_task', { threadId: target, grantReadAccess: true })).value.error, 'read_not_authorized');
  assert.equal(fs.readFileSync(policyPath, 'utf8'), saved); await stopped.close(); stopping = false;
  fs.writeFileSync(policyPath, JSON.stringify({ schemaVersion: 2, mode: 'persistent', threadIds: [oldThread], workspaceRoots: [workspace] }));
  const permanent = fs.readFileSync(policyPath, 'utf8'), persistent = server();
  assert.equal((await persistent.call('select_codex_task', { threadId: target, grantReadAccess: true })).value.error, 'read_not_authorized');
  assert.equal(fs.readFileSync(policyPath, 'utf8'), permanent); await persistent.close();
  assert(!fs.existsSync(sent)); assert(!fs.existsSync(`${policyPath}.lock`));
  console.log('PASS: explicit fresh-interval grant, no old scope/files/persistence, same-interval merge, identity/stopping refusals, no sends');
} finally {
  for (const child of [...children]) { const ended = new Promise(done => child.once('exit', done)); child.kill(); await ended; }
  await new Promise(done => owner.close(done));
  assert.equal(dirname(root), fs.realpathSync.native(tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
