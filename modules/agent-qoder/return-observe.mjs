import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { storeOwnerId } from './runtime/store-budget.mjs';
import { validReceiptShape } from './runtime/event-recorder.mjs';
import { validateMessageObserveArgs, validateMessageObservation, encodeMessageObserveCursor,
  decodeMessageObserveCursor } from './runtime/core-contracts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
// ponytail: bounded retained scan; larger owners need a persisted pagination format.
export const RETURN_READ_LIMITS = Object.freeze({ entries: 4096, fileBytes: 65536, scanBytes: 4_194_304 });
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = value => typeof value === 'string' && ID.test(value);
const reservationId = name => `qoder-return-reservation:${createHash('sha256').update(name).digest('hex').slice(0,40)}`;

function project(record, name, ownerId) {
  let requestId, createdAt, state, source, target, terminalOutcome = 'unknown', events, providerAccepted;
  const links = {};
  if (name.startsWith('receipt-')) {
    if (!validReceiptShape(record) || record.event.evidenceRef !== name || !id(record.event.requestId) ||
        !id(record.identity.sessionId) || !id(record.identity.targetTaskId)) throw Error('invalid_record');
    const { event } = record;
    requestId = event.requestId; createdAt = record.receivedAt; state = record.sendState;
    source = { moduleId: 'agent-qoder', address: record.identity.sessionId };
    target = { moduleId: 'codex-host', address: record.identity.targetTaskId };
    events = [{ at: event.observedAt, kind: event.signal, source: event.source }];
    if (event.signal === 'verified_turn_result') {
      terminalOutcome = event.data.terminalOutcome;
      for (const key of ['ownerId', 'deliveryId', 'nativeInputId', 'nativeTurnId', 'assistantId', 'evidenceSource'])
        if (id(event.data[key])) links[key] = event.data[key];
    }
    // The canonical validator proves target, sent, dispatchAttempted and sentAt together.
    providerAccepted = state === 'accepted' ? true : state === 'recorded' ? false : 'unknown';
    if (date(record.dispatchIntentAt)) events.push({ at: record.dispatchIntentAt, kind: 'dispatch_intent' });
    if (providerAccepted === true) events.push({ at: record.sentAt, kind: 'host_accepted' });
  } else {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 ||
        typeof record.selectionToken !== 'string' || !TOKEN.test(record.selectionToken) ||
        name !== `message-${record.selectionToken}.json` || !id(record.threadId) ||
        typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || !SHA.test(record.messageSha256 ?? '') ||
        !date(record.createdAt) || !['dispatch_intent', 'accepted'].includes(record.state) ||
        record.state === 'accepted' && !date(record.acceptedAt)) throw Error('invalid_record');
    // This is a selection reservation, not a native request/message identifier.
    requestId = reservationId(name); createdAt = record.createdAt; state = record.state;
    target = { moduleId: 'codex-host', address: record.threadId };
    providerAccepted = state === 'accepted' ? true : 'unknown';
    events = [{ at: createdAt, kind: 'dispatch_intent' }];
    if (providerAccepted === true) events.push({ at: record.acceptedAt, kind: 'host_accepted' });
  }
  const deliveryId = reservationId(name);
  return { requestId, deliveryId, ownerId, idKind: 'reservation',
    requestIdKind: name.startsWith('receipt-') ? 'retained_request' : 'reservation',
    state, createdAt, updatedAt: events.at(-1).at, ...(source ? { source } : {}), target,
    ...(Object.keys(links).length ? { nativeAssociation: links } : {}),
    content: { status: 'unavailable', reason: 'not_recorded' },
    evidence: { ownerAccepted: true, providerAccepted, consumerConfirmed: 'unknown', businessAccepted: 'unknown', terminalOutcome },
    trace: { status: 'available', events } };
}

