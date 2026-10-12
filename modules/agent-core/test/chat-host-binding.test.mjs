import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : new URL('../src/chat-tunnel.mjs', import.meta.url).href;
const { ensureConfiguredChatTunnel } = await import(modulePath);
const root = fs.mkdtempSync(join(tmpdir(), 'chat-host-binding-')), sessionId = randomUUID();
const owner = createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
  res.end(req.url === '/session' ? JSON.stringify({ sessionId, supervisorPid: process.pid, stopping: false }) : '{}'); });
await new Promise(done => owner.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${owner.address().port}`, stateDir = join(root, 'state'); fs.mkdirSync(stateDir);
const policy = join(root, 'policy.json'), profile = join(root, 'profile.json'), health = join(root, 'health.url');
const adapter = join(root, 'binding.mjs'), calls = join(root, 'calls.jsonl'), configPath = join(root, 'tunnel.json');
fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 2, mode: 'temporary', threadIds: [randomUUID()], workspaceRoots: [] }));
const originalPolicy = fs.readFileSync(policy, 'utf8'); fs.writeFileSync(profile, '{}'); fs.writeFileSync(health, url);
fs.writeFileSync(join(stateDir, 'status.json'), JSON.stringify({ sessionId, supervisorPid: process.pid, clientPid: process.pid, controlUrl: url }));
fs.writeFileSync(adapter, `import fs from'node:fs';export async function connectVerifiedHost(dataDir,{preferredPipePath}) {
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({dataDir,preferredPipePath})+'\\n');
if(fs.existsSync(${JSON.stringify(join(root, 'host-unavailable'))})) throw Object.assign(Error('No verified host'),{code:'host_binding_unavailable'});
return {client:{close(){fs.appendFileSync(${JSON.stringify(calls)},'closed\\n');}},config:{},rebound:preferredPipePath!==undefined};}`);
const config = { schemaVersion: 1, client: process.execPath, profile, launcher: adapter, readPolicy: policy,
  stateDir, healthUrlFile: health, hostBinding: { module: adapter, dataDir: root } };
fs.writeFileSync(configPath, JSON.stringify(config));
try {
  const env = { AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath, CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\trusted-desktop-fixture' };
  const status = await ensureConfiguredChatTunnel(join(root, 'registry.json'), env);
  assert.equal(status?.hostBinding?.state, 'verified', 'Core startup must forward the trusted desktop binding');
  assert.equal(status.running, true); assert.equal(status.hostBinding.rebound, true);
  const rows = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(rows[0]), { dataDir: root, preferredPipePath: env.CODEX_APP_TOOLS_PIPE_PATH });
  assert.equal(rows[1], 'closed'); assert.equal(rows.length, 2);
  const missing = await ensureConfiguredChatTunnel(join(root, 'registry.json'), { AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath });
  assert.equal(missing.hostBinding.state, 'verified', 'Missing runtime override must not reject an already verified configured host');
  assert.equal(missing.hostBinding.rebound, false); assert.equal(missing.running, true);
  const configuredRows = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(configuredRows.length, 4); assert.deepEqual(JSON.parse(configuredRows[2]), {dataDir:root});
  assert.equal(configuredRows[3], 'closed', 'Configured host clients must also close');
  fs.writeFileSync(join(root, 'host-unavailable'), 'fixture');
  const unavailable = await ensureConfiguredChatTunnel(join(root, 'registry.json'), { AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath });
  assert.deepEqual(unavailable.hostBinding, {state:'failed',error:'host_binding_unavailable'});
  assert.equal(unavailable.running, true, 'A host failure must not mark a live tunnel offline');
  assert.equal(fs.readFileSync(policy, 'utf8'), originalPolicy, 'Host recovery must not renew reading permissions');
  console.log('PASS: Core demand verifies configured host without override, forwards a real override, distinguishes host failure and never renews scope');
} finally { await new Promise(done => owner.close(done)); assert.equal(dirname(root), resolve(tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
