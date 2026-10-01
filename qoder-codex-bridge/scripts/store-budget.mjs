import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

const ALLOWED_TOTAL_BYTES = new Set([20_000_000, 200_000_000]);
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

const fail = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });
const bytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

function canonical(value) {
  let path = normalize(realpathSync.native(resolve(value)));
  if (process.platform === "win32") {
    if (path.startsWith("\\\\?\\UNC\\")) path = `\\\\${path.slice(8)}`;
    else if (path.startsWith("\\\\?\\")) path = path.slice(4);
    path = path.toLowerCase();
  }
  return path;
}

export function storeOwnerId(dataDir) {
  return `qoder-return-store:${createHash("sha256").update(canonical(dataDir)).digest("hex").slice(0, 40)}`;
}

export function bindingReservationBytes(binding) {
  return 16_384 + 8 * bytes(binding);
}

export function messageReservationBytes(intent) {
  return 4_096 + 2 * bytes(intent);
}

function managedName(name) {
  return name === ".message-store.lock"
    || /^binding\.json(?:$|\.lock$|\..+\.tmp$)/.test(name)
    || /^(?:receipt|submission|message)-/.test(name);
}

function managedPath(root, path) {
  const target = resolve(path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !managedName(rel.replaceAll("\\", "/")))
    throw fail("store_path_invalid", "Managed store path is invalid");
  return target;
}

function acquire(path, code) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(path, "", { flag: "wx" }); return; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw fail(code, "Managed store is busy", { retrySafe: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

function withStoreLock(dataDir, callback) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const lock = join(root, ".message-store.lock");
  acquire(lock, "store_budget_busy");
  let result, failure;
  try { result = callback(root); } catch (error) { failure = error; }
  try { unlinkSync(lock); }
  catch { throw fail("store_lock_release_failed", "Managed store lock release failed", { retrySafe: false }); }
  if (failure) throw failure;
  return result;
}

function readStoreConfig(root) {
  let config;
  try { config = JSON.parse(readFileSync(join(root, "store-config.json"), "utf8")); }
  catch (error) {
    throw fail(error.code === "ENOENT" ? "store_budget_not_configured" : "store_budget_config_invalid",
      error.code === "ENOENT" ? "Managed store budget is not configured" : "Managed store budget configuration is invalid");
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.schemaVersion !== 1
      || typeof config.ownerId !== "string" || !OWNER_RE.test(config.ownerId)
      || typeof config.coreCli !== "string" || !isAbsolute(config.coreCli) || !existsSync(config.coreCli)
      || typeof config.registryPath !== "string" || !isAbsolute(config.registryPath))
    throw fail("store_budget_config_invalid", "Managed store budget configuration is invalid");
  const derived = storeOwnerId(root);
  if (config.ownerId !== derived) throw fail("store_budget_owner_mismatch", "Managed store owner does not match its data directory");
  return config;
}

function currentAllocation(root) {
  const config = readStoreConfig(root);
  let output;
  try {
    output = execFileSync(process.execPath,
      [config.coreCli, "--registry", config.registryPath, "budget-status"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw fail("store_budget_unavailable", "Current Core message budget is unavailable");
  }
  let budget;
  try { budget = JSON.parse(output).messageBudget; }
  catch { throw fail("store_budget_unavailable", "Current Core message budget is invalid"); }
  if (budget === null || budget === undefined) throw fail("store_budget_not_configured", "Core message budget is not configured");
  const adaptive = budget?.defaultOwnerBytes !== undefined;
  if (!budget || typeof budget !== "object" || budget.schemaVersion !== 1
      || !Number.isSafeInteger(budget.totalBytes) || budget.totalBytes < 1
      || (adaptive ? !Number.isSafeInteger(budget.defaultOwnerBytes) || budget.defaultOwnerBytes < 1
        || budget.globalLimitBytes !== undefined && (!Number.isSafeInteger(budget.globalLimitBytes)
          || budget.globalLimitBytes < budget.totalBytes)
        : !ALLOWED_TOTAL_BYTES.has(budget.totalBytes) || budget.globalLimitBytes !== undefined)
      || !Array.isArray(budget.allocations) || budget.allocations.length === 0)
    throw fail("store_budget_unavailable", "Current Core message budget is invalid");
  const owners = new Set(); let total = 0, allocatedBytes = null;
  for (const allocation of budget.allocations) {
    if (!allocation || typeof allocation !== "object" || typeof allocation.ownerId !== "string"
        || !OWNER_RE.test(allocation.ownerId) || owners.has(allocation.ownerId)
        || !Number.isSafeInteger(allocation.bytes) || allocation.bytes < 1)
      throw fail("store_budget_unavailable", "Current Core message budget is invalid");
    owners.add(allocation.ownerId); total += allocation.bytes;
    if (!Number.isSafeInteger(total)) throw fail("store_budget_unavailable", "Current Core message budget is invalid");
    if (allocation.ownerId === config.ownerId) allocatedBytes = allocation.bytes;
  }
  if (total !== budget.totalBytes) throw fail("store_budget_unavailable", "Current Core message budget is invalid");
  if (allocatedBytes === null) throw fail("store_budget_owner_unallocated", "Managed store owner has no Core allocation");
  return { ownerId: config.ownerId, allocatedBytes, totalBytes: budget.totalBytes };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function bindingRecords(root) {
  const document = readJson(join(root, "binding.json"));
  if (document === null) return existsSync(join(root, "binding.json")) ? null : [];
  if (document?.schemaVersion === 1) return [document];
  if (document?.schemaVersion === 2 && Array.isArray(document.bindings)) return document.bindings;
  return null;
}

function usage(root, now = Date.now()) {
  let physicalBytes = 0;
  const requestBytes = new Map();
  const messageFiles = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !managedName(entry.name)) continue;
    const path = join(root, entry.name), size = statSync(path).size;
    physicalBytes += size;
    if (entry.name.startsWith("message-")) messageFiles.push({ path, size });
    if (entry.name.startsWith("receipt-") || entry.name.startsWith("submission-")) {
      const parsed = readJson(path);
      const requestId = parsed?.identity?.requestId ?? parsed?.event?.requestId ?? parsed?.requestId;
      if (typeof requestId === "string") requestBytes.set(requestId, (requestBytes.get(requestId) ?? 0) + size);
    }
  }
  const bindings = bindingRecords(root);
  if (bindings === null) throw fail("store_binding_unreadable", "Binding data is unreadable; existing data was preserved");
  const remainingByKey = new Map(); let reservedBytes = 0;
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= now) continue;
    const reserve = bindingReservationBytes(binding);
    const remaining = Math.max(0, reserve - (requestBytes.get(binding.requestId) ?? 0));
    remainingByKey.set(`request:${binding.requestId}`, remaining);
    reservedBytes += remaining;
  }
  const messages = new Map();
  for (const { path, size } of messageFiles) {
    const record = readJson(path), token = record?.selectionToken;
    if (typeof token !== "string") continue;
    const group = messages.get(token) ?? { physicalBytes: 0, intent: null };
    group.physicalBytes += size;
    if (record.state === "dispatch_intent") group.intent ??= record;
    messages.set(token, group);
  }
  for (const [token, group] of messages) {
    if (!group.intent) continue;
    const remaining = Math.max(0, messageReservationBytes(group.intent) - group.physicalBytes);
    remainingByKey.set(`message:${token}`, remaining);
    reservedBytes += remaining;
  }
  return { physicalBytes, reservedBytes, usedBytes: physicalBytes + reservedBytes, remainingByKey };
}

