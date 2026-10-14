import { validateArguments, validateModuleId, validateOperation } from './registry.mjs';
import { messageObserveInputSchema, validateMessageObserveArgs, validateMessageObservation } from './contracts.mjs';

export const MAILBOARD_URI = 'ui://agent-core/mailboard-v1.html';
export const mailboardInputSchema = {
  type: 'object', additionalProperties: false,
  properties: { moduleId: { type: 'string' }, operation: { type: 'string' }, ...messageObserveInputSchema.properties }
};

// A projection over owner records, not another queue or log. All calls below are reads.
export async function readMailboard(core, input = {}) {
  validateArguments(input);
  const { moduleId, operation: selectedOperation, ...provided } = input;
  if (moduleId !== undefined) validateModuleId(moduleId);
  if (selectedOperation !== undefined) {
    validateOperation(selectedOperation);
    if (!moduleId) throw Error('A selected module is required for an observation operation');
  }
  const args = validateMessageObserveArgs({ view: 'items', ...provided });
  if ((args.cursor || args.view === 'detail') && !moduleId)
    throw Error('A selected module is required for pagination or detail');
  const all = (await core.agentDiscover()).modules;
  if (moduleId && !all.some(module => module.id === moduleId)) throw Error('Unknown moduleId');
  const selected = moduleId ? all.filter(module => module.id === moduleId) : all;
  const modules = [];
  for (const module of selected) {
    const row = { moduleId: module.id, operation: selectedOperation ?? 'message_observe', name: module.name, status: 'disabled' };
    if (module.enabled !== true) { modules.push(row); continue; }
    let operations;
    try {
      const description = await core.agentDiscover({ moduleId: module.id });
      operations = description.operations.filter(op => op.annotations?.readOnlyHint === true &&
        (op.name === 'message_observe' || op.annotations.messageObservationHint === true));
    } catch {
      modules.push({ ...row, status: 'unavailable', reason: 'owner_read_unavailable' }); continue;
    }
    if (selectedOperation !== undefined) {
      operations = operations.filter(op => op.name === selectedOperation);
      if (!operations.length) throw Error('Selected operation is not a read-only message observer');
    } else if (moduleId) operations = operations.filter(op => op.name === 'message_observe');
    if (!operations.length) { modules.push({ ...row, status: 'unsupported' }); continue; }
    for (const operation of operations) {
      const channel = { ...row, operation: operation.name,
        name: operation.name === 'message_observe' ? row.name : `${row.name} · ${operation.name}` };
      try {
        const observe = async query => validateMessageObservation(await core.agentRead({
          moduleId: module.id, operation: operation.name, args: query
        }));
        const observation = await observe(args);
        if (observation.moduleId !== module.id) throw Error('Observation module mismatch');
        const statsArgs = { ...args, view: 'stats' }; delete statsArgs.cursor;
        const statistics = args.view === 'stats' ? observation : await observe(statsArgs);
        if (statistics.ownerId !== observation.ownerId || statistics.moduleId !== module.id)
          throw Error('Observation owner changed');
        modules.push({ ...channel, status: 'ready', observation, statistics });
      } catch {
        // Do not leak config paths, tokens or arbitrary provider error text to a dashboard.
        modules.push({ ...channel, status: 'unavailable', reason: 'owner_read_unavailable' });
      }
    }
  }
  const owners = new Set(); let total = 0;
  for (const row of modules) {
    if (row.status !== 'ready' || row.statistics.ownerId === 'unknown' || owners.has(row.statistics.ownerId)) continue;
    owners.add(row.statistics.ownerId);
    if (Number.isSafeInteger(row.statistics.stats.total)) total += row.statistics.stats.total;
  }
  return {
    schemaVersion: 1, observedAt: new Date().toISOString(), modules,
    totals: { retained: total, readableOwners: owners.size,
      complete: modules.every(row => row.status === 'ready' && row.statistics.ownerId !== 'unknown' &&
        row.statistics.coverage.complete && row.statistics.stats.total !== 'unknown') },
    scope: 'enabled_registered_retained_owners',
    readOnly: true, deliverySideEffects: false, consumerConfirmation: false
  };
}
