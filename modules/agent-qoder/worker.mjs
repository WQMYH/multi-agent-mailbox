import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimWorker, releaseWorker, renewWorker, runQueueCycle } from './desktop.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runProviderWorker(config, context, { wait = sleep, now = Date.now } = {}) {
  const token = randomUUID();
  context.assertCurrent?.();
  if (!claimWorker(config, context, token, now())) return { status: 'already_running' };
  const activeContext = { ...context, assertLease: () => {
    if (!renewWorker(config, token, now(), context)) throw Object.assign(Error('Qoder provider worker lease lost'), { code: 'QODER_WORKER_SUPERSEDED' });
  } };
  try {
    while (true) {
      activeContext.assertCurrent?.(); activeContext.assertLease();
      const cycle = await runQueueCycle(config, activeContext);
      if (cycle.activeSessions === 0) return { status: 'idle', progressed: cycle.progressed };
      await wait(1000);
    }
  } finally { releaseWorker(config, token, context); }
}

export function startProviderWorker(config, context, spawnProcess = spawn) {
  context.assertCurrent?.();
  if (!context.registrationKey) throw Error('Qoder recovery requires an agent-core registration context');
  const child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url),
    Buffer.from(JSON.stringify(config)).toString('base64url'),
    Buffer.from(context.registrationKey).toString('base64url')], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return { status: 'started', pid: child.pid };
}

function workerContext(registrationKey) {
  const [registryPath, registrationId, revision] = JSON.parse(registrationKey);
  const state = () => JSON.parse(readFileSync(registryPath, 'utf8'));
  const assertCurrent = () => {
    const record = state().modules?.['agent-qoder'];
    if (!record || !record.enabled || record.registrationId !== registrationId || record.revision !== revision)
      throw Error('Module registration changed or disabled');
  };
  return {
    registrationKey,
    assertCurrent,
    messageBudget: {
      status: () => state().messageBudget ?? null,
      check: ({ ownerId, usedBytes, additionalBytes = 0 }) => {
        const budget = state().messageBudget;
        if (!budget) return { ok: false, reason: 'budget_not_configured', deltaBytes: additionalBytes };
        const allocations = budget.allocations;
        const adaptive = budget.defaultOwnerBytes !== undefined;
        const validMode = adaptive
          ? Number.isSafeInteger(budget.defaultOwnerBytes) && budget.defaultOwnerBytes > 0 &&
            Number.isSafeInteger(budget.totalBytes) && budget.totalBytes > 0 &&
            (budget.globalLimitBytes === undefined || Number.isSafeInteger(budget.globalLimitBytes) &&
              budget.globalLimitBytes >= budget.totalBytes)
          : [20_000_000, 200_000_000].includes(budget.totalBytes) && budget.globalLimitBytes === undefined;
        if (budget.schemaVersion !== 1 || !validMode || !Array.isArray(allocations) ||
            allocations.length === 0 || new Set(allocations.map(item => item?.ownerId)).size !== allocations.length ||
            allocations.some(item => typeof item?.ownerId !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes < 1) ||
            allocations.reduce((sum, item) => sum + item.bytes, 0) !== budget.totalBytes)
          return { ok: false, reason: 'budget_contract_conflict', deltaBytes: additionalBytes };
        const allocation = allocations.find(item => item.ownerId === ownerId);
        if (!allocation) return { ok: false, ownerId, reason: 'owner_unallocated', deltaBytes: Math.max(1, additionalBytes) };
        const projectedBytes = usedBytes + additionalBytes;
        if (!Number.isSafeInteger(projectedBytes))
          return { ok: false, ownerId, reason: 'budget_contract_conflict', deltaBytes: additionalBytes };
        return { ok: projectedBytes <= allocation.bytes, ownerId, allocatedBytes: allocation.bytes,
          usedBytes, additionalBytes, projectedBytes, remainingBytes: Math.max(0, allocation.bytes - projectedBytes),
          deltaBytes: Math.max(0, projectedBytes - allocation.bytes),
          ...(projectedBytes <= allocation.bytes ? {} : { reason: 'owner_budget_exceeded' }) };
      }
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString());
    const registrationKey = Buffer.from(process.argv[3], 'base64url').toString();
    await runProviderWorker(config, workerContext(registrationKey));
  } catch { process.exitCode = 1; }
}
