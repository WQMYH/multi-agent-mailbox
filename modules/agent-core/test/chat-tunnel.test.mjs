import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ensureTunnel, tunnelStatus, stopTunnel, configureReadAccess, chatTunnelCommand } from '../src/chat-tunnel.mjs';
import { invoke } from '../src/cli.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { grantTemporaryThreadRead, loadReadPolicy } from '../../../qoder-codex-bridge/scripts/codex-read.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'chat-tunnel-test-'));
const configPath = join(root, 'config.json'), policyPath = join(root, 'read.json'), profile = join(root, 'profile.json');
const starts = join(root, 'starts.jsonl'), healthFile = join(root, 'health.url');
const scope = { threadIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'], workspaceRoots: [root] };
const oldNodeOptions = process.env.NODE_OPTIONS;
const coreLink = join(root, 'core-link');
symlinkSync(fileURLToPath(new URL('..', import.meta.url)), coreLink, process.platform === 'win32' ? 'junction' : 'dir');
writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, ...scope }));
writeFileSync(profile, JSON.stringify({ healthFile, starts }));
writeFileSync(join(root, 'client.mjs'), `import{createServer}from'node:http';import{writeFileSync}from'node:fs';
const server=createServer((_req,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>writeFileSync(process.argv[2],'http://127.0.0.1:'+server.address().port));`);
writeFileSync(join(root, 'launcher.mjs'), `import{spawn}from'node:child_process';import{readFileSync,appendFileSync}from'node:fs';import{fileURLToPath}from'node:url';
export function startTunnel(_client,profile,_policy,options){const c=JSON.parse(readFileSync(profile,'utf8'));appendFileSync(c.starts,JSON.stringify({session:options.env.CODEX_CHAT_READ_SESSION})+'\\n');if(c.startupError)throw Object.assign(Error(c.startupError),{code:c.errorCode});
return spawn(process.execPath,c.fail?['-e','process.exit(7)']:[fileURLToPath(new URL('./client.mjs',import.meta.url)),c.healthFile],{env:{...process.env,...options.env},stdio:options.stdio,windowsHide:true});}`);
writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, client: process.execPath, profile,
  launcher: join(root, 'launcher.mjs'), readPolicy: policyPath, stateDir: join(root, 'state'), healthUrlFile: healthFile }));