export function observeReturns(config, input) {
  const args = validateMessageObserveArgs(input);
  if (!config?.returnModulePath || typeof config.returnDataDir !== 'string' ||
      !isAbsolute(config.returnModulePath) || !isAbsolute(config.returnDataDir))
    throw Error('Configured Qoder return module and data directory are required');
  const filters = Object.fromEntries(['correlation', 'requestId', 'deliveryId']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  const limitations = ['retained_owner_records_only', 'non_atomic_read', 'exact_content_not_recorded',
    'correlation_not_recorded', 'consumer_confirmation_not_recorded', 'business_acceptance_unknown'];
  let ownerId = 'unknown', root;
  let complete = true;
  const incomplete = reason => { complete = false; if (!limitations.includes(reason)) limitations.push(reason); };
  try {
    if (!lstatSync(config.returnDataDir).isDirectory()) throw Error();
    root = realpathSync.native(config.returnDataDir);
    ownerId = storeOwnerId(config.returnDataDir);
  } catch { root = undefined; incomplete('owner_unavailable'); }
  const cursorScope = { moduleId: 'agent-qoder', ownerId, channel: 'return', filters };
  const after = decodeMessageObserveCursor(args.cursor, cursorScope);
  if (after !== null && (typeof after !== 'string' || !ID.test(after))) throw Error('Invalid return observation cursor');
  const items = [];
  let directory, scannedBytes = 0;
  if (root) try {
    directory = opendirSync(root);
    for (let count = 0, entry; (entry = directory.readSync()) !== null; count++) {
      if (count >= RETURN_READ_LIMITS.entries) { incomplete('scan_entry_limit'); break; }
      if (!entry.isFile() || !/^(?:receipt-[A-Za-z0-9_-]+|message-[A-Za-z0-9_-]+)\.json$/.test(entry.name)) continue;
      let fd;
      try {
        const path = join(root, entry.name), stat = lstatSync(path);
        if (!stat.isFile()) continue;
        if (stat.size > RETURN_READ_LIMITS.fileBytes) { incomplete('record_byte_limit'); continue; }
        if (scannedBytes + stat.size + 1 > RETURN_READ_LIMITS.scanBytes) { incomplete('scan_byte_limit'); break; }
        fd = openSync(path, 'r');
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Error();
        const bytes = Buffer.alloc(stat.size + 1);
        let size = 0, read;
        while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
        scannedBytes += size;
        if (size !== stat.size || fstatSync(fd).size !== stat.size) throw Error();
        const item = project(JSON.parse(bytes.toString('utf8', 0, size)), entry.name, ownerId);
        if (Object.entries(filters).every(([key, value]) => item[key] === value)) items.push(item);
      } catch { incomplete('record_unreadable_or_invalid'); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch { incomplete('owner_unreadable'); }
  finally { directory?.closeSync(); }
  items.sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
  const result = { schemaVersion: 1, moduleId: 'agent-qoder', ownerId, observedAt: new Date().toISOString(),
    scope: { kind: 'retained', channel: 'return', ...filters }, coverage: { complete, limitations },
    retention: { policy: 'owner_budget', prunedCount: 'unknown' } };
  if (args.view === 'detail') {
    if (items.length > 1) throw Error('Multiple return records match; deliveryId is required for detail');
    return validateMessageObservation({ ...result, item: items[0] ?? null });
  }
  if (args.view === 'stats') {
    const byState = {};
    for (const item of items) byState[item.state] = (byState[item.state] ?? 0) + 1;
    return validateMessageObservation({ ...result, stats: { total: complete ? items.length : 'unknown',
      observedCount: items.length, byState } });
  }
  const remaining = after === null ? items : items.filter(item => item.deliveryId.localeCompare(after) > 0);
  const page = remaining.slice(0, args.limit), hasMore = remaining.length > page.length;
  return validateMessageObservation({ ...result, items: page, hasMore,
    nextCursor: hasMore ? encodeMessageObserveCursor(cursorScope, page.at(-1).deliveryId) : null });
}
