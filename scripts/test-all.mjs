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
if (failures.length) process.exit(1);
const directories = ['scripts', 'modules/agent-core/test', 'modules/agent-mail', 'modules/agent-qoder',
  'modules/agent-qoder-ide', 'modules/agent-zcode', 'qoder-ide-bridge/test'];
const tests = directories.flatMap(dir => readdirSync(join(root, dir))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `${dir}/${name}`));
// Sequential processes keep each existing test's temporary environment overrides isolated.
for (const file of tests) run(file);
run('scripts/smoke.mjs');
for (const file of ['self-test', 'attribution-test', 'message-test', 'native-turn-test'])
  run(`qoder-codex-bridge/scripts/${file}.mjs`);
run('zcode-codex-bridge/plugin/scripts/self-test.mjs');
console.log(`\n${tests.length + 6} public offline checks; failed: ${failures.length}.`);
if (failures.length) console.error(failures.join('\n'));
process.exitCode = failures.length ? 1 : 0;
