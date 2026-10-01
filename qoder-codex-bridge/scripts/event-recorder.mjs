import { mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { removeManaged, writeManagedAtomic, writeManagedAtomicIf, writeManagedExclusive } from "./store-budget.mjs";

const ALLOWED_HOOKS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]);
const ALLOWED_SIGNALS = new Set([
  "input_observed", "stop_observed", "error_observed",
  "submitted", "accepted", "completed",
  "interrupt_requested", "interrupted",
  "needs_action", "unknown", "verified_turn_result"
]);
const ALLOWED_SOURCES = new Set(["runtime_hook", "native_observation", "native_turn_observation", "model_claim"]);

// Every identifier that reaches a filename must be path-inert: no separators,
// no dots (so no "." / ".."), bounded length. UUIDs and "sess_" ids both fit.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The dispatch marker is only a correlation tag: it may match an operator-created binding,
// never select a target/path/permission or a new binding. A marker is recognised ONLY when a
// whole line is exactly `QODER_RETURN_REQUEST=<id>` (optionally surrounded by horizontal
// whitespace). Line anchoring rejects an in-sentence marker ("do it QODER_... now"), a key
// prefixed into a larger identifier (NOT_QODER_RETURN_REQUEST=...), and a garbled/trailing
// token; the line-based scan in parseMarker makes two standalone markers ambiguous.
const STANDALONE_MARKER_RE = /^[ \t]*QODER_RETURN_REQUEST=([A-Za-z0-9_-]{1,100})[ \t]*$/;

// Send-state machine (durable, plan §4 persistence): recorded -> dispatch_intent -> accepted | uncertain.
// "recorded" means no host send has been dispatched; "dispatch_intent" is persisted BEFORE the host
// call so a crash between intent and ACK is a recognizable unknown, never a silent success.
const SEND_STATES = new Set(["recorded", "dispatch_intent", "accepted", "uncertain"]);
const IDENTITY_FIELDS = ["requestId", "signal", "workspaceId", "sessionId", "hookSessionId", "targetTaskId", "targetCwd", "cwd"];
const VERIFIED_FIELDS = ["ownerId", "deliveryId", "canonicalCwd", "nativeInputId", "nativeTurnId", "assistantId", "terminalOutcome", "evidenceSource"];
const TERMINAL_OUTCOMES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const persistenceFailure = (reason, error) => ({ ok: false, unpersistable: true, reason,
  ...(typeof error?.code === "string" && error.code.startsWith("store_") ? { diagnosticCode: error.code } : {}),
  ...(Number.isSafeInteger(error?.deltaBytes) ? { deltaBytes: error.deltaBytes } : {}) });

// Returns { status: "ok", requestId } | { status: "missing" } | { status: "ambiguous" }.
export function parseMarker(prompt) {
  if (typeof prompt !== "string") return { status: "missing" };
  const ids = [];
  for (const line of prompt.split(/\r?\n/)) {
    const match = STANDALONE_MARKER_RE.exec(line);
    if (match) ids.push(match[1]);
  }
  if (ids.length === 0) return { status: "missing" };
  if (ids.length > 1) return { status: "ambiguous" };
  return { status: "ok", requestId: ids[0] };
}

// SessionStart is observe-only (plan §4: it does not prove a submission was accepted,
// and must never be mistaken for a matched submission). UserPromptSubmit/Stop/StopFailure
// are the only signals this plugin relays; there is no desktop turn-completion hook here.
export function signalForHook(hookEventName) {
  switch (hookEventName) {
    case "UserPromptSubmit": return "input_observed";
    case "Stop": return "stop_observed";
    case "StopFailure": return "error_observed";
    default: return null;
  }
}

export function validateHookInput(input) {
  if (!input || typeof input !== "object") throw Error("Invalid hook input: not an object");
  if (!ALLOWED_HOOKS.has(input.hook_event_name)) throw Error(`Invalid hook_event_name: ${input.hook_event_name}`);
  if (typeof input.session_id !== "string" || !ID_PATTERN.test(input.session_id))
    throw Error("Invalid session_id: must be a path-safe identifier");
  return true;
}

