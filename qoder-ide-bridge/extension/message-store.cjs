"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { Worker } = require("node:worker_threads");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plain = value => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const canonical = path => (realpathSync.native ?? realpathSync)(resolve(path));
const same = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const digest = value => createHash("sha256").update(value).digest("hex");
const marker = requestId => `\n\n[agent-core-request:${requestId}]`;
const wireContent = (content, requestId) => `${content}${marker(requestId)}`;
const messageDir = stateDir => join(stateDir, "message-reservations");
const claimDir = stateDir => join(stateDir, "request-reservations");
const recordPath = (dir, requestId) => join(dir, `${requestId}.json`);
const headroomPath = (dir, requestId) => join(dir, `${requestId}.headroom`);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 512;
const LOCK_NAME = ".owner.lock";

function failure(code, message, status = 500) {
  return Object.assign(Error(message), { code, status });
}

function ownerIdForStateDir(stateDir) {
  if (!isAbsolute(stateDir)) throw failure("INVALID_STATE_DIR", "Qoder IDE stateDir must be absolute", 400);
  const store = canonical(stateDir);
  const identity = process.platform === "win32" ? store.toLowerCase() : store;
  return `qoder-ide-store:${digest(identity).slice(0, 40)}`;
}

function readLock(path, ownerId) {
  let text, value;
  try { text = readFileSync(path, "utf8"); value = JSON.parse(text); }
  catch { throw failure("OWNER_BUSY", "Qoder IDE reservation store lock cannot be safely recovered", 503); }
  if (!plain(value) || value.ownerId !== ownerId || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.createdAt !== "string" || (value.token !== undefined && !uuid.test(value.token)))
    throw failure("OWNER_BUSY", "Qoder IDE reservation store lock cannot be safely recovered", 503);
  return { text, ...value };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// ponytail: Windows kernel mutex via a transient named pipe; no disk lock/helper
// files. The worker preserves the synchronous store API and lives only for this call.
function acquireLock(ownerId) {
  if (process.platform !== "win32")
    throw failure("LOCK_UNSUPPORTED", "Qoder IDE store requires Windows named-pipe locking", 503);
  const state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const state = new Int32Array(workerData.state);
    const notify = value => { Atomics.store(state, 0, value); Atomics.notify(state, 0); };
    const server = require("node:net").createServer(socket => socket.destroy());
    server.on("error", () => notify(-1));
    server.listen(workerData.pipe, () => {
      if (Atomics.compareExchange(state, 0, 0, 1) === 0) {
        Atomics.notify(state, 0);
        Atomics.wait(state, 0, 1);
      }
      server.close(() => notify(3));
    });
  `, { eval: true, workerData: { state: state.buffer, pipe: `\\\\.\\pipe\\${ownerId}` } });
  worker.on("error", () => {});
  const waited = Atomics.wait(state, 0, 0, 10000);
  if (waited === "timed-out" || Atomics.load(state, 0) !== 1) {
    worker.terminate();
    throw failure("OWNER_BUSY", "Qoder IDE reservation store is busy", 503);
  }
  return () => {
    Atomics.store(state, 0, 2);
    Atomics.notify(state, 0);
    if (Atomics.wait(state, 0, 2, 10000) === "timed-out") worker.terminate();
  };
}

function withOwnerLock(stateDir, ownerId, callback) {
  const release = acquireLock(ownerId);
  try {
    const dir = messageDir(stateDir);
    mkdirSync(dir, { recursive: true });
    // Legacy files can be removed only after every holder is proven dead. New
    // callers already hold the kernel gate; interrupted cleanup is repeatable.
    const legacy = readdirSync(dir).filter(name => name === LOCK_NAME || name.startsWith(`${LOCK_NAME}.`));
    for (const name of legacy) {
      const path = join(dir, name);
      const candidate = name.match(/^\.owner\.lock\.(\d+)\.([0-9a-f-]{36})\.candidate$/i);
      const recovery = name.match(/^\.owner\.lock\.recover-([0-9a-f-]{36})$/i);
      if (name !== LOCK_NAME && !candidate && !(recovery && uuid.test(recovery[1])))
        throw recoveryFailure("Unknown owner-lock helper was preserved");
      const record = readLock(path, ownerId);
      if (candidate && (record.pid !== Number(candidate[1]) || record.token !== candidate[2]))
        throw recoveryFailure("Unknown owner-lock helper was preserved");
      if (processAlive(record.pid)) throw failure("OWNER_BUSY", "Qoder IDE reservation store is busy", 503);
    }
    for (const name of legacy) unlinkSync(join(dir, name));
    recoverStore(stateDir, ownerId);
    return callback(dir);
  } finally { release(); }
}

function textOf(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function atomicWrite(path, text, exclusive = false) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, text, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    if (exclusive && existsSync(path)) throw Object.assign(Error("reservation exists"), { code: "EEXIST" });
    renameSync(temporary, path);
  } catch (error) {
    if (file !== undefined) try { closeSync(file); } catch {}
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

function directoryBytes(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) =>
    total + (entry.isFile() ? statSync(join(dir, entry.name)).size : 0), 0);
}

function usedBytes(stateDir) {
  return directoryBytes(messageDir(stateDir)) + directoryBytes(claimDir(stateDir));
}

function checkPeak(stateDir, allocatedBytes, temporaryBytes) {
  const projectedBytes = usedBytes(stateDir) + MAX_LOCK_BYTES + temporaryBytes;
  if (projectedBytes > allocatedBytes)
    throw failure("OWNER_BUDGET_EXCEEDED",
      `Qoder IDE reservation store budget exceeded by ${projectedBytes - allocatedBytes} bytes`, 507);
}

function resizeHeadroom(path, bytes, exclusive = false) {
  let file;
  try {
    file = openSync(path, exclusive ? "wx" : "r+", 0o600);
    ftruncateSync(file, bytes);
    fsyncSync(file);
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

function boundedText(record) {
  const text = textOf(record);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES)
    throw failure("MESSAGE_RECORD_TOO_LARGE", "Qoder IDE page reservation exceeded its bounded record size", 507);
  return text;
}

function replaceCommittedRecord(path, current, next) {
  const text = boundedText(next);
  const room = headroomPath(dirname(path), current.requestId);
  if (current.schemaVersion !== 3 || !existsSync(room))
    throw failure("LEGACY_RECORD", "Legacy page reservation is preserved but cannot be updated", 503);
  const oldBytes = statSync(path).size;
  const nextBytes = Buffer.byteLength(text);
  resizeHeadroom(room, 2 * MAX_RECORD_BYTES - oldBytes - nextBytes);
  try { atomicWrite(path, text); }
  catch (error) {
    resizeHeadroom(room, 2 * MAX_RECORD_BYTES - oldBytes);
    throw error;
  }
  resizeHeadroom(room, 2 * MAX_RECORD_BYTES - nextBytes);
}

function readRecordAt(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const current = [2, 3].includes(value.schemaVersion) && id.test(value.ownerId ?? "") &&
    Number.isSafeInteger(value.allocatedBytes) && value.allocatedBytes > 0;
  const legacy = value.schemaVersion === 1 && id.test(value.ownerId ?? "") &&
    Number.isSafeInteger(value.budgetBytes) && value.budgetBytes > 0;
  if (!plain(value) || (!current && !legacy) || !uuid.test(value.requestId ?? "") ||
      !id.test(value.deliveryId ?? "") || !isAbsolute(value.workspace) || value.retrySafe !== false)
    throw failure("INVALID_RECORD", "Invalid Qoder IDE page reservation record", 503);
  return value;
}

function recoveryFailure(message = "Qoder IDE reservation store needs manual recovery") {
  return failure("STORE_RECOVERY_REQUIRED", message, 503);
}

function recoverStore(stateDir, ownerId) {
  const messages = messageDir(stateDir);
  const claims = claimDir(stateDir);

  const temporaryPattern = /^([0-9a-f-]{36})\.json\.(\d+)\.([0-9a-f-]{36})\.tmp$/i;
  for (const [dir, kind] of [[messages, "message"], [claims, "claim"]]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      const match = entry.name.match(temporaryPattern);
      const path = join(dir, entry.name);
      if (!match || !uuid.test(match[1])) throw recoveryFailure("Unknown atomic helper was preserved");
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid))
        throw failure("OWNER_BUSY", "Qoder IDE reservation store recovery is busy", 503);
      let value;
      try { value = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw recoveryFailure("Invalid atomic helper was preserved"); }
      const validMessage = kind === "message" && plain(value) && value.schemaVersion === 3 &&
        value.requestId === match[1] && value.ownerId === ownerId && value.retrySafe === false;
      const validClaim = kind === "claim" && plain(value) && value.schemaVersion === 2 &&
        value.requestId === match[1] && uuid.test(value.instanceId ?? "") &&
        typeof value.command === "string" && value.command.length > 0 && value.retrySafe === false &&
        (value.ownerId === undefined || value.ownerId === ownerId);
      try { if (validMessage) boundedText(value); }
      catch { throw recoveryFailure("Oversized atomic helper was preserved"); }
      if (!validMessage && !validClaim) throw recoveryFailure("Unrecognized atomic helper was preserved");
      unlinkSync(path);
    }
  }

  for (const entry of readdirSync(messages, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".headroom")) continue;
    const requestId = entry.name.slice(0, -".headroom".length);
    if (!uuid.test(requestId)) throw recoveryFailure("Unknown headroom helper was preserved");
    if (!existsSync(recordPath(messages, requestId))) unlinkSync(join(messages, entry.name));
  }

  const repairs = readdirSync(messages, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => {
      const path = join(messages, entry.name);
      const record = readRecordAt(path);
      if (record.schemaVersion !== 3) return null;
      const room = headroomPath(messages, record.requestId);
      if (record.ownerId !== ownerId || !existsSync(room)) throw recoveryFailure();
      const recordBytes = statSync(path).size;
      const expected = 2 * MAX_RECORD_BYTES - recordBytes;
      if (expected < 0) throw recoveryFailure();
      return { room, expected, actual: statSync(room).size, allocatedBytes: record.allocatedBytes };
    }).filter(Boolean);
  const delta = repairs.reduce((total, repair) => total + repair.expected - repair.actual, 0);
  const projected = usedBytes(stateDir) + MAX_LOCK_BYTES + delta;
  if (repairs.some(repair => repair.expected !== repair.actual && projected > repair.allocatedBytes))
    throw recoveryFailure("Recovered headroom would exceed its admitted allocation");
  for (const repair of repairs) if (repair.expected !== repair.actual) resizeHeadroom(repair.room, repair.expected);
}

function claimMutation({ stateDir, requestId, instanceId, workspace, command, ownerId, allocatedBytes,
  now = Date.now() }) {
  if (!isAbsolute(stateDir) || !uuid.test(requestId ?? "") || !uuid.test(instanceId ?? "") ||
      !isAbsolute(workspace) || typeof command !== "string" || !command.length)
    throw failure("INVALID_CLAIM", "Invalid Qoder IDE mutation claim", 400);
  const expectedOwner = ownerIdForStateDir(stateDir);
  if (ownerId !== expectedOwner || !Number.isSafeInteger(allocatedBytes) || allocatedBytes < 1)
    throw failure("INVALID_OWNER", "Invalid Qoder IDE reservation owner", 400);
  return withOwnerLock(stateDir, ownerId, () => {
    const dir = claimDir(stateDir);
    mkdirSync(dir, { recursive: true });
    const path = recordPath(dir, requestId);
    if (existsSync(path) || existsSync(recordPath(messageDir(stateDir), requestId)))
      throw failure("DUPLICATE_REQUEST", "requestId already persistently reserved; command was not replayed", 409);
    const claim = { schemaVersion: 2, requestId, instanceId, workspace: canonical(workspace), command,
      ownerId, allocatedBytes, reservedAt: new Date(now).toISOString(), retrySafe: false };
    const text = textOf(claim);
    checkPeak(stateDir, allocatedBytes, Buffer.byteLength(text));
    atomicWrite(path, text, true);
    return claim;
  });
}

function reserveMessage({ stateDir, allocatedBytes, requestId, deliveryId, instanceId, workspace, content,
  correlation, ownerId, now = Date.now() }) {
  const expectedOwner = ownerIdForStateDir(stateDir);
  if (!isAbsolute(stateDir) || ownerId !== expectedOwner || !Number.isSafeInteger(allocatedBytes) || allocatedBytes < 1 ||
      !uuid.test(requestId ?? "") || !id.test(deliveryId ?? "") || !uuid.test(instanceId ?? "") ||
      !isAbsolute(workspace) || typeof content !== "string" || !content.length || content.length > 16000 ||
      !id.test(correlation ?? "")) throw failure("INVALID_MESSAGE", "Invalid Qoder IDE page message", 400);
  const canonicalWorkspace = canonical(workspace);
  return withOwnerLock(stateDir, ownerId, dir => {
    const path = recordPath(dir, requestId);
    const claimPath = recordPath(claimDir(stateDir), requestId);
    if (!existsSync(claimPath)) throw failure("CLAIM_MISSING", "Qoder IDE mutation claim is missing", 503);
    if (existsSync(path)) throw failure("DUPLICATE_REQUEST", "requestId already persistently reserved; message was not replayed", 409);
    const prompt = wireContent(content, requestId);
    const record = { schemaVersion: 3, ownerId, allocatedBytes, requestId, deliveryId, correlation,
      instanceId, workspace: canonicalWorkspace, deliveryScope: "current_page_at_dispatch",
      targetPrecision: "page_level_not_session_atomic", contentSha256: digest(content), promptSha256: digest(prompt),
      reservedAt: new Date(now).toISOString(), retrySafe: false };
    const text = boundedText(record);
    checkPeak(stateDir, allocatedBytes, 2 * MAX_RECORD_BYTES);
    resizeHeadroom(headroomPath(dir, requestId), 2 * MAX_RECORD_BYTES - Buffer.byteLength(text), true);
    atomicWrite(path, text, true);
    return statusOf(record);
  });
}

function updateMessage(stateDir, requestId, update) {
  const ownerId = ownerIdForStateDir(stateDir);
  return withOwnerLock(stateDir, ownerId, dir => {
    const path = recordPath(dir, requestId);
    if (!existsSync(path)) throw failure("MESSAGE_NOT_FOUND", "Qoder IDE page reservation was not found", 404);
    const current = readRecordAt(path);
    if (current.ownerId !== ownerId || !Number.isSafeInteger(current.allocatedBytes))
      throw failure("LEGACY_RECORD", "Legacy page reservation is preserved but cannot be updated", 503);
    const next = update(current);
    if (next === current) return statusOf(current);
    replaceCommittedRecord(path, current, next);
    return statusOf(next);
  });
}

function recordCommandOutcome(stateDir, requestId, command) {
  return updateMessage(stateDir, requestId, current => ({ ...current, command }));
}

function readMessage(stateDir, requestId) {
  if (!uuid.test(requestId ?? "")) throw failure("INVALID_REQUEST", "Invalid requestId", 400);
  const ownerId = ownerIdForStateDir(stateDir);
  return withOwnerLock(stateDir, ownerId, dir => {
    const path = recordPath(dir, requestId);
    if (!existsSync(path)) throw failure("MESSAGE_NOT_FOUND", "Qoder IDE page reservation was not found", 404);
    const record = readRecordAt(path);
    if (record.ownerId !== ownerId) throw failure("OWNER_MISMATCH", "Page reservation belongs to another store", 409);
    return statusOf(record);
  });
}

function readStateDir(configPath) {
  if (!isAbsolute(configPath)) throw failure("INVALID_CONFIG", "Bridge config path must be absolute", 400);
  const value = JSON.parse(readFileSync(configPath, "utf8"));
  if (!plain(value) || value.schemaVersion !== 1 || !isAbsolute(value.stateDir))
    throw failure("INVALID_CONFIG", "Invalid bridge config", 400);
  return resolve(value.stateDir);
}

function requiredHookFields(event) {
  return ["session_id", "cwd", "hook_event_name", "transcript_path"].every(key =>
    typeof event[key] === "string" && event[key].length > 0) && isAbsolute(event.cwd) && isAbsolute(event.transcript_path);
}

function providerFields(event) {
  const requestSetId = typeof event.request_set_id === "string" && event.request_set_id.length <= 512 &&
    event.request_set_id.length ? event.request_set_id : undefined;
  const fields = { sessionId: event.session_id, transcriptPath: resolve(event.transcript_path),
    ...(requestSetId ? { requestSetId } : {}) };
  return Buffer.byteLength(JSON.stringify(fields)) <= 8192 ? fields : null;
}

function sameProvider(left, right) {
  return left.sessionId === right.sessionId && same(resolve(left.transcriptPath), resolve(right.transcriptPath)) &&
    left.requestSetId === right.requestSetId;
}

function collectHook(raw, configPath) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 64 * 1024) return "ignored";
  let event, stateDir;
  try { event = JSON.parse(raw); stateDir = readStateDir(configPath); }
  catch { return "ignored"; }
  if (!plain(event) || !requiredHookFields(event)) return "unattributable";
  let cwd;
  try { cwd = canonical(event.cwd); } catch { return "unattributable"; }

  if (event.hook_event_name === "UserPromptSubmit") {
    if (typeof event.prompt !== "string") return "ignored";
    const match = event.prompt.match(/\n\n\[agent-core-request:([0-9a-f-]{36})\]$/i);
    if (!match || !uuid.test(match[1])) return "ignored";
    let outcome = "recorded";
    try {
      updateMessage(stateDir, match[1], current => {
        if (!same(current.workspace, cwd) || current.promptSha256 !== digest(event.prompt))
          throw failure("HOOK_MISMATCH", "Hook did not match the reserved page message", 409);
        const observed = providerFields(event);
        if (!observed) throw failure("PROVIDER_FIELDS_TOO_LARGE", "Provider attribution exceeded its bounded size", 400);
        if (current.quarantine) { outcome = "conflict"; return current; }
        if (current.provider) {
          if (sameProvider(current.provider, observed)) { outcome = "duplicate"; return current; }
          outcome = "conflict";
          return { ...current, quarantine: { state: "provider_attribution_conflict",
            observedAt: new Date().toISOString(), existing: { sessionId: current.provider.sessionId,
              transcriptPath: current.provider.transcriptPath, ...(current.provider.requestSetId ?
                { requestSetId: current.provider.requestSetId } : {}) }, conflicting: observed } };
        }
        return { ...current, provider: { ...observed, observedAt: new Date().toISOString() },
          replySupport: observed.requestSetId ? "awaiting_matching_stop" : "unsupported_native_request_set_id_unavailable" };
      });
      return outcome;
    } catch { return "unattributable"; }
  }

  if (event.hook_event_name !== "Stop") return "ignored";
  if (typeof event.request_set_id !== "string" || !event.request_set_id.length) return "unsupported";
  const ownerId = ownerIdForStateDir(stateDir);
  try {
    return withOwnerLock(stateDir, ownerId, dir => {
      const candidates = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .map(entry => ({ path: join(dir, entry.name), record: readRecordAt(join(dir, entry.name)) }))
        .filter(({ record }) => !record.quarantine && record.provider?.sessionId === event.session_id &&
          record.provider.requestSetId === event.request_set_id && same(record.workspace, cwd) &&
          same(resolve(record.provider.transcriptPath), resolve(event.transcript_path)));
      if (candidates.length !== 1) return candidates.length ? "ambiguous" : "unattributable";
      if (Object.hasOwn(event, "stop_hook_active") && event.stop_hook_active !== false) return "active";
      const { path, record } = candidates[0];
      if (record.reply) return "duplicate";
      if (typeof event.last_assistant_message !== "string") return "unsupported";
      const preview = event.last_assistant_message.slice(0, 4096);
      const next = { ...record, reply: { state: "observed", preview,
        truncated: preview.length !== event.last_assistant_message.length, observedAt: new Date().toISOString(),
        stopHookActive: Object.hasOwn(event, "stop_hook_active") ? event.stop_hook_active : "unavailable",
        businessAcceptance: "unobserved" } };
      replaceCommittedRecord(path, record, next);
      return "recorded";
    });
  } catch { return "unattributable"; }
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

module.exports = { claimMutation, collectHook, ownerIdForStateDir, readMessage, recordCommandOutcome,
  reserveMessage, wireContent };
