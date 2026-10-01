import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { loadBinding, loadBindings, loadNativeBinding, validateBindingRecord } from "./event-recorder.mjs";
import { bindingReservationBytes, removeManaged, writeManagedAtomic, writeManagedExclusive } from "./store-budget.mjs";

const USAGE = "Usage: node configure-binding.mjs [--add] <dataDir> <requestId> <workspaceId> <sessionId> <hookSessionId> <cwd> <targetTaskId> <targetCwd> <expiresAt> [associationJson]";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LOCK_WAIT_MS = 5_000;
const canonical = value => {
  const path = resolve(value);
  let normalized = normalize(existsSync(path) ? realpathSync.native(path) : path);
  if (process.platform === "win32") {
    if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
    normalized = normalized.toLowerCase();
  }
  return normalized;
};

function validate(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt) {
  if (!dataDir || !requestId || !workspaceId || !sessionId || !hookSessionId || !cwd || !targetTaskId || !targetCwd || !expiresAt) throw Error(USAGE);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw Error("Invalid requestId format");
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw Error("Invalid workspaceId format");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw Error("Invalid sessionId format");
  if (!ID_PATTERN.test(hookSessionId)) throw Error("Invalid hookSessionId format");
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw Error("Invalid or past expiresAt");
  return true;
}

function bindingOf(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association) {
  validate(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt);
  if (association !== undefined && (!association || typeof association !== "object" || Array.isArray(association)
      || Object.keys(association).some(key => !["deliveryId", "ownerId", "correlation", "returnMode"].includes(key)))) throw Error("Invalid binding association");
  return validateBindingRecord({
    schemaVersion: 1,
    requestId,
    workspaceId,
    sessionId,
    hookSessionId,
    cwd,
    targetTaskId,
    targetCwd,
    expiresAt,
    createdAt: new Date().toISOString(),
    ...(association ?? {})
  });
}

export function createBinding(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const binding = bindingOf(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association);
  return withBindingLock(root, () => {
    try {
      writeManagedExclusive(root, join(root, "binding.json"), JSON.stringify(binding, null, 2),
        { newReservationBytes: bindingReservationBytes(binding) });
    } catch (error) {
      if (error.code === "EEXIST")
        throw Object.assign(Error("Binding registry already exists; use --add"), { code: "binding_registry_exists", retrySafe: false });
      throw error;
    }
    return binding;
  });
}

function acquireBindingLock(root, path) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (existsSync(path)) {
      if (Date.now() >= deadline)
        throw Object.assign(Error("Binding registry is busy"), { code: "binding_registry_busy", retrySafe: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try { writeManagedExclusive(root, path, ""); return; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw Object.assign(Error("Binding registry is busy"), { code: "binding_registry_busy", retrySafe: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function withBindingLock(root, callback) {
  const lock = join(root, "binding.json.lock");
  acquireBindingLock(root, lock);
  try { return callback(); }
  finally {
    try { removeManaged(root, lock); }
    catch { throw Object.assign(Error("Binding registry lock release failed; inspect binding.json before retrying"),
      { code: "binding_write_unknown", retrySafe: false }); }
  }
}

export function addBinding(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const binding = bindingOf(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association);
  const path = join(root, "binding.json");
  return withBindingLock(root, () => {
    let bindings;
    try { bindings = loadBindings(root); }
    catch (error) { if (error.code === "host_binding_missing") bindings = []; else throw error; }
    if (bindings.some(item => item.requestId === binding.requestId))
      throw Object.assign(Error("Binding requestId already exists"), { code: "binding_request_exists", retrySafe: false });
    const route = bindings.filter(item => item.hookSessionId === binding.hookSessionId && canonical(item.cwd) === canonical(binding.cwd));
    if (route.length && !(binding.returnMode === "native_turn" && route.every(item => item.returnMode === "native_turn")))
      throw Object.assign(Error("Binding route already exists; use a new hookSessionId/cwd"), { code: "binding_route_exists", retrySafe: false });
    writeManagedAtomic(root, path, JSON.stringify({ schemaVersion: 2, bindings: [...bindings, binding] }, null, 2),
      { newReservationBytes: bindingReservationBytes(binding) });
    const saved = binding.returnMode === "native_turn"
      ? loadNativeBinding(root, binding.requestId)
      : loadBinding(root, { requestId: binding.requestId, hookSessionId: binding.hookSessionId, cwd: binding.cwd });
    if (saved.targetTaskId !== binding.targetTaskId || saved.targetCwd !== binding.targetCwd)
      throw Object.assign(Error("Binding registry verification failed"), { code: "binding_write_unknown", retrySafe: false });
    return binding;
  });
}

const isDirect = process.argv[1]?.endsWith("configure-binding.mjs");
if (isDirect) {
  try {
    const add = process.argv[2] === "--add";
    const [dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, associationJson] = process.argv.slice(add ? 3 : 2);
    const association = associationJson === undefined ? undefined : JSON.parse(associationJson);
    const binding = (add ? addBinding : createBinding)(dataDir, requestId, workspaceId, sessionId, hookSessionId, cwd, targetTaskId, targetCwd, expiresAt, association);
    console.log(JSON.stringify({ ok: true, code: "binding_created", requestId: binding.requestId }));
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? "binding_write_failed",
      retrySafe: error.retrySafe === true, message: error.message,
      ...(Number.isSafeInteger(error.deltaBytes) ? { deltaBytes: error.deltaBytes } : {}) }) + "\n");
    process.exitCode = 1;
  }
}
