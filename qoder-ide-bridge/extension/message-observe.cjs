"use strict";
const { createHash } = require("node:crypto");
const { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } = require("node:fs");
const { isAbsolute, join, resolve } = require("node:path");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const canonical = path => (realpathSync.native ?? realpathSync)(resolve(path));
const digest = value => createHash("sha256").update(value).digest("hex");
const messageDir = stateDir => join(stateDir, "message-reservations");
const claimDir = stateDir => join(stateDir, "request-reservations");
const headroomPath = (dir, requestId) => join(dir, `${requestId}.headroom`);
const failure = (code, message, status = 500) => Object.assign(Error(message), { code, status });
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_OBSERVE_RECORD_BYTES = MAX_RECORD_BYTES + 16000 * 6 + 2;
const recordCapacity = record => MAX_RECORD_BYTES + (typeof record.content === "string" ?
  Buffer.byteLength(JSON.stringify(record.content)) : 0);

function ownerIdForStateDir(stateDir) {
  if (!isAbsolute(stateDir)) throw failure("INVALID_STATE_DIR", "Qoder IDE stateDir must be absolute", 400);
  const store = canonical(stateDir);
  const identity = process.platform === "win32" ? store.toLowerCase() : store;
  return `qoder-ide-store:${digest(identity).slice(0, 40)}`;
}

function readRecordAt(path, text = readFileSync(path, "utf8")) {
  const value = JSON.parse(text);
  const current = [2, 3].includes(value.schemaVersion) && id.test(value.ownerId ?? "") &&
    Number.isSafeInteger(value.allocatedBytes) && value.allocatedBytes > 0;
  const legacy = value.schemaVersion === 1 && id.test(value.ownerId ?? "") &&
    Number.isSafeInteger(value.budgetBytes) && value.budgetBytes > 0;
  if (!plain(value) || (!current && !legacy) || !uuid.test(value.requestId ?? "") ||
      !id.test(value.deliveryId ?? "") || !isAbsolute(value.workspace) || value.retrySafe !== false ||
      value.content !== undefined && (typeof value.content !== "string" || value.content.length > 16000))
    throw failure("INVALID_RECORD", "Invalid Qoder IDE page reservation record", 503);
  return value;
}

function statusOf(record) {
  const providerAcceptance = record.provider && !record.quarantine ?
    { state: "accepted", evidence: "matched UserPromptSubmit hook" } : { state: "unknown" };
  const reply = record.quarantine ? { state: "quarantined", reason: "provider_attribution_conflict" } :
    record.reply ?? (record.replySupport === "unsupported_native_request_set_id_unavailable" ?
      { state: "unsupported", reason: "native_request_set_id_unavailable" } :
      { state: record.provider ? "pending" : "unobserved" });
  return { requestId: record.requestId, deliveryId: record.deliveryId, ownerId: record.ownerId,
    instanceId: record.instanceId, workspace: record.workspace, correlation: record.correlation,
    deliveryScope: record.deliveryScope, targetPrecision: record.targetPrecision, retrySafe: false,
    reservation: { state: "persisted", ownerId: record.ownerId, deliveryId: record.deliveryId },
    providerAcceptance, command: record.command ?? { state: "reserved_not_dispatched" }, reply };
}

