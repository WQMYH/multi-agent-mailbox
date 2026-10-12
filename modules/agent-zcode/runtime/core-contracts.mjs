export const MESSAGE_RECEIPT_VERSION = 1;
export const MESSAGE_BUDGET_VERSION = 1;
export const MESSAGE_DATA_BUDGET_BYTES = 200_000_000;
export const DEFAULT_OWNER_BUDGET_BYTES = 50_000_000;

const supportedMessageDataBudgetBytes = new Set([20_000_000, MESSAGE_DATA_BUDGET_BYTES]);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const acceptanceStates = new Set(["unknown", "accepted", "rejected"]);

const fail = message => { throw Error(message); };

const object = (value, name) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object`);
  return value;
};

const exact = (value, allowed, name) => {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${name} field: ${key}`);
  return value;
};

const id = (value, name) => {
  if (typeof value !== "string" || !idPattern.test(value)) fail(`Invalid ${name}`);
  return value;
};

const endpoint = (value, name) => {
  exact(value, ["moduleId", "address"], name);
  return { moduleId: id(value.moduleId, `${name}.moduleId`), address: id(value.address, `${name}.address`) };
};

const acceptance = (value, name) => {
  exact(value, ["state", "evidence"], name);
  if (!acceptanceStates.has(value.state)) fail(`Invalid ${name}.state`);
  if (value.state !== "unknown" &&
      (typeof value.evidence !== "string" || !value.evidence.trim() || value.evidence.length > 2048))
    fail(`${name}.evidence is required for accepted or rejected state`);
  if (value.state === "unknown" && value.evidence !== undefined) fail(`${name}.evidence is not allowed for unknown state`);
  return { state: value.state, ...(value.evidence === undefined ? {} : { evidence: value.evidence }) };
};

export function validateMessageReceipt(value) {
  exact(value, ["schemaVersion", "requestId", "deliveryId", "ownerId", "target", "correlation", "replyTo", "acceptance"], "message receipt");
  if (value.schemaVersion !== MESSAGE_RECEIPT_VERSION) fail("Unsupported message receipt schemaVersion");
  if (value.correlation === undefined && value.replyTo === undefined)
    fail("Message receipt requires correlation or replyTo");
  exact(value.acceptance, ["owner", "provider"], "message receipt acceptance");
  return {
    schemaVersion: MESSAGE_RECEIPT_VERSION,
    requestId: id(value.requestId, "requestId"),
    deliveryId: id(value.deliveryId, "deliveryId"),
    ownerId: id(value.ownerId, "ownerId"),
    target: endpoint(value.target, "target"),
    ...(value.correlation === undefined ? {} : { correlation: id(value.correlation, "correlation") }),
    ...(value.replyTo === undefined ? {} : {
      replyTo: {
        ownerId: id(exact(value.replyTo, ["ownerId", "target"], "replyTo").ownerId, "replyTo.ownerId"),
        target: endpoint(value.replyTo.target, "replyTo.target")
      }
    }),
    acceptance: {
      owner: acceptance(value.acceptance.owner, "acceptance.owner"),
      provider: acceptance(value.acceptance.provider, "acceptance.provider")
    }
  };
}

export const messageObserveInputSchema = {
  type: "object", required: ["view"], additionalProperties: false,
  properties: {
    view: { type: "string", enum: ["items", "detail", "stats"] },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 32 },
    cursor: { type: "string", minLength: 1, maxLength: 4096 },
    ...Object.fromEntries(["correlation", "requestId", "deliveryId"].map(key =>
      [key, { type: "string", pattern: idPattern.source, minLength: 1, maxLength: 128 }]))
  }
};