function staysInside(rootDir, targetPath) {
  const rel = relative(resolve(rootDir), resolve(targetPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

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

export function validateBindingRecord(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw Object.assign(Error("Binding invalid"), { code: "host_binding_invalid" });
  if (binding.schemaVersion !== 1) throw Object.assign(Error("Binding schema mismatch"), { code: "host_binding_schema" });
  if (typeof binding.requestId !== "string" || !REQUEST_ID_PATTERN.test(binding.requestId))
    throw Object.assign(Error("Binding requestId invalid"), { code: "host_binding_request" });
  if (typeof binding.workspaceId !== "string" || !binding.workspaceId) throw Object.assign(Error("Binding workspaceId missing"), { code: "host_binding_workspace" });
  if (typeof binding.sessionId !== "string" || !binding.sessionId) throw Object.assign(Error("Binding sessionId missing"), { code: "host_binding_session" });
  if (typeof binding.hookSessionId !== "string" || !ID_PATTERN.test(binding.hookSessionId))
    throw Object.assign(Error("Binding hookSessionId invalid"), { code: "host_binding_hook_session" });
  if (typeof binding.cwd !== "string" || !binding.cwd) throw Object.assign(Error("Binding cwd missing"), { code: "host_binding_cwd" });
  if (typeof binding.targetTaskId !== "string" || !binding.targetTaskId) throw Object.assign(Error("Binding targetTaskId missing"), { code: "host_binding_target" });
  if (typeof binding.targetCwd !== "string" || !binding.targetCwd) throw Object.assign(Error("Binding targetCwd missing"), { code: "host_binding_target_cwd" });
  if (!Number.isFinite(Date.parse(binding.expiresAt))) throw Object.assign(Error("Binding expiry invalid"), { code: "host_binding_expired" });
  const links = [binding.deliveryId, binding.ownerId, binding.correlation];
  if (links.some(value => value !== undefined) && !links.every(value => typeof value === "string" && CORE_ID_PATTERN.test(value)))
    throw Object.assign(Error("Binding message association invalid"), { code: "host_binding_association" });
  if (binding.returnMode !== undefined && binding.returnMode !== "native_turn")
    throw Object.assign(Error("Binding return mode invalid"), { code: "host_binding_mode" });
  if (binding.returnMode === "native_turn" && !links.every(value => typeof value === "string" && CORE_ID_PATTERN.test(value)))
    throw Object.assign(Error("Native turn binding association missing"), { code: "host_binding_association" });
  return binding;
}

function readBindingDocument(dataDir) {
  const path = join(resolve(dataDir), "binding.json");
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw Object.assign(Error("Binding missing"), { code: "host_binding_missing" });
    throw Object.assign(Error("Binding unreadable"), { code: "host_binding_unreadable" });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw Object.assign(Error("Binding invalid"), { code: "host_binding_invalid" });
  if (document.schemaVersion === 1) return { legacy: true, bindings: [validateBindingRecord(document)] };
  if (document.schemaVersion !== 2 || !Array.isArray(document.bindings) || document.bindings.length === 0)
    throw Object.assign(Error("Binding schema mismatch"), { code: "host_binding_schema" });
  return { legacy: false, bindings: document.bindings.map(validateBindingRecord) };
}

export function loadBindings(dataDir) { return readBindingDocument(dataDir).bindings; }

export function loadBinding(dataDir, selector, now = Date.now()) {
  const document = readBindingDocument(dataDir);
  if (selector === undefined) {
    if (!document.legacy) throw Object.assign(Error("Binding selector required"), { code: "host_binding_selector_required" });
    const binding = document.bindings[0];
    if (binding.returnMode === "native_turn") throw Object.assign(Error("Native turn binding is not a Hook route"), { code: "host_binding_native_only" });
    if (Date.parse(binding.expiresAt) <= now) throw Object.assign(Error("Binding expired"), { code: "host_binding_expired" });
    return binding;
  }
  if (!selector || typeof selector !== "object" || typeof selector.requestId !== "string"
      || typeof selector.hookSessionId !== "string" || typeof selector.cwd !== "string")
    throw Object.assign(Error("Binding selector invalid"), { code: "host_binding_selector_invalid" });
  if (document.bindings.filter(binding => binding.requestId === selector.requestId).length > 1)
    throw Object.assign(Error("Binding request ambiguous"), { code: "host_binding_ambiguous" });
  let route;
  try {
    route = document.bindings.filter(binding => binding.hookSessionId === selector.hookSessionId && canonical(binding.cwd) === canonical(selector.cwd));
  } catch {
    throw Object.assign(Error("Binding route invalid"), { code: "host_binding_unmatched" });
  }
  if (route.length > 1) throw Object.assign(Error("Binding route ambiguous"), { code: "host_binding_ambiguous" });
  if (route.length === 0 || route[0].requestId !== selector.requestId)
    throw Object.assign(Error("Binding route unmatched"), { code: "host_binding_unmatched" });
  const binding = route[0];
  if (binding.returnMode === "native_turn") throw Object.assign(Error("Native turn binding is not a Hook route"), { code: "host_binding_native_only" });
  if (Date.parse(binding.expiresAt) <= now) throw Object.assign(Error("Binding expired"), { code: "host_binding_expired" });
  return binding;
}

export function loadNativeBinding(dataDir, requestId, now = Date.now()) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))
    throw Object.assign(Error("Binding selector invalid"), { code: "host_binding_selector_invalid" });
  const bindings = readBindingDocument(dataDir).bindings;
  const matches = bindings.filter(binding => binding.requestId === requestId);
  if (matches.length !== 1) throw Object.assign(Error("Native turn binding not unique"), { code: "host_binding_ambiguous" });
  const binding = matches[0];
  if (binding.returnMode !== "native_turn") throw Object.assign(Error("Not a native turn binding"), { code: "host_binding_native_only" });
  if (bindings.some(other => other !== binding && other.hookSessionId === binding.hookSessionId
      && canonical(other.cwd) === canonical(binding.cwd) && other.returnMode !== "native_turn"))
    throw Object.assign(Error("Native turn route mixes with Hook binding"), { code: "host_binding_ambiguous" });
  if (Date.parse(binding.expiresAt) <= now) throw Object.assign(Error("Binding expired"), { code: "host_binding_expired" });
  return binding;
}

