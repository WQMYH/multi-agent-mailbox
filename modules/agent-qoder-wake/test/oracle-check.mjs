// Deliberately break only a disposable copy; production and real product state are untouched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const copy = mkdtempSync(join(tmpdir(), 'wake-negative-oracle-'));
try {
  mkdirSync(join(copy, 'test'));
  const adapter = readFileSync(join(source, 'adapter.mjs'), 'utf8');
  const guard = "if ((await approvals(config, args, context)).length) fail('WAKE_APPROVAL_PENDING');";
  assert.ok(adapter.includes(guard));
  writeFileSync(join(copy, 'adapter.mjs'), adapter.replace(guard, '// Known bad: silently dispatch while native approval is pending.'));
  for (const name of ['agent-module.json', 'test/fixture-cli.mjs']) writeFileSync(join(copy, name), readFileSync(join(source, name)));
  let tests = readFileSync(join(source, 'adapter.test.mjs'), 'utf8');
  for (const name of ['contracts', 'registry']) tests = tests.replace(`'../agent-core/src/${name}.mjs'`,
    `'${new URL(`../../agent-core/src/${name}.mjs`, import.meta.url).href}'`);
  writeFileSync(join(copy, 'adapter.test.mjs'), tests);
  let failed = false;
  try { execFileSync(process.execPath, ['--test', join(copy, 'adapter.test.mjs')], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    assert.match(error.stdout, /Missing expected rejection/);
    assert.match(error.stdout, /pending approval/);
    failed = true;
  }
  assert.equal(failed, true, 'the regression suite must reject a missing native approval gate');
  process.stdout.write('Offline negative oracle: removing the approval gate fails the regression suite.\n');
} finally { rmSync(copy, { recursive: true, force: true }); }