export function validateMessageObserveArgs(value) {
  exact(value, Object.keys(messageObserveInputSchema.properties), "message observation arguments");
  if (!["items", "detail", "stats"].includes(value.view)) fail("Invalid message observation view");
  const limit = value.limit ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("Invalid message observation limit");
  const result = { view: value.view, limit };
  for (const key of ["correlation", "requestId", "deliveryId"])
    if (value[key] !== undefined) result[key] = id(value[key], key);
  if (value.cursor !== undefined) {
    if (value.view !== "items" || typeof value.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,4096}$/.test(value.cursor)) fail("Invalid message observation cursor");
    result.cursor = value.cursor;
  }
  if (value.view === "detail" && !result.requestId && !result.deliveryId)
    fail("Message observation detail requires requestId or deliveryId");
  return result;
}

export function encodeMessageObserveCursor(scope, position) {
  object(scope, "message observation cursor scope");
  if (!(Number.isSafeInteger(position) && position >= 0) &&
      !(typeof position === "string" && position.length > 0 && position.length <= 256))
    fail("Invalid message observation cursor position");
  return Buffer.from(JSON.stringify({ v: 1, scope, position })).toString("base64url");
}

export function decodeMessageObserveCursor(cursor, scope) {
  if (cursor === undefined) return null;
  try {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    exact(value, ["v", "scope", "position"], "message observation cursor");
    if (value.v !== 1 || JSON.stringify(value.scope) !== JSON.stringify(scope)) throw Error();
    encodeMessageObserveCursor(scope, value.position);
    return value.position;
  } catch { fail("Invalid message observation cursor or changed filters"); }
}

export function validateMessageObservation(value) {
  object(value, "message observation");
  if (value.schemaVersion !== 1) fail("Unsupported message observation schemaVersion");
  id(value.moduleId, "moduleId");
  id(value.ownerId, "ownerId");
  if (!Number.isFinite(Date.parse(value.observedAt))) fail("Invalid observedAt");
  if (object(value.scope, "scope").kind !== "retained") fail("Invalid message observation scope");
  const coverage = object(value.coverage, "coverage");
  if (typeof coverage.complete !== "boolean" || !Array.isArray(coverage.limitations) ||
      !coverage.limitations.every(text => typeof text === "string")) fail("Invalid message observation coverage");
  object(value.retention, "retention");
  const validateItem = item => {
    object(item, "message observation item");
    for (const key of ["requestId", "deliveryId", "ownerId"]) id(item[key], key);
    if (typeof item.state !== "string" || !item.state.length) fail("Invalid message observation state");
    for (const key of ["createdAt", "updatedAt"])
      if (item[key] !== "unknown" && !Number.isFinite(Date.parse(item[key]))) fail(`Invalid ${key}`);
    const content = object(item.content, "content");
    if (!["available", "unavailable"].includes(content.status) ||
        content.status === "available" && (typeof content.text !== "string" || content.text.length > 16000))
      fail("Invalid message observation content");
    const evidence = object(item.evidence, "evidence");
    for (const key of ["ownerAccepted", "providerAccepted", "consumerConfirmed"])
      if (![true, false, "unknown"].includes(evidence[key])) fail(`Invalid evidence.${key}`);
    if (evidence.businessAccepted !== "unknown") fail("Message observation cannot claim business acceptance");
    const trace = object(item.trace, "trace");
    if (!["available", "unavailable"].includes(trace.status) || !Array.isArray(trace.events) || trace.events.length > 100)
      fail("Invalid message observation trace");
    for (const event of trace.events)
      if (!Number.isFinite(Date.parse(event.at)) || typeof event.kind !== "string" || !event.kind.length)
        fail("Invalid message observation trace event");
  };
  if (Object.hasOwn(value, "items")) {
    if (!Array.isArray(value.items) || value.items.length > 100 || typeof value.hasMore !== "boolean" ||
        value.nextCursor !== null && typeof value.nextCursor !== "string") fail("Invalid message observation items");
    value.items.forEach(validateItem);
  } else if (Object.hasOwn(value, "item")) {
    if (value.item !== null) validateItem(value.item);
  } else {
    const stats = object(value.stats, "stats");
    if (!(Number.isSafeInteger(stats.total) && stats.total >= 0) && stats.total !== "unknown")
      fail("Invalid message observation total");
    object(stats.byState, "stats.byState");
  }
  return value;
}

