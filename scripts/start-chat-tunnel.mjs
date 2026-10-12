import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const proxyVariable = /^(?:(?:https?|all|ftp|socks|no)_proxy|npm_config_(?:proxy|https?_proxy|noproxy)|global_agent_(?:https?_proxy|no_proxy)|node_use_env_proxy)$/i;

export function proxyCandidates(env, settings = {}) {
  const values = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .map(name => env[name]);
  if (settings.proxyEnabled && settings.proxyServer) {
    const entries = settings.proxyServer.split(';').map(value => value.trim());
    for (const protocol of ['https', 'http'])
      for (const entry of entries) {
        const match = entry.match(new RegExp(`^${protocol}=(.+)$`, 'i'));
        if (match) values.push(match[1]);
      }
    values.push(...entries.filter(value => !value.includes('=')));
  }
  return [...new Set(values.flatMap(value => {
    if (!value) return [];
    try {
      const url = new URL(value.includes('://') ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.search || url.hash || url.pathname !== '/') return [];
      return [url.origin];
    } catch { return []; }
  }))];
}

export function probeRoute(proxy, run = spawnSync) {
  // No API key or model call: a verified HTTPS 401 proves the API was reached.
  const result = run('curl.exe', ['--disable', '--silent', '--show-error', '--connect-timeout', '3',
    '--max-time', '6', '--proxy', proxy ?? '', '--noproxy', proxy ? '' : '*',
    '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}',
    'https://api.openai.com/v1/models'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  return !result.error && result.status === 0 && result.stdout.trim() === '401';
}

export function selectRoute(env, settings, probe = probeRoute) {
  for (const proxy of proxyCandidates(env, settings)) if (probe(proxy)) return proxy;
  if (probe(null)) return null;
  throw Error('No working proxy or direct OpenAI connection; Tunnel was not started');
}

export function tunnelEnvironment(env, proxy) {
  const childEnv = { ...env };
  if (!childEnv.CONTROL_PLANE_API_KEY && childEnv.OPENAI_API_KEY)
    childEnv.CONTROL_PLANE_API_KEY = childEnv.OPENAI_API_KEY;
  for (const name of Object.keys(childEnv)) if (proxyVariable.test(name)) delete childEnv[name];
  Object.assign(childEnv, { NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' });
  if (proxy) Object.assign(childEnv, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy });
  return childEnv;
}

export function tunnelArguments(profile, proxy) {
  const profileFile = existsSync(profile);
  return ['run', profileFile ? '--profile-file' : '--profile', profileFile ? resolve(profile) : profile,
    ...(proxy ? ['--control-plane.http-proxy', proxy] : [])];
}

function windowsSettings() {
  if (process.platform !== 'win32') return {};
  // Capture secrets in memory only; never put them in arguments, diagnostics or receipts.
  const command = "$s=Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings';" +
    "[pscustomobject]@{proxyEnabled=($s.ProxyEnable -eq 1);proxyServer=$s.ProxyServer;" +
    "HTTPS_PROXY=[Environment]::GetEnvironmentVariable('HTTPS_PROXY','User');" +
    "HTTP_PROXY=[Environment]::GetEnvironmentVariable('HTTP_PROXY','User');" +
    "ALL_PROXY=[Environment]::GetEnvironmentVariable('ALL_PROXY','User');" +
    "apiKey=[Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')}|ConvertTo-Json -Compress";
  try { return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })); }
  catch { throw Error('Could not read local Tunnel startup settings'); }
}

export function startTunnel(client, profile, readConfig, options = {}) {
  const profileFile = profile && existsSync(profile);
  if (!client || !existsSync(client) || !profileFile && !/^[\w.-]+$/.test(profile ?? '') || readConfig && !existsSync(readConfig))
    throw Error('Usage: node scripts/start-chat-tunnel.mjs <tunnel-client.exe> <profile-name-or-file> [approved-read-config]');
  const settings = windowsSettings();
  const env = { ...process.env, ...options.env };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'])
    if (!env[name] && settings[name]) env[name] = settings[name];
  if (!env.CONTROL_PLANE_API_KEY && !env.OPENAI_API_KEY && settings.apiKey) env.OPENAI_API_KEY = settings.apiKey;
  if (!env.CONTROL_PLANE_API_KEY && !env.OPENAI_API_KEY) throw Error('Tunnel runtime API key is not configured');
  if (readConfig) env.CODEX_CHAT_READ_CONFIG = resolve(readConfig);
  const proxy = selectRoute(env, settings);
  console.error(JSON.stringify({ tunnelStartup: 'route_verified', route: proxy ?? 'direct' }));
  return spawn(resolve(client), tunnelArguments(profile, proxy), {
    env: tunnelEnvironment(env, proxy), stdio: options.stdio ?? 'inherit', windowsHide: true
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length < 4 || process.argv.length > 5) throw Error('Expected client path, profile and optional approved read config');
    const child = startTunnel(...process.argv.slice(2));
    child.on('error', () => { console.error('Tunnel process could not start'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