// Keyed by request+stage only: remapping the hook session must NOT create a second
// receipt for the same request/stage (that would let the same notification re-send).
export function receiptFilename(event) {
  return `receipt-${event.signal}-${event.requestId}.json`;
}

// Resolve a receipt/anchor strictly inside the data directory; a crafted filename that
// would escape root (or is absolute) is refused instead of written.
function insideDataDir(rootDir, filename) {
  if (typeof filename !== "string" || filename !== filename.trim() || isAbsolute(filename)
      || filename.includes("/") || filename.includes("\\") || filename.includes("..") || filename.includes("\0"))
    throw Object.assign(Error("Unsafe record name"), { code: "record_path_escape" });
  const target = join(rootDir, filename);
  if (!staysInside(rootDir, target)) throw Object.assign(Error("Unsafe record name"), { code: "record_path_escape" });
  return target;
}

function receiptPathIn(rootDir, filename) { return insideDataDir(rootDir, filename); }
function submissionPathIn(rootDir, hookSessionId) {
  if (typeof hookSessionId !== "string" || !ID_PATTERN.test(hookSessionId))
    throw Object.assign(Error("Unsafe submission anchor"), { code: "record_path_escape" });
  return insideDataDir(rootDir, `submission-${hookSessionId}.json`);
}

// A sidecar that marks the session's anchor as mid-transition / no longer trusted. Its mere
// presence makes the anchor unreadable as a trusted attribution (see readSubmission), so a
// transition whose own write failed cannot leave a stale active anchor that a later call trusts.
function quarantinePathIn(rootDir, hookSessionId) {
  if (typeof hookSessionId !== "string" || !ID_PATTERN.test(hookSessionId))
    throw Object.assign(Error("Unsafe submission anchor"), { code: "record_path_escape" });
  return insideDataDir(rootDir, `submission-${hookSessionId}.quarantined`);
}
function quarantineAnchor(rootDir, hookSessionId, target) {
  const path = quarantinePathIn(rootDir, hookSessionId);
  writeManagedAtomic(rootDir, path, JSON.stringify({
    schemaVersion: 1, hookSessionId, phase: "transition",
    requestId: target.requestId, ambiguous: target.ambiguous, terminal: target.terminal
  }, null, 2), { creditKey: `request:${target.requestId}` });
}
function releaseQuarantine(rootDir, hookSessionId) {
  const path = quarantinePathIn(rootDir, hookSessionId);
  removeManaged(rootDir, path);
}

