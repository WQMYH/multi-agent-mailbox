import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { loadBindings, loadNativeBinding, receiptFilename, recordEvent } from "./event-recorder.mjs";
import { sendNotification } from "./host-notifier.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OUTCOMES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const IDENTITY = ["ownerId", "deliveryId", "requestId", "workspaceId", "sessionId"];
const BINDING_IDENTITY = ["requestId", "deliveryId", "ownerId", "workspaceId", "sessionId", "hookSessionId",
  "cwd", "targetTaskId", "targetCwd", "expiresAt", "correlation", "returnMode"];
// ponytail: bound one reconcile pass; split store ownership if a scope needs more live bindings.
const MAX_NATIVE_BINDINGS = 64;

function canonical(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw Error("Native turn cwd invalid");
  let path = normalize(realpathSync.native(resolve(value)));
  if (process.platform === "win32") {
    if (path.startsWith("\\\\?\\UNC\\")) path = `\\\\${path.slice(8)}`;
    else if (path.startsWith("\\\\?\\")) path = path.slice(4);
    path = path.toLowerCase();
  }
  return path;
}

function verifiedFact(fact, binding, scope, cwd) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) return false;
  if (!IDENTITY.every(key => fact[key] === binding[key])) return false;
  if (fact.ownerId !== scope.ownerId || fact.workspaceId !== scope.workspaceId) return false;
  try { if (canonical(fact.canonicalCwd) !== cwd) return false; } catch { return false; }
  if (!["nativeInputId", "nativeTurnId", "assistantId", "evidenceSource"].every(key => typeof fact[key] === "string" && ID.test(fact[key]))) return false;
  return OUTCOMES.has(fact.terminalOutcome);
}

function eventOf(binding, fact, cwd) {
  const event = {
    schemaVersion: 1,
    requestId: binding.requestId,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
    hookSessionId: binding.hookSessionId,
    turnId: fact.nativeTurnId,
    source: "native_turn_observation",
    signal: "verified_turn_result",
    observedAt: new Date().toISOString(),
    evidenceRef: null,
    data: {
      ownerId: binding.ownerId, deliveryId: binding.deliveryId, canonicalCwd: cwd,
      nativeInputId: fact.nativeInputId, nativeTurnId: fact.nativeTurnId,
      assistantId: fact.assistantId, terminalOutcome: fact.terminalOutcome,
      evidenceSource: fact.evidenceSource
    }
  };
  event.evidenceRef = receiptFilename(event);
  return event;
}

// Internal provider integration only. observeTurn is responsible for verifying native
// history and finality; a model-supplied JSON "verified" flag has no standing here.
export async function reconcileVerifiedReturns({ dataDir, scope, observeTurn, assertActive }) {
  if (typeof dataDir !== "string" || !isAbsolute(dataDir) || !scope || typeof scope !== "object"
      || typeof scope.ownerId !== "string" || !ID.test(scope.ownerId)
      || typeof scope.workspaceId !== "string" || !ID.test(scope.workspaceId)
      || typeof observeTurn !== "function" || typeof assertActive !== "function")
    throw Error("Native turn return context invalid");
  const cwd = canonical(scope.canonicalCwd);
  const active = async () => {
    try { if (await assertActive() === false) throw Error(); }
    catch { throw Object.assign(Error("Provider inactive"), { code: "provider_inactive" }); }
  };
  let bindings;
  try { bindings = loadBindings(dataDir); }
  catch (error) { if (error.code === "host_binding_missing") return []; throw error; }
  const candidates = [];
  for (const binding of bindings) {
    if (binding.returnMode !== "native_turn" || binding.ownerId !== scope.ownerId
        || binding.workspaceId !== scope.workspaceId || Date.parse(binding.expiresAt) <= Date.now()) continue;
    try { if (canonical(binding.cwd) === cwd) candidates.push({ binding }); }
    catch { candidates.push({ binding, pathUnavailable: true }); }
  }
  if (candidates.length > MAX_NATIVE_BINDINGS) throw Error("Native turn binding scope exceeds one bounded reconcile pass");
  const results = [];
  for (const { binding, pathUnavailable } of candidates) {
    await active();
    if (pathUnavailable) { results.push({ requestId: binding.requestId, state: "binding_path_unavailable" }); continue; }
    let fact;
    try { fact = await observeTurn({ requestId: binding.requestId, deliveryId: binding.deliveryId, sessionId: binding.sessionId }); }
    catch {
      await active();
      results.push({ requestId: binding.requestId, state: "observation_unavailable" });
      continue;
    }
    if (fact === null) { results.push({ requestId: binding.requestId, state: "nonterminal" }); continue; }
    if (!verifiedFact(fact, binding, scope, cwd)) { results.push({ requestId: binding.requestId, state: "unverified" }); continue; }
    await active();
    let current;
    try { current = loadNativeBinding(dataDir, binding.requestId); }
    catch (error) { results.push({ requestId: binding.requestId, state: error.code ?? "binding_unavailable" }); continue; }
    if (!BINDING_IDENTITY.every(key => current[key] === binding[key])) {
      results.push({ requestId: binding.requestId, state: "binding_changed" }); continue;
    }
    const event = eventOf(binding, fact, cwd);
    let recorded;
    try { recorded = recordEvent(dataDir, event, { binding }); }
    catch (error) { results.push({ requestId: binding.requestId, state: error.code ?? "record_unpersistable" }); continue; }
    if (recorded.conflict) { results.push({ requestId: binding.requestId, state: recorded.reason }); continue; }
    if (recorded.deduplicated && recorded.record.sendState !== "recorded") {
      results.push({ requestId: binding.requestId, state: recorded.record.sendState }); continue;
    }
    await active();
    try {
      const receipt = await sendNotification(binding, dataDir, event, { assertActive });
      results.push({ requestId: binding.requestId, state: "accepted", targetTaskId: receipt.threadId });
    } catch (error) {
      if (error.code === "provider_inactive") throw error;
      results.push({ requestId: binding.requestId, state: error.dispatched ? "send_uncertain" : error.code ?? "not_dispatched" });
    }
  }
  return results;
}
