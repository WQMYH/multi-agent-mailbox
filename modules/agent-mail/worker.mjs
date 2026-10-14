import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkMessageBudget } from './runtime/core-contracts.mjs';
import { claimMailWorker, releaseMailWorker, finishMailWorkerIfIdle, pendingNotifications,
  dispatchPendingNotifications, queuePath } from './adapter.mjs';
import { readReceiverConfig } from './receivers.mjs';

export function workerContext(registrationKey) {
  const [registryPath, registrationId, revision] = JSON.parse(registrationKey);
  const state = () => JSON.parse(readFileSync(registryPath, 'utf8'));
  return { registrationKey, mailDispatcher: true,
    assertCurrent: () => {
      const record = state().modules?.['agent-mail'];
      if (record?.enabled !== true || record.registrationId !== registrationId || record.revision !== revision)
        throw Error('Agent Mail registration changed or disabled');
    },
    messageBudget: { status: () => state().messageBudget ?? null,
      check: input => checkMessageBudget(state().messageBudget, input) }
  };
}

function waitForChange(path) {
  const signature = () => JSON.stringify(pendingNotifications(path).map(row => [row.delivery_id, row.receiver_id]));
  const before = signature(), queueDirectory = dirname(path);
  const configPath = process.env.AGENT_MAIL_RECEIVERS_PATH ?? join(homedir(), '.codex-agent-core', 'agent-mail-receivers.json');
  const directories = new Set([queueDirectory, dirname(configPath)]);
  try {
    for (const config of readReceiverConfig()) {
      directories.add(config.home);
      directories.add(join(config.home, config.transport === 'claude-peer' ? 'sessions' : 'server/instances'));
      if (config.hostConfigPath) directories.add(dirname(config.hostConfigPath));
    }
  } catch { /* A later trusted config edit can restore an unavailable receiver. */ }
  return new Promise(resolveWait => {
    const watchers = [];
    const done = () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); resolveWait(); };
    const timer = setTimeout(done, 10000);
    for (const directory of directories) {
      if (!existsSync(directory)) continue;
      try {
        const watcher = watch(directory, () => {
          try { if (directory !== queueDirectory || signature() !== before) done(); }
          catch { done(); }
        });
        watcher.on('error', done); watchers.push(watcher);
      } catch { /* The bounded timer covers missing directories and lost filesystem events. */ }
    }
  });
}

export async function runMailWorker(context, { path = queuePath(), wait = waitForChange, now = Date.now } = {}) {
  const token = randomUUID();
  context.assertCurrent?.();
  if (!claimMailWorker(context, token, now(), path)) return { status: 'already_running' };
  try {
    while (true) {
      context.assertCurrent?.();
      if (!claimMailWorker(context, token, now(), path)) throw Error('Agent Mail dispatcher lease was superseded');
      const cycle = await dispatchPendingNotifications({ ...context, mailDispatcher: true }, path);
      if (!cycle.pending && finishMailWorkerIfIdle(context, token, path)) return { status: 'idle' };
      await wait(path);
    }
  } finally { releaseMailWorker(context, token, path); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runMailWorker(workerContext(Buffer.from(process.argv[2], 'base64url').toString())); }
  catch { process.exitCode = 1; }
}
