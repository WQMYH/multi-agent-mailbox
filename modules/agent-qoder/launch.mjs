import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function standaloneIdentity(executable) {
  if (typeof executable !== 'string' || !isAbsolute(executable) ||
      basename(executable).toLowerCase() !== 'qoder cn.exe' || !statSync(executable).isFile())
    throw Error('An absolute Qoder CN standalone executable is required');
  const resources = join(dirname(executable), 'resources');
  const product = JSON.parse(readFileSync(join(resources, 'product.json'), 'utf8'));
  if (product.productId !== 'qoder-cn' || product.appId !== 'com.qodercn.app')
    throw Error('Not the verified Qoder CN standalone product');
  const archive = readFileSync(join(resources, 'app.asar'));
  if (archive.length < 16) throw Error('Cannot verify Qoder CN package identity');
  const headerSize = archive.readUInt32LE(4), jsonSize = archive.readUInt32LE(12);
  if (headerSize < 8 || jsonSize < 2 || jsonSize > headerSize - 8 || 16 + jsonSize > archive.length)
    throw Error('Cannot verify Qoder CN package identity');
  const header = JSON.parse(archive.toString('utf8', 16, 16 + jsonSize));
  const entry = header.files?.['package.json'];
  if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size < 2 || !/^\d+$/.test(entry.offset))
    throw Error('Cannot verify Qoder CN package identity');
  const start = 8 + headerSize + Number(entry.offset);
  if (!Number.isSafeInteger(start) || start + entry.size > archive.length)
    throw Error('Cannot verify Qoder CN package identity');
  const pkg = JSON.parse(archive.toString('utf8', start, start + entry.size));
  if (pkg.name !== 'qoder-cn') throw Error('Not the verified Qoder CN standalone package');
  return { productId: product.productId, appId: product.appId,
    version: typeof pkg.version === 'string' ? pkg.version.slice(0, 128) : null };
}

// Process-local policy only: this cannot override TUN/WFP/transparent routing.
export function directLaunchConfig(executable, parentEnv = process.env, debugPort) {
  if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535))
    throw Error('Invalid loopback debugging port');
  const identity = standaloneIdentity(executable);
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:(?:https?|all|ftp|socks|no)_proxy|npm_config_(?:proxy|https?_proxy|noproxy)|global_agent_(?:https?_proxy|no_proxy)|node_use_env_proxy)$/i.test(key))
      delete env[key];
  }
  Object.assign(env, { NO_PROXY: '*', no_proxy: '*', NODE_USE_ENV_PROXY: '0',
    GLOBAL_AGENT_NO_PROXY: '*', npm_config_noproxy: '*' });
  return { executable, identity, args: ['--no-proxy-server', ...(debugPort === undefined ? [] :
    ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`])], options: {
    cwd: dirname(executable), env, shell: false, windowsHide: true, detached: true, stdio: 'ignore'
  } };
}

function runningProcesses() {
  const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter \"Name='Qoder CN.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine); $ids=@($p.ProcessId); $roots=@($p | Where-Object { $ids -notcontains $_.ParentProcessId }); ConvertTo-Json -Compress -InputObject $roots`;
  const raw = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
    pid: Number(item.ProcessId), executable: item.ExecutablePath, commandLine: item.CommandLine
  }));
}

export function classifyRunningQoder(processes, executable, debugPort) {
  if (!processes.length) return null;
  const expected = normalize(resolve(executable)).toLowerCase();
  if (processes.length !== 1 || typeof processes[0].executable !== 'string' ||
      normalize(resolve(processes[0].executable)).toLowerCase() !== expected)
    return { target: 'qoder-cn', state: 'launch-blocked', reason: 'another-or-unverified-standalone-instance',
      processes: processes.map(({ pid, executable: path }) => ({ pid, executable: path ?? null })) };
  const process = processes[0], command = process.commandLine ?? '';
  const port = /(?:^|\s)--remote-debugging-port=(\d+)(?=\s|$)/i.exec(command)?.[1];
  const loopback = /(?:^|\s)--remote-debugging-address=127\.0\.0\.1(?=\s|$)/i.test(command);
  const processDirect = /(?:^|\s)--no-proxy-server(?=\s|$)/i.test(command);
  const controlRequested = debugPort !== undefined, connected = controlRequested && loopback && port === String(debugPort);
  return { target: 'qoder-cn', pid: process.pid, state: 'already-running', reused: false,
    proxyPolicy: processDirect ? 'process-direct-flag' : 'not-process-direct',
    connection: !controlRequested ? { status: 'not-requested' } : connected ? { status: 'configured', debugPort } : {
      status: 'unavailable', debugPort, reason: 'controlled-restart-required-for-loopback-cdp'
    }, action: !controlRequested ? 'leave-running' : connected ? 'use-existing-loopback-endpoint' : 'leave-running-and-defer-control' };
}

export async function launchQoder(executable, { debugPort } = {}) {
  if (process.platform !== 'win32') throw Error('This launcher currently supports Windows Qoder CN only');
  const config = directLaunchConfig(executable, process.env, debugPort);
  const running = classifyRunningQoder(runningProcesses(), executable, debugPort);
  if (running) return { ...running, identity: config.identity, proxyPolicyChanged: false };
  // ponytail: preflight is not an atomic singleton lock; spawned != active or direct-traffic verified.
  const child = spawn(config.executable, config.args, config.options);
  await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
  child.unref();
  return { target: 'qoder-cn', pid: child.pid, state: 'spawned', identity: config.identity,
    connection: debugPort === undefined ? { status: 'not-requested' } : { status: 'requested', debugPort },
    proxyPolicy: 'process-direct', trafficVerified: false, transparentProxyBypass: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node launch.mjs <absolute Qoder CN.exe path>');
    console.log(JSON.stringify(await launchQoder(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