const owners = ownerIds => {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) fail("At least one enabled queue owner is required");
  return [...new Set(ownerIds.map(ownerId => id(ownerId, "ownerId")))].sort();
};

const positiveBytes = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid ${name}`);
  return value;
};

const budgetOptions = value => {
  exact(value, ["defaultOwnerBytes", "ownerOverrides", "globalLimitBytes", "migrateLegacy"], "budget options");
  const ownerOverrides = value.ownerOverrides === undefined ? {} : object(value.ownerOverrides, "ownerOverrides");
  for (const [ownerId, bytes] of Object.entries(ownerOverrides)) {
    id(ownerId, "ownerOverrides ownerId");
    positiveBytes(bytes, `ownerOverrides.${ownerId}`);
  }
  if (value.defaultOwnerBytes !== undefined) positiveBytes(value.defaultOwnerBytes, "defaultOwnerBytes");
  if (value.globalLimitBytes !== undefined && value.globalLimitBytes !== null)
    positiveBytes(value.globalLimitBytes, "globalLimitBytes");
  if (value.migrateLegacy !== undefined && typeof value.migrateLegacy !== "boolean") fail("Invalid migrateLegacy");
  return value;
};

export function createMessageBudget(ownerIds, options = {}) {
  const planned = planMessageBudget(null, ownerIds, options);
  if (!planned.ok) fail(`Message budget ${planned.conflict.reason} by ${planned.conflict.deltaBytes} bytes`);
  return planned.config;
}

export function validateMessageBudget(value) {
  exact(value, ["schemaVersion", "totalBytes", "allocations", "defaultOwnerBytes", "globalLimitBytes"], "message budget");
  if (value.schemaVersion !== MESSAGE_BUDGET_VERSION) fail("Unsupported message budget");
  if (value.defaultOwnerBytes === undefined) {
    if (!supportedMessageDataBudgetBytes.has(value.totalBytes) || value.globalLimitBytes !== undefined)
      fail("Unsupported legacy message budget");
  } else {
    positiveBytes(value.defaultOwnerBytes, "defaultOwnerBytes");
    positiveBytes(value.totalBytes, "totalBytes");
    if (value.globalLimitBytes !== undefined) positiveBytes(value.globalLimitBytes, "globalLimitBytes");
    if (value.globalLimitBytes !== undefined && value.totalBytes > value.globalLimitBytes)
      fail("Message budget exceeds globalLimitBytes");
  }
  if (!Array.isArray(value.allocations) || value.allocations.length === 0) fail("Message budget allocations are required");
  const seen = new Set();
  let allocatedBytes = 0;
  const allocations = value.allocations.map((allocation, index) => {
    exact(allocation, ["ownerId", "bytes"], `message budget allocation ${index}`);
    const ownerId = id(allocation.ownerId, "ownerId");
    if (seen.has(ownerId)) fail(`Duplicate message budget owner: ${ownerId}`);
    positiveBytes(allocation.bytes, `budget bytes for ${ownerId}`);
    seen.add(ownerId);
    allocatedBytes += allocation.bytes;
    if (!Number.isSafeInteger(allocatedBytes)) fail("Message budget total overflows safe integer range");
    return { ownerId, bytes: allocation.bytes };
  });
  if (allocatedBytes !== value.totalBytes)
    fail(`Message budget differs from ${value.totalBytes} bytes by ${allocatedBytes - value.totalBytes}`);
  return { schemaVersion: MESSAGE_BUDGET_VERSION, totalBytes: value.totalBytes, allocations,
    ...(value.defaultOwnerBytes === undefined ? {} : { defaultOwnerBytes: value.defaultOwnerBytes }),
    ...(value.globalLimitBytes === undefined ? {} : { globalLimitBytes: value.globalLimitBytes }) };
}

export function planMessageBudget(existing, enabledOwnerIds, options = {}) {
  const enabled = owners(enabledOwnerIds);
  options = budgetOptions(options);
  const config = existing == null ? null : validateMessageBudget(existing);
  const previous = new Map(config?.allocations.map(allocation => [allocation.ownerId, allocation.bytes]));
  const missingOwners = enabled.filter(ownerId => !previous.has(ownerId));
  if (config && config.defaultOwnerBytes === undefined && !options.migrateLegacy) {
    if (missingOwners.length || options.defaultOwnerBytes !== undefined || options.globalLimitBytes !== undefined ||
        Object.keys(options.ownerOverrides ?? {}).length)
      return { ok: false, created: false, changed: false, config, conflict: {
        reason: missingOwners.length ? "enabled_owner_unallocated" : "legacy_migration_required",
        missingOwners, deltaBytes: missingOwners.length * DEFAULT_OWNER_BUDGET_BYTES
      } };
    return { ok: true, created: false, changed: false, config };
  }
  const defaultOwnerBytes = options.defaultOwnerBytes ?? config?.defaultOwnerBytes ?? DEFAULT_OWNER_BUDGET_BYTES;
  const globalLimitBytes = options.globalLimitBytes === null ? undefined :
    options.globalLimitBytes ?? config?.globalLimitBytes;
  const allocationsByOwner = new Map(previous);
  for (const ownerId of enabled) if (!allocationsByOwner.has(ownerId)) allocationsByOwner.set(ownerId, defaultOwnerBytes);
  for (const [ownerId, bytes] of Object.entries(options.ownerOverrides ?? {})) {
    if (!allocationsByOwner.has(ownerId)) fail(`Owner is not allocated: ${ownerId}`);
    if (previous.has(ownerId) && bytes < previous.get(ownerId))
      return { ok: false, created: false, changed: false, config, conflict: {
        reason: "owner_quota_reduction_requires_usage", ownerId, deltaBytes: previous.get(ownerId) - bytes
      } };
    allocationsByOwner.set(ownerId, bytes);
  }
  const allocations = [...allocationsByOwner].sort(([a], [b]) => a.localeCompare(b))
    .map(([ownerId, bytes]) => ({ ownerId, bytes }));
  let totalBytes = 0;
  for (const allocation of allocations) {
    totalBytes += allocation.bytes;
    if (!Number.isSafeInteger(totalBytes)) fail("Message budget total overflows safe integer range");
  }
  if (globalLimitBytes !== undefined && totalBytes > globalLimitBytes)
    return { ok: false, created: false, changed: false, config, conflict: {
      reason: "global_limit_exceeded", deltaBytes: totalBytes - globalLimitBytes
    } };
  const next = validateMessageBudget({ schemaVersion: MESSAGE_BUDGET_VERSION, totalBytes, allocations,
    defaultOwnerBytes, ...(globalLimitBytes === undefined ? {} : { globalLimitBytes }) });
  const created = !config;
  return { ok: true, created, changed: created || JSON.stringify(config) !== JSON.stringify(next), config: next };
}

export function checkMessageBudget(config, { ownerId, usedBytes, additionalBytes = 0 } = {}) {
  config = validateMessageBudget(config);
  ownerId = id(ownerId, "ownerId");
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 ||
      !Number.isSafeInteger(additionalBytes) || additionalBytes < 0) fail("Budget usage must be non-negative safe integers");
  const allocation = config.allocations.find(candidate => candidate.ownerId === ownerId);
  if (!allocation) return { ok: false, ownerId, reason: "owner_unallocated", deltaBytes: Math.max(1, additionalBytes) };
  const projectedBytes = usedBytes + additionalBytes;
  if (!Number.isSafeInteger(projectedBytes)) fail("Budget usage overflows safe integer range");
  return {
    ok: projectedBytes <= allocation.bytes,
    ownerId,
    allocatedBytes: allocation.bytes,
    usedBytes,
    additionalBytes,
    projectedBytes,
    remainingBytes: Math.max(0, allocation.bytes - projectedBytes),
    deltaBytes: Math.max(0, projectedBytes - allocation.bytes),
    ...(projectedBytes <= allocation.bytes ? {} : { reason: "owner_budget_exceeded" })
  };
}