// Serialize the whole read/decide/write operation, not only the final rename.
// Never reclaim an abandoned lock: an interrupted attribution needs operator review.
// A contender leaves a separate permanent conflict flag; the owner cannot erase it
// while releasing its own transition quarantine or lock.
export function withSubmissionLock(dataDir, hookSessionId, decide) {
  const root = resolve(dataDir);
  const anchorPath = submissionPathIn(root, hookSessionId);
  const busy = `${anchorPath}.busy`;
  const conflict = `${anchorPath}.conflicted`;
  try { writeManagedExclusive(root, busy, ""); }
  catch (error) {
    // Even an EIO on the first lock creation may leave an older active anchor.
    // Fence it independently before returning; a later process must not trust it.
    try { writeManagedExclusive(root, conflict, ""); }
    catch (failure) {
      if (failure.code !== "EEXIST") return persistenceFailure("attribution_unpersistable", failure);
    }
    return error.code === "EEXIST"
      ? { ok: false, reason: "submission_concurrent" }
      : persistenceFailure("attribution_unpersistable", error);
  }
  let result;
  try {
    result = decide();
    if (existsSync(conflict)) result = { ok: false, reason: "submission_concurrent" };
  } catch (error) {
    // Keep our busy marker on an unexpected failure, including failed persistence.
    return persistenceFailure("attribution_unpersistable", error);
  }
  // The pre-existing lock is already persistent. Retain it when ANY transition
  // write fails, including the quarantine itself; a later process cannot reuse
  // the stale anchor merely because the filesystem starts accepting writes again.
  if (result.unpersistable) return result;
  try { removeManaged(root, busy); }
  catch (error) { return persistenceFailure("attribution_unpersistable", error); }
  return result;
}

function identityOf(event, binding) {
  const b = binding || {};
  return {
    requestId: event.requestId ?? null,
    signal: event.signal ?? null,
    workspaceId: event.workspaceId ?? null,
    sessionId: event.sessionId ?? null,
    hookSessionId: event.hookSessionId ?? null,
    targetTaskId: b.targetTaskId ?? null,
    targetCwd: b.targetCwd ?? null,
    cwd: b.cwd ?? null,
  };
}

function identityMatches(a, b) {
  if (!a || !b) return false;
  return IDENTITY_FIELDS.every(key => a[key] === b[key]);
}

// A record is trustworthy only if its stored event agrees with its identity and its send
// markers agree with its state. This stops a forged "accepted" (sent=false / no hostReceipt)
// or an event pointing at a different request/signal from being read back as success.
function validReceiptShape(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.schemaVersion !== 1 || !record.identity || !record.event) return false;
  if (!SEND_STATES.has(record.sendState)) return false;
  const { event, identity } = record;
  if (event.schemaVersion !== 1 || !REQUEST_ID_PATTERN.test(event.requestId)
      || !ALLOWED_SIGNALS.has(event.signal) || !ALLOWED_SOURCES.has(event.source)
      || !Number.isFinite(Date.parse(event.observedAt))
      || !(event.turnId === null || typeof event.turnId === "string")
      || event.evidenceRef !== receiptFilename(event)
      || record.dedupKey !== `${event.requestId}:${event.signal}`
      || !Number.isFinite(Date.parse(record.receivedAt))) return false;
  if (!IDENTITY_FIELDS.every(key => typeof identity[key] === "string" && identity[key].length > 0)) return false;
  const agrees = ["requestId", "signal", "workspaceId", "sessionId", "hookSessionId"]
    .every(key => typeof event[key] === "string" && event[key] === identity[key]);
  if (!agrees) return false;
  if (event.signal === "verified_turn_result") {
    if (event.source !== "native_turn_observation" || !event.data || typeof event.data !== "object"
        || event.turnId !== event.data.nativeTurnId
        || !VERIFIED_FIELDS.every(key => typeof event.data[key] === "string" && event.data[key].length > 0)
        || !TERMINAL_OUTCOMES.has(event.data.terminalOutcome)) return false;
  }
  if (typeof record.sent !== "boolean" || typeof record.dispatchAttempted !== "boolean") return false;
  switch (record.sendState) {
    case "recorded":
      return record.sent === false && record.dispatchAttempted === false;
    case "dispatch_intent":
      return record.sent === false && record.dispatchAttempted === true;
    case "uncertain":
      return record.dispatchAttempted === true;
    case "accepted":
      return record.sent === true && record.dispatchAttempted === true
        && !!record.hostReceipt && typeof record.hostReceipt === "object"
        && record.hostReceipt.threadId === identity.targetTaskId
        && Number.isFinite(Date.parse(record.sentAt));
    default:
      return false;
  }
}

function sameVerifiedEvent(stored, event) {
  return event.signal !== "verified_turn_result" || (stored.source === event.source && stored.turnId === event.turnId
    && VERIFIED_FIELDS.every(key => stored.data?.[key] === event.data?.[key]));
}