async function until(predicate, timeout = 14000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const state = await tunnelStatus(configPath); if (predicate(state)) return state; await new Promise(done => setTimeout(done, 100)); }
  throw Error('Timed out waiting for the observable supervisor state');
}
try {
  const malformed = join(root, 'malformed.json');
  writeFileSync(malformed, 'private-token-must-not-leak');
  await assert.rejects(chatTunnelCommand('status', malformed), error =>
    error.message.includes('Invalid local Chat Tunnel JSON') && !error.message.includes('private-token-must-not-leak'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/supervisor.lock'), JSON.stringify({ pid: 999999999, sessionId: 'dead-owner' }));
  // Widen the actual unlink race in disposable child processes, not a production test branch.
  const raceFixture = join(root, 'race-fixture.mjs');
  writeFileSync(raceFixture, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const unlink=fs.unlinkSync;
fs.unlinkSync=function(path){if(String(path).endsWith('supervisor.lock')){try{if(JSON.parse(fs.readFileSync(path,'utf8')).pid===999999999)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);}catch{}}return unlink(path)};syncBuiltinESMExports();`);
  process.env.NODE_OPTIONS = `${oldNodeOptions ?? ''} --import=${pathToFileURL(raceFixture).href}`.trim();
  const [discovered] = await Promise.all([invoke(['--registry', join(root, 'registry.json'), 'discover'], {},
    { env: { ...process.env, AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath } }), ensureTunnel(configPath), ensureTunnel(configPath)]);
  if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
  assert(Array.isArray(discovered.modules));
  const aliasCli = spawnSync(process.execPath, [join(coreLink, 'src/cli.mjs'), '--registry', join(root, 'registry.json'), 'discover'],
    { input: '{}', encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath } });
  assert.equal(aliasCli.status, 0, aliasCli.stderr); assert(Array.isArray(JSON.parse(aliasCli.stdout).modules));
  const ready = await until(state => state.ready);
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1);
  assert.equal(ready.access.active, false);
  const granted = await configureReadAccess(configPath, scope);
  assert.equal(granted.access.mode, 'temporary'); assert.equal(granted.access.active, true);
  const before = JSON.parse(readFileSync(policyPath, 'utf8'));
  // Widen a real Core policy read and prove the Chat writer shares its lock across processes.
  const readDelay = join(root, 'read-delay.mjs'), readReached = join(root, 'read-reached'), worker = join(root, 'policy-worker.mjs');
  const tunnelModule = new URL('../src/chat-tunnel.mjs', import.meta.url).href;
  writeFileSync(readDelay, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync;let once=false;
fs.readFileSync=function(path,...args){const result=read.call(this,path,...args);if(!once&&String(path)===${JSON.stringify(policyPath)}){once=true;fs.writeFileSync(${JSON.stringify(readReached)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);}return result;};syncBuiltinESMExports();`);
  writeFileSync(worker, `import {chatTunnelCommand} from ${JSON.stringify(tunnelModule)};await chatTunnelCommand(process.argv[2],process.argv[3]);`);
  const runPolicy = command => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(readDelay).href, worker, command, configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', value => { errors += value; });
    return new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(Error(errors))); });
  };
  async function reached() { const until = Date.now() + 5000; while (!existsSync(readReached)) { if (Date.now() >= until) throw Error('policy reader did not reach fixture'); await new Promise(done => setTimeout(done, 20)); } }
  const extraThread = 'cccccccc-cccc-cccc-cccc-cccccccccccc', grantEnv = { ...process.env, CODEX_CHAT_READ_SESSION: before.sessionId };
  const expectedPolicy = loadReadPolicy(policyPath, { env: grantEnv });
  const coreGrant = runPolicy('grant'); await reached();
  await grantTemporaryThreadRead(policyPath, extraThread, { expectedPolicy, env: grantEnv, assertActive: async () => {} }); await coreGrant;
  assert.deepEqual(new Set(JSON.parse(readFileSync(policyPath)).threadIds), new Set([...scope.threadIds, extraThread]));
  unlinkSync(readReached);
  const revoking = runPolicy('revoke'); await reached();
  await assert.rejects(grantTemporaryThreadRead(policyPath, 'dddddddd-dddd-dddd-dddd-dddddddddddd', { expectedPolicy, env: grantEnv, assertActive: async () => {} }), /read_not_authorized/);
  await revoking; assert.equal(JSON.parse(readFileSync(policyPath)).sessionId, undefined); unlinkSync(readReached);
  const persistentGrant = runPolicy('grant-persistent'); await reached();
  await assert.rejects(grantTemporaryThreadRead(policyPath, extraThread, { expectedPolicy, env: grantEnv, assertActive: async () => {} }), /read_not_authorized/);
  await persistentGrant; assert.equal(JSON.parse(readFileSync(policyPath)).mode, 'persistent'); unlinkSync(readReached);
  // Held/stale locks report busy and are never automatically removed.
  writeFileSync(`${policyPath}.lock`, 'operator-held');
  await assert.rejects(configureReadAccess(configPath, scope), error => error.code === 'read_policy_busy');
  assert.equal(readFileSync(`${policyPath}.lock`, 'utf8'), 'operator-held'); unlinkSync(`${policyPath}.lock`);
  const replaced = await configureReadAccess(configPath, scope); assert.deepEqual(replaced.access.threadIds, scope.threadIds);
  process.kill(ready.clientPid); // Only the disposable fixture process, never a production client.
  const recovered = await until(state => state.ready && state.clientPid !== ready.clientPid);
  assert.equal(recovered.sessionId, ready.sessionId);
  assert.equal(recovered.access.active, true);
  assert.deepEqual(JSON.parse(readFileSync(policyPath, 'utf8')), before);
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 2);
  const savedStatus = readFileSync(join(root, 'state/status.json'), 'utf8');
  writeFileSync(join(root, 'state/status.json'), JSON.stringify({ ...recovered, sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }));
  assert.equal((await ensureTunnel(configPath)).error, 'supervisor_identity_unavailable');
  assert.equal((await tunnelStatus(configPath)).access.active, false);
  writeFileSync(join(root, 'state/status.json'), savedStatus);
  await stopTunnel(configPath);
  assert.equal((await tunnelStatus(configPath)).access.active, false);
  await ensureTunnel(configPath);
  const restarted = await until(state => state.ready);
  assert.notEqual(restarted.sessionId, ready.sessionId);
  assert.equal(restarted.access.active, false); // Reusing a scope file never renews temporary consent.
  await chatTunnelCommand('grant-persistent', configPath, scope);
  await stopTunnel(configPath);
  assert.equal((await tunnelStatus(configPath)).access.active, true);
  await chatTunnelCommand('revoke', configPath);
  assert.equal((await tunnelStatus(configPath)).access.active, false);
  const mcp = spawn(process.execPath, [join(coreLink, 'src/mcp-server.mjs')],
    { env: { ...process.env, AGENT_CORE_REGISTRY: join(root, 'registry.json'), AGENT_CORE_CHAT_TUNNEL_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  mcp.stdout.on('data', chunk => { output += chunk; }); mcp.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise(done => mcp.once('exit', code => done(code)));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const initialized = await until(state => state.ready);
  await stopTunnel(configPath);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_discover', arguments: {} } }) + '\n');
  const demandedAgain = await until(state => state.ready);
  assert.notEqual(demandedAgain.sessionId, initialized.sessionId);
  assert.equal(demandedAgain.access.active, false);
  mcp.stdin.end(); assert.equal(await exited, 0, errors);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.find(row => row.id === 1).result.serverInfo.name, 'agent-core');
  assert(Array.isArray(responses.find(row => row.id === 2).result.structuredContent.modules));
  await stopTunnel(configPath);
  writeFileSync(profile, JSON.stringify({ healthFile, starts, fail: true }));
  await ensureTunnel(configPath);
  const failed = await until(state => state.stage === 'failed');
  assert.equal(failed.attempts, 4);
  assert.equal(failed.error.code, 'tunnel_exited');
  assert.equal(failed.error.exitCode, 7);
  assert.equal(failed.ready, false);
  assert(failed.diagnostics.command.includes('status'));
  assert(failed.diagnostics.stderrLog.endsWith('tunnel.stderr.log'));
  await stopTunnel(configPath);
  writeFileSync(profile, JSON.stringify({ healthFile, starts, startupError: 'Tunnel runtime API key is not configured' }));
  await ensureTunnel(configPath);
  const missingKey = await until(state => state.stage === 'failed');
  assert.equal(missingKey.error.cause.code, 'runtime_key_missing');
  assert.equal(missingKey.error.cause.message, 'Tunnel runtime API key is not configured');
  await stopTunnel(configPath);
  writeFileSync(profile, JSON.stringify({ healthFile, starts, startupError: 'private-token-must-not-leak', errorCode: 'EACCES' }));
  await ensureTunnel(configPath);
  const denied = await until(state => state.stage === 'failed');
  assert.equal(denied.error.cause.code, 'EACCES');
  assert(!JSON.stringify(denied).includes('private-token-must-not-leak'));
  console.log('PASS: Core CLI/MCP demand start, concurrent singleton, exact-generation recovery, temporary grant ends, explicit persistence/revocation, bounded failed start and diagnostics');
} finally {
  if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
  await stopTunnel(configPath);
  assert.equal(dirname(root), resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}
