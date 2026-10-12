import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pause = ms => new Promise(done => setTimeout(done, ms));
const json = path => {
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { throw Error(`Invalid local Chat Tunnel JSON: ${path}`); }
};
function startupCause(error) {
  const messages = new Map([
    ['Tunnel runtime API key is not configured', 'runtime_key_missing'],
    ['Could not read local Tunnel startup settings', 'local_settings_unreadable'],
    ['No working proxy or direct OpenAI connection; Tunnel was not started', 'network_route_unavailable']
  ]);
  const known = messages.get(error?.message);
  if (known) return { code: known, message: error.message };
  // Unknown exception text can contain credentials; retain only the machine failure class/code.
  return { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : error?.name === 'SyntaxError' ? 'SYNTAX_ERROR' : 'STARTUP_EXCEPTION',
    message: 'Unexpected local startup failure. Check the configured launcher/client paths and supervisor logs.' };
}
function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
export function loadTunnelConfig(path) {
  const config = json(path);
  const keys = ['schemaVersion', 'client', 'profile', 'launcher', 'readPolicy', 'stateDir', 'healthUrlFile', 'hostBinding'];
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => !keys.includes(key))) throw Error('Invalid Chat Tunnel configuration');
  for (const key of keys.slice(1).filter(key => key !== 'hostBinding'))
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw Error(`Chat Tunnel ${key} requires an absolute local path`);
  for (const key of ['client', 'profile', 'launcher', 'readPolicy'])
    if (!statSync(config[key]).isFile()) throw Error(`Chat Tunnel ${key} is not a file`);
  if (config.hostBinding !== undefined) {
    const binding = config.hostBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).length !== 2 || !isAbsolute(binding.module ?? '') || !isAbsolute(binding.dataDir ?? '')
      || !statSync(binding.module).isFile() || !statSync(binding.dataDir).isDirectory()) throw Error('Invalid local desktop host binding configuration');
  }
  return config;
}
const statePath = config => join(config.stateDir, 'status.json');
const stopPath = config => join(config.stateDir, 'stop.json');
function readState(config) { try { return json(statePath(config)); } catch { return {}; } }
async function supervisorMatches(state) {
  if (!alive(state.supervisorPid)) return false;
  try {
    const url = new URL(state.controlUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
      || url.username || url.password || url.search || url.hash) return false;
    const response = await fetch(new URL('/session', url), { signal: AbortSignal.timeout(1000), redirect: 'error' });
    const identity = await response.json();
    return response.ok && identity.sessionId === state.sessionId && identity.supervisorPid === state.supervisorPid && identity.stopping === false;
  } catch { return false; }
}
async function health(config) {
  try {
    const url = new URL(readFileSync(config.healthUrlFile, 'utf8').trim());
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw Error();
    const response = await fetch(new URL('/readyz', url), { signal: AbortSignal.timeout(1000), redirect: 'error' });
    return { ready: response.ok, httpStatus: response.status, healthUrl: url.origin, adminUrl: `${url.origin}/ui` };
  } catch { return { ready: false, error: 'health_unreachable' }; }
}
export async function tunnelStatus(path) {
  const config = loadTunnelConfig(path), state = readState(config);
  const running = await supervisorMatches(state), clientRunning = running && alive(state.clientPid);
  let policy = {};
  try { policy = json(config.readPolicy); } catch {}
  const accessActive = policy.mode === 'persistent' || running && policy.sessionId === state.sessionId && policy.ownerPid === state.supervisorPid;
  return { ...state, running, clientRunning, ...(clientRunning ? await health(config) : { ready: false }),
    access: { mode: policy.mode === 'persistent' ? 'persistent' : 'temporary', active: !!accessActive,
      threadIds: policy.threadIds ?? [], workspaceRoots: policy.workspaceRoots ?? [] },
    diagnostics: { config: path, statusFile: statePath(config), stdoutLog: join(config.stateDir, 'tunnel.stdout.log'),
      stderrLog: join(config.stateDir, 'tunnel.stderr.log'), command: `node "${fileURLToPath(import.meta.url)}" status "${path}"` },
    remoteColdStart: 'requires_an_already_online_local_execution_channel' };
}
export async function ensureTunnel(path) {
  const config = loadTunnelConfig(path), previous = readState(config);
  if (alive(previous.supervisorPid)) {
    const status = await tunnelStatus(path);
    return status.running ? status : { ...status, error: 'supervisor_identity_unavailable',
      hint: 'The recorded PID is alive but this usage interval cannot be verified. Inspect the local status and supervisor logs; do not kill it by PID alone.' };
  }
  mkdirSync(config.stateDir, { recursive: true });
  const out = openSync(join(config.stateDir, 'supervisor.stdout.log'), 'a', 0o600);
  const err = openSync(join(config.stateDir, 'supervisor.stderr.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', resolve(path)],
      { detached: true, windowsHide: true, stdio: ['ignore', out, err] });
    child.on('error', () => {}); child.unref();
  } finally { closeSync(out); closeSync(err); }
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = readState(config);
    if (state.sessionId !== previous.sessionId && (alive(state.supervisorPid) || state.stage === 'failed')) return tunnelStatus(path);
    await pause(100);
  }
  return { ...await tunnelStatus(path), error: 'supervisor_start_unconfirmed',
    hint: 'Inspect supervisor.stderr.log and supervisor.lock/recovery.lock. A crashed lock owner must be verified before an operator removes its stale lock; no live PID is killed.' };
}
export async function stopTunnel(path) {
  const config = loadTunnelConfig(path), state = readState(config);
  if (!alive(state.supervisorPid)) return tunnelStatus(path);
  // Ask the exact supervisor generation to stop; never kill an arbitrary recycled PID.
  save(stopPath(config), { sessionId: state.sessionId });
  for (let attempt = 0; attempt < 40 && alive(state.supervisorPid); attempt++) await pause(100);
  return tunnelStatus(path);
}
export async function configureReadAccess(path, scope, persistent = false) {
  const config = loadTunnelConfig(path);
  await withReadPolicyLock(config.readPolicy, async (policyPath, write) => {
    const state = readState(config);
    // Omitted scope preserves the latest committed IDs, not a pre-lock snapshot.
    const input = scope && Object.keys(scope).length ? scope : json(policyPath);
    if (!Array.isArray(input.threadIds) || !input.threadIds.length || input.threadIds.length > 32
      || input.threadIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
      || !Array.isArray(input.workspaceRoots) || input.workspaceRoots.length > 16
      || input.workspaceRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || !statSync(root).isDirectory()))
      throw Error('Read access requires explicit valid threadIds and workspaceRoots');
    if (!persistent && !await supervisorMatches(state)) throw Error('Start and verify this usage interval before granting temporary read access');
    // Explicit operator scope remains a replacement; do not merge back revoked IDs.
    write({ schemaVersion: 2, mode: persistent ? 'persistent' : 'temporary',
      threadIds: input.threadIds, workspaceRoots: input.workspaceRoots,
      ...(!persistent ? { sessionId: state.sessionId, ownerPid: state.supervisorPid, ownerUrl: state.controlUrl } : {}) });
  });
  return tunnelStatus(path);
}
async function withReadPolicyLock(path, run) {
  const policyPath = realpathSync.native(resolve(path)), lock = `${policyPath}.lock`, deadline = Date.now() + 5000;
  if (statSync(policyPath).nlink !== 1) throw Error('Read policy must have exactly one link');
  let fd;
  while (fd === undefined) {
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw Object.assign(Error('Read policy is busy; inspect the lock owner before removing a stale lock'), { code: 'read_policy_busy' });
      await pause(20);
    }
  }
  closeSync(fd);
  const temporary = `${policyPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    return await run(policyPath, value => {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(text) > 16384) throw Error('Read policy exceeds its readable size limit');
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); renameSync(temporary, policyPath);
    });
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } finally { unlinkSync(lock); }
  }
}
export async function chatTunnelCommand(command, path, input = {}) {
  if (command === 'ensure') return ensureDesktopAndTunnel(path);
  if (command === 'status') return tunnelStatus(path);
  if (command === 'stop') return stopTunnel(path);
  if (command === 'grant') return configureReadAccess(path, input);
  // Operator-only explicit command. Never infer this choice from an old config or model request.
  if (command === 'grant-persistent') return configureReadAccess(path, input, true);
  if (command === 'revoke') {
    const config = loadTunnelConfig(path);
    await withReadPolicyLock(config.readPolicy, (policyPath, write) => {
      const policy = json(policyPath);
      write({ schemaVersion: 2, mode: 'temporary', threadIds: policy.threadIds, workspaceRoots: policy.workspaceRoots });
    });
    return tunnelStatus(path);
  }
  throw Error('Chat Tunnel command must be ensure, status, stop, grant, grant-persistent or revoke');
}
async function ensureDesktopAndTunnel(path, env = process.env) {
  const config = loadTunnelConfig(path);
  let hostBinding;
  if (config.hostBinding) {
    let connection;
    try {
      const binding = await import(pathToFileURL(config.hostBinding.module).href);
      connection = await binding.connectVerifiedHost(config.hostBinding.dataDir, { preferredPipePath: env.CODEX_APP_TOOLS_PIPE_PATH });
      hostBinding = { state: 'verified', rebound: connection.rebound === true };
    } catch (error) {
      hostBinding = { state: 'failed', error: /^host_[a-z_]+$/.test(error.code ?? '') ? error.code : 'host_binding_failed' };
    } finally { connection?.client.close(); }
  }
  return { ...await ensureTunnel(path), ...(hostBinding ? { hostBinding } : {}) };
}
export async function ensureConfiguredChatTunnel(registryPath, env = process.env) {
  const path = env.AGENT_CORE_CHAT_TUNNEL_CONFIG ?? join(dirname(registryPath), 'chat-tunnel.json');
  if (!existsSync(path)) return;
  try {
    const status = await ensureDesktopAndTunnel(path, env);
    if (status.stage === 'failed' || status.error || status.hostBinding && status.hostBinding.state !== 'verified')
      process.stderr.write(`${JSON.stringify({ chatTunnel: status })}\n`);
    return status;
  } catch {
    process.stderr.write(`${JSON.stringify({ chatTunnel: { error: 'tunnel_configuration_failed', config: path,
      hint: 'Run Core CLI chat status for the local configuration error. Other Core operations remain available.' } })}\n`);
  }
}

async function supervise(path) {
  const config = loadTunnelConfig(path);
  mkdirSync(config.stateDir, { recursive: true });
  const lock = join(config.stateDir, 'supervisor.lock');
  const recovery = join(config.stateDir, 'recovery.lock');
  const sessionId = randomUUID();
  try {
    // Serialize stale-lock recovery so a competing starter cannot unlink our new live lock.
    try { const fd = openSync(recovery, 'wx', 0o600); closeSync(fd); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    try {
    writeFileSync(recovery, JSON.stringify({ pid: process.pid, sessionId }), { mode: 0o600 });
    try { const fd = openSync(lock, 'wx', 0o600); closeSync(fd); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = json(lock); } catch { return; }
      if (alive(owner.pid)) return;
      unlinkSync(lock);
      const fd = openSync(lock, 'wx', 0o600); closeSync(fd);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, sessionId }), { mode: 0o600 });
    } finally { unlinkSync(recovery); }
  } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  let stopping = false, child;
  const state = { sessionId, supervisorPid: process.pid, startedAt: new Date().toISOString(), stage: 'starting', attempts: 0 };
  const update = values => { Object.assign(state, values, { updatedAt: new Date().toISOString() }); save(statePath(config), state); };
  const control = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/session') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ sessionId, supervisorPid: process.pid, stopping }));
  });
  const stop = () => { stopping = true; child?.kill(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  const monitor = setInterval(async () => {
    try { if (json(stopPath(config)).sessionId === sessionId) stop(); } catch {}
    if (!child || stopping) return;
    const observedChild = child;
    const checked = await health(config);
    if (!stopping && child === observedChild)
      update({ stage: checked.ready ? 'ready' : 'starting', ...(checked.ready ? { lastHealthyAt: new Date().toISOString(), error: null } : {}) });
  }, 1000);
  try {
    await new Promise((done, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', done); });
    state.controlUrl = `http://127.0.0.1:${control.address().port}`;
    update({});
    const { startTunnel } = await import(pathToFileURL(config.launcher).href);
    for (let attempt = 0; attempt < 4 && !stopping; attempt++) {
      update({ attempts: attempt + 1, stage: 'starting', clientPid: null });
      try {
        const out = openSync(join(config.stateDir, 'tunnel.stdout.log'), 'a', 0o600);
        const err = openSync(join(config.stateDir, 'tunnel.stderr.log'), 'a', 0o600);
        try {
          child = startTunnel(config.client, config.profile, config.readPolicy, {
            env: { CODEX_CHAT_READ_SESSION: sessionId, CODEX_CHAT_TUNNEL_CONFIG: path }, stdio: ['ignore', out, err]
          });
        } finally { closeSync(out); closeSync(err); }
        update({ clientPid: child.pid ?? null });
        const result = await new Promise(done => {
          child.once('error', error => done({ code: null, signal: null, startupFailed: true, cause: startupCause(error) }));
          child.once('exit', (code, signal) => done({ code, signal }));
        });
        child = undefined;
        update({ clientPid: null, stage: stopping ? 'stopped' : 'recovering',
          error: stopping ? null : { code: result.startupFailed ? 'tunnel_spawn_failed' : 'tunnel_exited',
            phase: 'tunnel_process', message: 'Tunnel stopped; inspect the local logs and health diagnostics.', exitCode: result.code, signal: result.signal,
            ...(result.cause ? { cause: result.cause } : {}) } });
      } catch (error) {
        child = undefined;
        update({ stage: 'recovering', error: { code: 'tunnel_start_failed', phase: 'startup', cause: startupCause(error),
          message: 'Tunnel could not start. Check local paths, runtime key presence and proxy connectivity; no message was replayed.' } });
      }
      if (!stopping && attempt < 3) await pause(1000 * 2 ** attempt);
    }
    update({ stage: stopping ? 'stopped' : 'failed', clientPid: null });
  } catch (error) {
    update({ stage: 'failed', error: { code: 'supervisor_failed', phase: 'supervisor', cause: startupCause(error), message: 'Inspect supervisor.stderr.log and the local configuration.' } });
  } finally {
    clearInterval(monitor); child?.kill();
    await new Promise(done => control.close(done));
    try { if (json(lock).sessionId === sessionId) unlinkSync(lock); } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--supervise') await supervise(process.argv[3]);
    else process.stdout.write(`${JSON.stringify(await chatTunnelCommand(process.argv[2], process.argv[3]))}\n`);
  } catch (error) { process.stderr.write(`Chat Tunnel control failed: ${error.message}\n`); process.exitCode = 1; }
}
