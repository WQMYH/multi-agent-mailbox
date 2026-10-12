import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, 'runtime'), { recursive: true });
await cp(join(root, '../agent-core/src/contracts.mjs'), join(root, 'runtime/core-contracts.mjs'));
for (const name of ['store-budget.mjs', 'event-recorder.mjs'])
  await cp(join(root, '../../qoder-codex-bridge/scripts', name), join(root, 'runtime', name));
console.log('built agent-qoder runtime (shared Core contracts and return record readers)');
