import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modules = fileURLToPath(new URL('..', import.meta.url));
const registryUrl = pathToFileURL(join(modules, 'agent-core/src/registry.mjs')).href;

for (const moduleId of ['agent-mail', 'agent-qoder']) test(`${moduleId} standalone copy discovers and observes without a sibling Core`, t => {
  const root = mkdtempSync(join(tmpdir(), `${moduleId}-standalone-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copy = join(root, moduleId), queue = join(root, 'queue.sqlite');
  cpSync(join(modules, moduleId), copy, { recursive: true });
  assert.equal(existsSync(join(root, 'agent-core')), false);
  assert.deepEqual(readFileSync(join(copy, 'runtime/core-contracts.mjs')),
    readFileSync(join(modules, 'agent-core/src/contracts.mjs')), 'packaged contracts come from the single Core source');
  const env = { ...process.env, USERPROFILE: root, AGENT_MAIL_DB_PATH: queue,
    QODER_CONTROL_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111', QODER_CONTROL_ROOT: root,
    QODER_DELIVERY_DIR: join(root, 'delivery') };
  delete env.QODER_DESKTOP_CDP_PORT;
  const script = `import assert from 'node:assert/strict';
    import { ModuleRegistry } from ${JSON.stringify(registryUrl)};
    const core = new ModuleRegistry({ registryPath: ${JSON.stringify(join(root, 'registry.json'))} });
    core.install(${JSON.stringify(copy)});
    const description = await core.agentDiscover({ moduleId: ${JSON.stringify(moduleId)} });
    assert.equal(description.operations.find(operation => operation.name === 'message_observe').annotations.readOnlyHint, true);
    const result = await core.agentRead({ moduleId: ${JSON.stringify(moduleId)}, operation: 'message_observe', args: { view: 'stats' } });
    assert.equal(result.moduleId, ${JSON.stringify(moduleId)}); assert.equal(result.stats.total, 0);
    console.log('standalone discovery and observation passed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env,
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /standalone discovery and observation passed/);
  assert.deepEqual(readdirSync(root).sort(), [moduleId, 'registry.json'].sort(), 'observation creates no queue, delivery directory or helper files');
});