export function buildEvent(input, binding, { now = () => new Date() } = {}) {
  const signal = signalForHook(input.hook_event_name);
  if (!signal) throw Error(`Cannot determine signal for ${input.hook_event_name}`);
  const event = {
    schemaVersion: 1,
    requestId: binding.requestId,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
    hookSessionId: input.session_id,
    turnId: null,
    source: "runtime_hook",
    signal,
    observedAt: now().toISOString(),
    evidenceRef: null,
    data: {}
  };
  // evidenceRef is deterministic from already-validated fields, so the caller's
  // original event object carries it into sendNotification (not just a copy).
  event.evidenceRef = receiptFilename(event);
  return event;
}

// Returns { record, deduplicated, conflict, reason }. A malformed or identity-conflicting
// existing receipt is a conflict (never a dedup "success").
export function recordEvent(dataDir, event, { now = () => new Date(), binding } = {}) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const filename = event.evidenceRef || receiptFilename(event);
  const receiptPath = receiptPathIn(root, filename);
  const identity = identityOf(event, binding);
  const record = {
    schemaVersion: 1,
    dedupKey: `${event.requestId}:${event.signal}`,
    identity,
    event: { ...event, evidenceRef: filename },
    receivedAt: now().toISOString(),
    sent: false,
    dispatchAttempted: false,
    sendState: "recorded"
  };
  try {
    writeManagedExclusive(root, receiptPath, JSON.stringify(record, null, 2), { creditKey: `request:${event.requestId}` });
    return { record, deduplicated: false, conflict: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let existing;
    try { existing = JSON.parse(readFileSync(receiptPath, "utf8")); }
    catch { return { record: null, deduplicated: false, conflict: true, reason: "existing_receipt_unreadable" }; }
    if (!validReceiptShape(existing))
      return { record: null, deduplicated: false, conflict: true, reason: "existing_receipt_malformed" };
    if (!identityMatches(existing.identity, identity))
      return { record: existing, deduplicated: false, conflict: true, reason: "identity_conflict" };
    if (!sameVerifiedEvent(existing.event, event))
      return { record: existing, deduplicated: false, conflict: true, reason: "native_fact_conflict" };
    // Same request/stage identity: honor the prior durable state, never re-send here.
    return { record: existing, deduplicated: true, conflict: false };
  }
}

function updateReceipt(dataDir, event, binding, mutate) {
  try {
    const receiptPath = receiptPathIn(resolve(dataDir), event.evidenceRef || receiptFilename(event));
    const record = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!validReceiptShape(record)) return false;
    if (!identityMatches(record.identity, identityOf(event, binding))) return false;
    if (!sameVerifiedEvent(record.event, event)) return false;
    mutate(record);
    writeManagedAtomic(dataDir, receiptPath, JSON.stringify(record, null, 2), { creditKey: `request:${event.requestId}` });
    return true;
  } catch { return false; }
}

// Persist the intent to dispatch BEFORE the host send call. Returning false means the
// caller must NOT proceed to send (unknown send must remain recognizable on restart).
export function markDispatchIntent(dataDir, event, binding) {
  try {
    const path = receiptPathIn(resolve(dataDir), event.evidenceRef || receiptFilename(event));
    const raw = readFileSync(path, "utf8"), record = JSON.parse(raw);
    if (!validReceiptShape(record) || !identityMatches(record.identity, identityOf(event, binding))
        || !sameVerifiedEvent(record.event, event) || record.sendState !== "recorded") return false;
    record.dispatchAttempted = true;
    record.sendState = "dispatch_intent";
    record.dispatchIntentAt = new Date().toISOString();
    return writeManagedAtomicIf(dataDir, path, raw, JSON.stringify(record, null, 2), { creditKey: `request:${event.requestId}` });
  } catch { return false; }
}

// Only a durable, verified update to "accepted" counts as success. Any parse/write/identity
// failure returns false so the caller can refuse to claim the notification landed.
export function markSent(dataDir, event, binding, receipt) {
  return updateReceipt(dataDir, event, binding, record => {
    record.sent = true;
    record.dispatchAttempted = true;
    record.sendState = "accepted";
    record.hostReceipt = { threadId: receipt.threadId };
    record.sentAt = new Date().toISOString();
  });
}

export function markSendUncertain(dataDir, event, binding, error) {
  return updateReceipt(dataDir, event, binding, record => {
    record.sent = false;
    record.dispatchAttempted = true;
    record.sendState = "uncertain";
    record.sendError = String(error?.message ?? "unknown").slice(0, 200);
  });
}

// --- matched-submission anchor (per in-flight request attribution, plan §4) ---