function checkCapacity(root, { additionalBytes, creditKey, newReservationBytes = 0, reservationIncludesWrite = false }) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0 || !Number.isSafeInteger(newReservationBytes) || newReservationBytes < 0)
    throw fail("store_budget_input_invalid", "Managed store byte count is invalid");
  const allocation = currentAllocation(root), current = usage(root);
  if (current.usedBytes > allocation.allocatedBytes)
    throw fail("store_budget_exceeded", "Existing managed data exceeds its Core allocation",
      { deltaBytes: current.usedBytes - allocation.allocatedBytes, retrySafe: false });
  const credit = creditKey ? (current.remainingByKey.get(creditKey) ?? 0) : 0;
  let charge = Math.max(0, additionalBytes - credit);
  if (newReservationBytes) charge = reservationIncludesWrite
    ? Math.max(additionalBytes, newReservationBytes)
    : additionalBytes + newReservationBytes;
  const projectedBytes = current.usedBytes + charge;
  if (projectedBytes > allocation.allocatedBytes)
    throw fail("store_budget_exceeded", "Managed store allocation would be exceeded",
      { deltaBytes: projectedBytes - allocation.allocatedBytes, retrySafe: false });
  return { ...allocation, ...current, additionalBytes: charge, projectedBytes };
}

export function managedStoreStatus(dataDir) {
  return withStoreLock(dataDir, root => ({ ...currentAllocation(root), ...usage(root) }));
}

export function writeManagedExclusive(dataDir, path, data, options = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return withStoreLock(dataDir, root => {
    const target = managedPath(root, path);
    checkCapacity(root, { ...options, additionalBytes: bytes(text) });
    writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
    return target;
  });
}

export function writeManagedAtomic(dataDir, path, data, options = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return withStoreLock(dataDir, root => {
    const target = managedPath(root, path);
    return writeAtomicLocked(root, target, text, options);
  });
}

function writeAtomicLocked(root, target, text, options) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  managedPath(root, temporary);
  checkCapacity(root, { ...options, additionalBytes: bytes(text) });
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
  return target;
}

// A receipt may be sent only by the worker that changes its exact recorded bytes
// to dispatch_intent while holding the same store lock as every other managed write.
export function writeManagedAtomicIf(dataDir, path, expected, data, options = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return withStoreLock(dataDir, root => {
    const target = managedPath(root, path);
    if (readFileSync(target, "utf8") !== expected) return false;
    writeAtomicLocked(root, target, text, options);
    return true;
  });
}

export function removeManaged(dataDir, path) {
  return withStoreLock(dataDir, root => {
    const target = managedPath(root, path);
    try { unlinkSync(target); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
}
