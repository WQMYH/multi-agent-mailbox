import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function run(file) {
  console.log(`\n[test] ${file}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 180_000
  });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? `Test exited ${result.status}`);
    failures.push(file);
  }
}
run('modules/agent-zcode/build.mjs');
run('modules/agent-qoder-ide/build.mjs');
run('modules/agent-mail/build.mjs');
run('modules/agent-qoder/build.mjs');
if (failures.length) process.exit(1);
const directories = ['scripts', 'modules/agent-core/test', 'modules/agent-mail', 'modules/agent-qoder',
  'modules/agent-qoder-ide', 'modules/agent-qoder-wake', 'modules/agent-zcode', 'qoder-ide-bridge/test',
  'qoder-codex-bridge/scripts', 'zcode-codex-bridge/plugin/scripts'];
const tests = directories.flatMap(dir => readdirSync(join(root, dir))
  .filter(name => name.endsWith('.test.mjs') || name.endsWith('-test.mjs')).sort().map(name => `${dir}/${name}`));
// Sequential processes keep each existing test's temporary environment overrides isolated.
for (const file of tests) run(file);
run('scripts/smoke.mjs');
console.log(`\n${tests.length + 5} public offline checks; failed: ${failures.length}.`);
if (failures.length) console.error(failures.join('\n'));
process.exitCode = failures.length ? 1 : 0;