// Observation deliberately bypasses withOwnerLock: readers must never recover or mutate retained records.
function observeMessages(stateDir, args) {
  if (!isAbsolute(stateDir) || !plain(args) || Object.keys(args).some(key =>
      !["view", "limit", "cursor", "correlation", "requestId", "deliveryId"].includes(key)) ||
      !["items", "detail", "stats"].includes(args.view)) throw failure("INVALID_OBSERVATION", "Invalid observation arguments", 400);
  const limit = args.limit ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      ["correlation", "requestId", "deliveryId"].some(key => args[key] !== undefined &&
        (typeof args[key] !== "string" || !id.test(args[key]))) ||
      args.view === "detail" && !args.requestId && !args.deliveryId || args.cursor !== undefined &&
      (args.view !== "items" || typeof args.cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(args.cursor)))
    throw failure("INVALID_OBSERVATION", "Invalid observation arguments", 400);
  let ownerId;
  try { ownerId = ownerIdForStateDir(stateDir); }
  catch { const path = resolve(stateDir); ownerId = `qoder-ide-store:${digest(process.platform === "win32" ? path.toLowerCase() : path).slice(0, 40)}`; }
  const filters = Object.fromEntries(["correlation", "requestId", "deliveryId"].filter(key => args[key] !== undefined)
    .map(key => [key, args[key]]));
  const cursorScope = { moduleId: "agent-qoder-ide", ownerId, view: args.view, filters };
  let after = null;
  if (args.cursor !== undefined) {
    try {
      const cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
      if (!plain(cursor) || Object.keys(cursor).sort().join(",") !== "position,scope,v" || cursor.v !== 1 ||
          JSON.stringify(cursor.scope) !== JSON.stringify(cursorScope) || typeof cursor.position !== "string" ||
          !uuid.test(cursor.position)) throw Error();
      after = cursor.position;
    } catch { throw failure("INVALID_CURSOR", "Invalid message observation cursor or changed filters", 400); }
  }
  const limitations = ["retained_owner_records_only", "page_level_not_session_atomic", "no_transition_log",
    "consumer_confirmation_not_recorded", "business_acceptance_unknown", "non_atomic_read"];
  const result = { schemaVersion: 1, moduleId: "agent-qoder-ide", ownerId,
    observedAt: new Date().toISOString(), scope: { kind: "retained", ...filters },
    coverage: { complete: true, limitations }, retention: { policy: "owner_budget", prunedCount: "unknown" } };
  const unavailable = reason => {
    result.coverage.complete = false; limitations.push(reason);
    return args.view === "items" ? { ...result, items: [], nextCursor: null, hasMore: false } :
      args.view === "detail" ? { ...result, item: null } : { ...result, stats: { total: "unknown", byState: {} } };
  };
  let names, claimNames;
  const scan = dir => {
    if (!lstatSync(dir).isDirectory()) throw Error("store_unreadable");
    const entries = readdirSync(dir, { withFileTypes: true });
    // ponytail: bounded retained scan; raise the cap only with an owner store pagination format.
    if (entries.length > 4096 || entries.some(entry => !entry.isFile())) throw Error("store_unreadable");
    const names = entries.map(entry => entry.name).sort();
    if (names.some(name => name.endsWith(".tmp") || name.startsWith(".owner.lock"))) throw Error("recovery_required");
    return names;
  };
  try {
    names = scan(messageDir(stateDir));
    claimNames = existsSync(claimDir(stateDir)) ? scan(claimDir(stateDir)) : [];
  } catch (error) { return unavailable(error.message === "recovery_required" ? "recovery_required" : "owner_store_unavailable"); }
  const records = [], snapshots = [];
  try {
    for (const name of names) {
      if (name.endsWith(".headroom")) {
        if (!names.includes(`${name.slice(0, -9)}.json`)) throw Error("recovery_required");
        continue;
      }
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) throw Error("recovery_required");
      const path = join(messageDir(stateDir), name), before = lstatSync(path);
      if (!before.isFile() || before.size > MAX_OBSERVE_RECORD_BYTES) throw Error("record_unreadable");
      let file, record;
      try {
        file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(file), buffer = Buffer.alloc(MAX_OBSERVE_RECORD_BYTES + 1);
        if (!opened.isFile() || opened.size > MAX_OBSERVE_RECORD_BYTES || opened.ino !== before.ino) throw Error("record_unreadable");
        let bytes = 0, count;
        while (bytes <= MAX_OBSERVE_RECORD_BYTES && (count = readSync(file, buffer, bytes, buffer.length - bytes, bytes))) bytes += count;
        if (bytes > MAX_OBSERVE_RECORD_BYTES) throw Error("record_unreadable");
        record = readRecordAt(path, buffer.subarray(0, bytes).toString("utf8"));
        if (bytes > recordCapacity(record)) throw Error("record_unreadable");
      } finally { if (file !== undefined) closeSync(file); }
      const current = lstatSync(path);
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ino !== before.ino)
        throw Error("store_changed_during_observation");
      if (record.requestId !== name.slice(0, -5) || record.ownerId !== ownerId) throw Error("record_unreadable");
      if (record.schemaVersion === 3 && (!names.includes(`${record.requestId}.headroom`) ||
          !lstatSync(headroomPath(messageDir(stateDir), record.requestId)).isFile() ||
          lstatSync(headroomPath(messageDir(stateDir), record.requestId)).size !== 2 * recordCapacity(record) - current.size))
        throw Error("recovery_required");
      records.push(record);
      snapshots.push({ path, size: current.size, mtimeMs: current.mtimeMs, ino: current.ino });
    }
    if (JSON.stringify(scan(messageDir(stateDir))) !== JSON.stringify(names) ||
        JSON.stringify(existsSync(claimDir(stateDir)) ? scan(claimDir(stateDir)) : []) !== JSON.stringify(claimNames))
      throw Error("store_changed_during_observation");
    for (const snapshot of snapshots) {
      const current = lstatSync(snapshot.path);
      if (!current.isFile() || current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ino !== snapshot.ino)
        throw Error("store_changed_during_observation");
    }
  } catch (error) { return unavailable(["recovery_required", "store_changed_during_observation"].includes(error.message)
    ? error.message : "record_unreadable"); }
  const matches = records.filter(record => Object.entries(filters).every(([key, value]) => record[key] === value))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const date = value => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : "unknown";
  const itemOf = record => {
    const status = statusOf(record);
    const events = [];
    for (const [kind, at] of [["owner_reserved", record.reservedAt], ["command_outcome_recorded", record.command?.observedAt],
      ["provider_input_observed", record.provider?.observedAt], ["reply_observed", record.reply?.observedAt],
      ["provider_attribution_conflict", record.quarantine?.observedAt]])
      if (date(at) !== "unknown") events.push({ at, kind });
    events.sort((a, b) => a.at.localeCompare(b.at));
    const max = args.view === "items" ? 512 : 16000;
    const content = typeof record.content === "string" ? { status: "available", text: record.content.slice(0, max),
      truncated: record.content.length > max } : { status: "unavailable", reason: "not_recorded" };
    const reply = status.reply;
    const replyState = typeof reply.state === "string" && reply.state.length > 0 && reply.state.length <= 128 ? reply.state : "unknown";
    const nativeState = record.quarantine?.state ?? (reply.state === "observed" ? reply.state : status.command.state);
    return { requestId: record.requestId, deliveryId: record.deliveryId, ownerId,
      source: "unknown", target: { moduleId: "agent-qoder-ide", address: uuid.test(record.instanceId ?? "") ? record.instanceId : "unknown" },
      correlation: id.test(record.correlation ?? "") ? record.correlation : "unknown", replyTo: "unknown",
      createdAt: date(record.reservedAt), updatedAt: events.at(-1)?.at ?? "unknown",
      state: typeof nativeState === "string" && nativeState.length > 0 && nativeState.length <= 128 ? nativeState : "unknown", content,
      evidence: { ownerAccepted: true, providerAccepted: status.providerAcceptance.state === "accepted" ? true : "unknown",
        consumerConfirmed: "unknown", ...(reply.state === "observed" ? { terminalOutcome: "reply_observed" } :
          status.command.state === "failed" ? { terminalOutcome: "command_failed" } : {}), businessAccepted: "unknown" },
      trace: { status: events.length ? "available" : "unavailable", events,
        ...(events.length ? {} : { reason: "not_recorded" }) },
      providerInput: { state: status.providerAcceptance.state },
      reply: { state: replyState, ...(typeof reply.preview === "string" ? {
        content: { status: "available", text: reply.preview.slice(0, args.view === "items" ? 512 : 4096),
          truncated: reply.truncated === true || reply.preview.length > (args.view === "items" ? 512 : 4096) },
        stopHookActive: [false, true].includes(reply.stopHookActive) ? reply.stopHookActive : "unknown" } : {}) } };
  };
  if (args.view === "detail") return { ...result, item: matches.length === 1 ? itemOf(matches[0]) : null,
    ...(matches.length > 1 ? { coverage: { complete: false, limitations: [...limitations, "ambiguous_delivery_id"] } } : {}) };
  if (args.view === "stats") {
    const byState = Object.create(null);
    for (const record of matches) { const state = itemOf(record).state; byState[state] = (byState[state] ?? 0) + 1; }
    return { ...result, stats: { total: matches.length, byState } };
  }
  const pending = matches.filter(record => after === null || record.requestId.localeCompare(after) > 0);
  const items = [];
  for (const record of pending.slice(0, limit)) {
    const item = itemOf(record);
    if (Buffer.byteLength(JSON.stringify({ ...result, items: [...items, item] })) > 60000) break;
    items.push(item);
  }
  const hasMore = pending.length > items.length;
  return { ...result, items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1,
    scope: cursorScope, position: items.at(-1).requestId })).toString("base64url") : null };
}

module.exports = { observeMessages, ownerIdForStateDir, readRecordAt, recordCapacity, statusOf };
