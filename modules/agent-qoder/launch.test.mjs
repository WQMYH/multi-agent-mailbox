import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRunningQoder, directLaunchConfig } from './launch.mjs';

function asar(path, pkg) {
  const body = Buffer.from(JSON.stringify(pkg)), header = Buffer.from(JSON.stringify({ files: {
    'package.json': { size: body.length, offset: '0' }
  } }));
  const size = 8 + header.length, out = Buffer.alloc(8 + size + body.length);
  out.writeUInt32LE(size, 4); out.writeUInt32LE(header.length, 12); header.copy(out, 16); body.copy(out, 8 + size);
  writeFileSync(path, out);
}

test('standalone launch requests direct networking without mutating the parent or disabling TLS', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-launch-test-'));
  try {
    const executable = join(root, 'Qoder CN.exe');
    mkdirSync(join(root, 'resources'));
    writeFileSync(executable, 'fixture, never executed');
    writeFileSync(join(root, 'resources/product.json'), JSON.stringify({ productId: 'qoder-cn', appId: 'com.qodercn.app' }));
    asar(join(root, 'resources/app.asar'), { name: 'qoder-cn', version: '0.3.4' });
    const parent = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:2',
      All_Proxy: 'socks5://127.0.0.1:3', NO_PROXY: 'localhost', no_proxy: 'localhost',
      NPM_CONFIG_PROXY: 'http://127.0.0.1:4', GLOBAL_AGENT_HTTP_PROXY: 'http://127.0.0.1:5',
      NODE_USE_ENV_PROXY: '1', QODER_LAUNCH_SENTINEL: 'preserved' };
    const before = { ...parent };
    const config = directLaunchConfig(executable, parent);
    assert.deepEqual(parent, before);
    assert.deepEqual(config.args, ['--no-proxy-server']);
    assert.deepEqual(directLaunchConfig(executable, parent, 19327).args,
      ['--no-proxy-server', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19327']);
    for (const invalid of [0, 80, 65536, '19327', NaN])
      assert.throws(() => directLaunchConfig(executable, parent, invalid), /Invalid loopback/);
    assert.equal(config.options.shell, false);
    assert.equal(config.options.windowsHide, true);
    assert.equal(config.options.env.QODER_LAUNCH_SENTINEL, 'preserved');
    for (const key of ['HTTP_PROXY', 'https_proxy', 'All_Proxy', 'NPM_CONFIG_PROXY', 'GLOBAL_AGENT_HTTP_PROXY'])
      assert.equal(config.options.env[key], undefined);
    assert.equal(config.options.env.NO_PROXY, '*');
    assert.equal(config.options.env.no_proxy, '*');
    assert.equal(config.options.env.NODE_USE_ENV_PROXY, '0');
    assert.equal(config.options.env.NODE_TLS_REJECT_UNAUTHORIZED, parent.NODE_TLS_REJECT_UNAUTHORIZED);
    assert.equal(config.options.env.NODE_EXTRA_CA_CERTS, parent.NODE_EXTRA_CA_CERTS);
    const readChild = 'console.log(JSON.stringify({proxy:process.env.HTTP_PROXY,noProxy:process.env.NO_PROXY,nodeProxy:process.env.NODE_USE_ENV_PROXY,sentinel:process.env.QODER_LAUNCH_SENTINEL}))';
    const grandchild = `process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(readChild)}]))`;
    const inherited = JSON.parse(execFileSync(process.execPath, ['-e', grandchild], {
      env: config.options.env, encoding: 'utf8', windowsHide: true, timeout: 10000
    }));
    assert.deepEqual(inherited, { noProxy: '*', nodeProxy: '0', sentinel: 'preserved' });
    assert.throws(() => directLaunchConfig('Qoder CN.exe', parent), /absolute/);
    assert.deepEqual(classifyRunningQoder([{ pid: 7, executable, commandLine: `"${executable}"` }], executable, 19327).connection,
      { status: 'unavailable', debugPort: 19327, reason: 'controlled-restart-required-for-loopback-cdp' });
    const notRequested=classifyRunningQoder([{ pid: 7, executable, commandLine: `"${executable}"` }], executable);
    assert.deepEqual(notRequested.connection,{status:'not-requested'});assert.equal(notRequested.action,'leave-running');
    const attached=classifyRunningQoder([{ pid: 7, executable,
      commandLine: `"${executable}" --no-proxy-server --remote-debugging-address=127.0.0.1 --remote-debugging-port=19327` }], executable, 19327);
    assert.equal(attached.connection.status, 'configured');assert.equal(attached.proxyPolicy, 'process-direct-flag');
    assert.equal(classifyRunningQoder([{ pid: 7, executable: join(root, 'other', 'Qoder CN.exe'), commandLine: '' }], executable, 19327).state, 'launch-blocked');
    asar(join(root, 'resources/app.asar'), { name: 'qoder-cn', version: '0.4.2' });
    assert.equal(directLaunchConfig(executable, parent).identity.version, '0.4.2');
    for (const version of ['0.4.3', '0.1.8', '9.9.9-canary.1', 'diagnostic only', undefined]) {
      asar(join(root, 'resources/app.asar'), { name: 'qoder-cn', version });
      assert.equal(directLaunchConfig(executable, parent).identity.version, version ?? null);
    }
    asar(join(root, 'resources/app.asar'), { name: 'qoder-cn-ide', version: '0.4.3' });
    assert.throws(() => directLaunchConfig(executable, parent), /standalone package/);
    asar(join(root, 'resources/app.asar'), { name: 'qoder-cn', version: '0.3.4' });
    writeFileSync(join(root, 'resources/product.json'), JSON.stringify({ productId: 'qoder-cn-ide', appId: 'com.qodercn.ide' }));
    assert.throws(() => directLaunchConfig(executable, parent), /standalone product/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
