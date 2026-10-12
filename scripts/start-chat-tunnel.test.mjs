import assert from 'node:assert/strict';
import { proxyCandidates, selectRoute, probeRoute, tunnelEnvironment, tunnelArguments } from './start-chat-tunnel.mjs';

const env = { HTTPS_PROXY: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897',
  OPENAI_API_KEY: 'test-secret', CODEX_CHAT_READ_CONFIG: 'approved-scope.json', NODE_USE_ENV_PROXY: '1' };
const settings = { proxyEnabled: true, proxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7890' };
assert.deepEqual(proxyCandidates(env, settings), ['http://127.0.0.1:7897', 'http://127.0.0.1:7890']);
const attempts = [];
const route = selectRoute(env, settings, proxy => { attempts.push(proxy); return proxy === 'http://127.0.0.1:7890'; });
assert.equal(route, 'http://127.0.0.1:7890');
assert.deepEqual(attempts, ['http://127.0.0.1:7897', 'http://127.0.0.1:7890']);
assert.equal(selectRoute(env, settings, proxy => proxy === null), null);
assert.throws(() => selectRoute(env, settings, () => false), /not started/);
assert.deepEqual(proxyCandidates({ HTTPS_PROXY: 'http://user:password@localhost:7890' }, {}), []);
assert.deepEqual(proxyCandidates({}, { proxyEnabled: false, proxyServer: '127.0.0.1:7890' }), []);

const childEnv = tunnelEnvironment(env, route);
assert.equal(childEnv.HTTPS_PROXY, route);
assert.equal(childEnv.HTTP_PROXY, route);
assert.equal(childEnv.https_proxy, undefined);
assert.equal(childEnv.NODE_USE_ENV_PROXY, undefined);
assert.equal(childEnv.OPENAI_API_KEY, 'test-secret');
assert.equal(childEnv.CONTROL_PLANE_API_KEY, 'test-secret');
assert.equal(tunnelEnvironment({ ...env, CONTROL_PLANE_API_KEY: 'separate-tunnel-key' }, route).CONTROL_PLANE_API_KEY,
  'separate-tunnel-key');
assert.equal(childEnv.CODEX_CHAT_READ_CONFIG, 'approved-scope.json');
assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
assert.equal(tunnelEnvironment(env, null).HTTPS_PROXY, undefined);
assert.equal(tunnelEnvironment(env, null).NO_PROXY, 'localhost,127.0.0.1,::1');
assert.deepEqual(tunnelArguments('agent-core-chat', null), ['run', '--profile', 'agent-core-chat']);
assert.deepEqual(tunnelArguments('agent-core-chat', route),
  ['run', '--profile', 'agent-core-chat', '--control-plane.http-proxy', route]);
assert.equal(tunnelArguments(new URL('./start-chat-tunnel.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0), null)[1],
  '--profile-file');

assert.equal(probeRoute(route, (_exe, args) => {
  assert.equal(args[args.indexOf('--proxy') + 1], route);
  assert.equal(args.includes('test-secret'), false);
  assert.equal(args.includes('--header'), false);
  return { status: 0, stdout: '401' };
}), true);
assert.equal(probeRoute(null, (_exe, args) => {
  assert.equal(args[args.indexOf('--proxy') + 1], '');
  assert.equal(args[args.indexOf('--noproxy') + 1], '*');
  return { status: 0, stdout: '401' };
}), true);
assert.equal(probeRoute(route, () => ({ status: 7, stdout: '401' })), false);
assert.equal(probeRoute(route, () => ({ status: 0, stdout: '403' })), false);
console.log('Tunnel startup: stale proxy replacement, direct fallback, failure stop and secret isolation PASS');