// The full anchor shape is required for any attribution decision: a partial or forged
// record (missing cwd/ambiguous/terminal, or a hookSessionId that is not this session)
// is invalid and can never authorize a notification.
function validSubmission(parsed, hookSessionId) {
  return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.schemaVersion === 1
    && typeof parsed.requestId === "string" && REQUEST_ID_PATTERN.test(parsed.requestId)
    && parsed.hookSessionId === hookSessionId && ID_PATTERN.test(hookSessionId)
    && typeof parsed.cwd === "string" && parsed.cwd
    && typeof parsed.ambiguous === "boolean"
    && typeof parsed.terminal === "boolean";
}

function sameSubmission(a, b) {
  return a.requestId === b.requestId && a.hookSessionId === b.hookSessionId && a.cwd === b.cwd
    && a.ambiguous === b.ambiguous && a.terminal === b.terminal;
}

function verifySubmission(path, expected) {
  let got;
  try { got = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  return validSubmission(got, expected.hookSessionId) && sameSubmission(got, expected);
}

// null when no anchor exists; { invalid: true } on any unreadable/malformed record so the
// caller fails closed rather than trusting a stale attribution.
export function readSubmission(dataDir, hookSessionId) {
  const root = resolve(dataDir);
  let path, quarantinePath;
  try { path = submissionPathIn(root, hookSessionId); quarantinePath = quarantinePathIn(root, hookSessionId); }
  catch { return { invalid: true }; }
  if (existsSync(`${path}.conflicted`)) return { invalid: true, conflicted: true };
  // A durable transition marker outranks the anchor file: while it exists this session's
  // attribution is untrusted, even if the anchor on disk still reads as a valid active record.
  if (existsSync(quarantinePath)) return { invalid: true, quarantined: true };
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; return { invalid: true }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { invalid: true }; }
  return validSubmission(parsed, hookSessionId) ? parsed : { invalid: true };
}

// Exclusive create is the cross-process arbitration primitive: only one process may open the
// session's single in-flight submission. Returns { created, conflict, error }; the winner is
// confirmed by a read-after-write so a silent partial write can never open attribution.
export function createSubmission(dataDir, { requestId, hookSessionId, cwd }, { now = () => new Date() } = {}) {
  const path = submissionPathIn(resolve(dataDir), hookSessionId);
  const anchor = { schemaVersion: 1, requestId, hookSessionId, cwd, ambiguous: false, terminal: false, observedAt: now().toISOString() };
  try {
    writeManagedExclusive(dataDir, path, JSON.stringify(anchor, null, 2), { creditKey: `request:${requestId}` });
  } catch (error) {
    if (error.code === "EEXIST") return { created: false, conflict: true, error: false };
    return { created: false, conflict: false, error: true,
      ...(typeof error.code === "string" && error.code.startsWith("store_") ? { diagnosticCode: error.code } : {}),
      ...(Number.isSafeInteger(error.deltaBytes) ? { deltaBytes: error.deltaBytes } : {}) };
  }
  return { created: verifySubmission(path, anchor), conflict: false, error: false };
}

// Every anchor transition must be durable AND confirmed. Returning false means the caller
// cannot trust the transition and must fail closed — never announce a state it could not record.
export function updateSubmission(dataDir, hookSessionId, mutate) {
  const root = resolve(dataDir);
  const current = readSubmission(dataDir, hookSessionId);
  if (!current || current.invalid) return false;
  const next = { ...current };
  try { mutate(next); } catch { return false; }
  if (!validSubmission(next, hookSessionId)) return false;
  // Durable, cross-call "no longer trusted" evidence BEFORE attribution changes: if the rename
  // below fails we still return false but leave the marker, so a later call cannot re-read the
  // stale active anchor as a trusted attribution.
  try { quarantineAnchor(root, hookSessionId, next); } catch { return false; }
  const path = submissionPathIn(root, hookSessionId);
  try { writeManagedAtomic(root, path, JSON.stringify(next, null, 2), { creditKey: `request:${next.requestId}` }); } catch { return false; }
  if (!verifySubmission(path, next)) return false;
  // The new state is durably verified; release the fence best-effort. A failed release keeps the
  // anchor quarantined (conservative distrust that never re-authorizes a send), which is safe.
  try { releaseQuarantine(root, hookSessionId); } catch {}
  return true;
}

export { ALLOWED_HOOKS, ALLOWED_SIGNALS, ALLOWED_SOURCES, ID_PATTERN, REQUEST_ID_PATTERN, IDENTITY_FIELDS };
