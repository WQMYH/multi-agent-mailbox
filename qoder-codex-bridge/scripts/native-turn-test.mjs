import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createBinding, addBinding } from "./configure-binding.mjs";
import { loadBinding, validReceiptShape } from "./event-recorder.mjs";
import { managedStoreStatus, storeOwnerId } from "./store-budget.mjs";
import { reconcileVerifiedReturns } from "./native-turn-return.mjs";
import { handle } from "../hooks/handler.mjs";

const root = mkdtempSync(join(tmpdir(), "qoder-codex-bridge-"));
const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = "96003604-76a9-400e-9e50-c7b752977391";
const sessionId = "00000000-0000-4000-8000-000000000020";
const ownerId = "qoder.queue.owner";
const expiresAt = "2030-01-01T00:00:00Z";
const requestA = "request-A", requestB = "request-B";
const targetA = "00000000-0000-4000-8000-000000000030";
const targetB = "00000000-0000-4000-8000-000000000040";
const source = join(root, "source"), targetDirA = join(root, "target-A"), targetDirB = join(root, "target-B");
mkdirSync(source); mkdirSync(targetDirA); mkdirSync(targetDirB);
const scope = { ownerId, workspaceId, canonicalCwd: realpathSync.native(source) };
const coreCli = join(root, "core-cli.mjs");
writeFileSync(coreCli, `import { readFileSync } from "node:fs";
const i = process.argv.indexOf("--registry");
if (i < 0 || process.argv.at(-1) !== "budget-status") process.exit(2);
process.stdout.write(JSON.stringify({ messageBudget: JSON.parse(readFileSync(process.argv[i + 1], "utf8")).messageBudget }) + "\\n");
`);

const adapter = join(root, "adapter.mjs");
writeFileSync(adapter, `import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const content = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") { reply(message.id, { protocolVersion: "2025-06-18" }); continue; }
  if (message.method !== "tools/call") continue;
  if (message.params._meta?.codexThreadId !== ${JSON.stringify(targetA)}) process.exit(3);
  const { name, arguments: args } = message.params;
  if (name === "read_thread") {
    const targets = JSON.parse(readFileSync(join(root, "targets.json"), "utf8"));
    reply(message.id, content({ thread: { id: args.threadId, cwd: targets[args.threadId] } }));
  } else if (name === "send_message_to_thread") {
    writeFileSync(join(root, "sent-" + randomUUID() + ".json"), JSON.stringify(args), { flag: "wx" });
    if (existsSync(join(root, "host-lost-ack"))) process.exit(1);
    reply(message.id, content({ threadId: args.threadId }));
  } else process.exit(4);
}
`);
writeFileSync(join(root, "targets.json"), JSON.stringify({ [targetA]: targetDirA, [targetB]: targetDirB }));

function fixture(name) {
  const dir = join(root, name); mkdirSync(dir);
  const registryPath = join(dir, "registry.json"), allocatedBytes = 20_000_000;
  const storeOwner = storeOwnerId(dir);
  writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: allocatedBytes,
    allocations: [{ ownerId: storeOwner, bytes: allocatedBytes }] } }));
  writeFileSync(join(dir, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId: storeOwner, coreCli, registryPath }));
  return dir;
}
function bind(dir, requestId, targetTaskId, deliveryId) {
  return addBinding(dir, requestId, workspaceId, sessionId, sessionId, source, targetTaskId,
    targetTaskId === targetA ? targetDirA : targetDirB, undefined,
    { ownerId, deliveryId, correlation: "native-turn", returnMode: "native_turn" });
}
function fact(binding) {
  return { ownerId, deliveryId: binding.deliveryId, requestId: binding.requestId, workspaceId, sessionId,
    canonicalCwd: scope.canonicalCwd, nativeInputId: `input:${binding.requestId}`,
    nativeTurnId: `turn:${binding.requestId}`, assistantId: `assistant:${binding.requestId}`,
    terminalOutcome: "completed", evidenceSource: "native_history" };
}
function host(dir) {
  writeFileSync(join(dir, "host-config.json"), JSON.stringify({ script: adapter, pipePath: "\\\\.\\pipe\\fixture-only",
    threadId: targetA, cwd: targetDirA, expiresAt }));
}
const sent = () => readdirSync(root).filter(name => name.startsWith("sent-")).map(name => JSON.parse(readFileSync(join(root, name), "utf8")));
const receipt = (dir, requestId) => JSON.parse(readFileSync(join(dir, `receipt-verified_turn_result-${requestId}.json`), "utf8"));
const observe = facts => async ({ requestId }) => facts[requestId] ?? null;
const active = () => true;

const workerPath = join(root, "worker.mjs");
writeFileSync(workerPath, `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { reconcileVerifiedReturns } from ${JSON.stringify(pathToFileURL(join(here, "native-turn-return.mjs")).href)};
const [dir, factsJson, barrier] = process.argv.slice(2), facts = JSON.parse(factsJson);
const result = await reconcileVerifiedReturns({ dataDir: dir, scope: JSON.parse(readFileSync(join(dir, "scope.json"), "utf8")),
  observeTurn: async ({ requestId }) => {
    if (barrier === "barrier") {
      writeFileSync(join(dir, "ready-" + process.pid), "", { flag: "wx" });
      while (!existsSync(join(dir, "go"))) await setTimeout(10);
    }
    return facts[requestId] ?? null;
  }, assertActive: () => true });
process.stdout.write(JSON.stringify(result) + "\\n");
`);
function worker(dir, facts, barrier = "none") {
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [workerPath, dir, JSON.stringify(facts), barrier],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolveWorker(JSON.parse(out)) : reject(Error(`worker exit ${code}: ${err}`)));
  });
}
async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("worker barrier timeout");
    await new Promise(done => setTimeout(done, 20));
  }
}

try {
  // Retained, delivered history must not exhaust the limit for new live work.
  const history = fixture("accepted-history"); host(history);
  const historyBindings = Array.from({ length: 64 }, (_, i) => bind(history, `history-${i + 1}`, targetA, `delivery-history-${i + 1}`));
  const historyFacts = Object.fromEntries(historyBindings.map(b => [b.requestId, fact(b)]));
  const beforeHistory = sent().length;
  const delivered = await reconcileVerifiedReturns({ dataDir: history, scope, observeTurn: observe(historyFacts), assertActive: active });
  assert.equal(delivered.length, 64);
  assert(delivered.every(result => result.state === "accepted"));
  assert.equal(sent().length, beforeHistory + 64);
  const historyBytes = Object.fromEntries(historyBindings.map(b => {
    assert(validReceiptShape(receipt(history, b.requestId)));
    return [b.requestId, readFileSync(join(history, `receipt-verified_turn_result-${b.requestId}.json`), "utf8")];
  }));
  const next = bind(history, "history-65", targetB, "delivery-history-65");
  const historyBudget = managedStoreStatus(history);
  assert(historyBudget.usedBytes < historyBudget.allocatedBytes);
  const observedHistory = [];
  const nextResult = await reconcileVerifiedReturns({ dataDir: history, scope,
    observeTurn: async ({ requestId }) => { observedHistory.push(requestId); return requestId === next.requestId ? fact(next) : historyFacts[requestId]; },
    assertActive: active });
  assert.deepEqual(observedHistory, [next.requestId]);
  assert.equal(nextResult.find(result => result.requestId === next.requestId).state, "accepted");
  assert.equal(sent().length, beforeHistory + 65);
  assert.equal(sent().filter(message => message.threadId === targetB).length, 1);
  assert(validReceiptShape(receipt(history, next.requestId)));
  assert.equal(receipt(history, next.requestId).identity.targetTaskId, targetB);
  assert.equal(receipt(history, next.requestId).event.data.deliveryId, next.deliveryId);
  historyBytes[next.requestId] = readFileSync(join(history, `receipt-verified_turn_result-${next.requestId}.json`), "utf8");
  const registryBytes = readFileSync(join(history, "binding.json"), "utf8");
  let historyObservations = 0;
  const historical = await reconcileVerifiedReturns({ dataDir: history, scope,
    observeTurn: async () => { historyObservations++; return null; }, assertActive: active });
  assert.equal(historical.length, 65);
  assert(historical.every(result => result.state === "accepted"));
  assert.equal(historyObservations, 0);
  assert.equal(sent().length, beforeHistory + 65);
  for (const [id, bytes] of Object.entries(historyBytes))
    assert.equal(readFileSync(join(history, `receipt-verified_turn_result-${id}.json`), "utf8"), bytes);
  assert.equal(readFileSync(join(history, "binding.json"), "utf8"), registryBytes);
  console.log("QTC-01: 64 delivered histories + request 65 accepted once; 65 histories repeat with 0 observations/0 sends and unchanged records");

  // An accepted label alone must not bypass receipt integrity or binding identity.
  const nextPath = join(history, `receipt-verified_turn_result-${next.requestId}.json`);
  const nextReceipt = JSON.parse(historyBytes[next.requestId]);
  for (const [changed, expected] of [
    [{ ...nextReceipt, identity: { ...nextReceipt.identity, targetCwd: targetDirA } }, "identity_conflict"],
    [{ ...nextReceipt, event: { ...nextReceipt.event, data: { ...nextReceipt.event.data, deliveryId: "wrong-delivery" } } }, "native_fact_conflict"],
    [{ ...nextReceipt, sent: false }, "existing_receipt_malformed"]
  ]) {
    writeFileSync(nextPath, JSON.stringify(changed));
    const changedBytes = readFileSync(nextPath, "utf8"), seen = [];
    const rejected = await reconcileVerifiedReturns({ dataDir: history, scope,
      observeTurn: async ({ requestId }) => { seen.push(requestId); return fact(next); }, assertActive: active });
    assert.deepEqual(seen, [next.requestId]);
    assert.equal(rejected.find(result => result.requestId === next.requestId).state, expected);
    assert.equal(sent().length, beforeHistory + 65);
    assert.equal(readFileSync(nextPath, "utf8"), changedBytes);
    writeFileSync(nextPath, historyBytes[next.requestId]);
  }

  const overflow = fixture("live-limit"); host(overflow);
  for (let i = 1; i <= 65; i++) bind(overflow, `pending-${i}`, targetA, `delivery-pending-${i}`);
  let overflowObserved = 0;
  await assert.rejects(reconcileVerifiedReturns({ dataDir: overflow, scope,
    observeTurn: async () => { overflowObserved++; return null; }, assertActive: active }), /exceeds one bounded reconcile pass/);
  assert.equal(overflowObserved, 0);
  assert.equal(sent().length, beforeHistory + 65);
  assert(!existsSync(join(overflow, "receipt-verified_turn_result-pending-1.json")));

  const dir = fixture("two-requests"); host(dir);
  const a = bind(dir, requestA, targetA, "delivery-A");
  assert.equal(Object.hasOwn(a, "expiresAt"), false);
  const b = bind(dir, requestB, targetB, "delivery-B");
  assert.throws(() => bind(dir, requestA, targetB, "delivery-remap"), e => e.code === "binding_request_exists");
  assert.throws(() => loadBinding(dir, { requestId: requestA, hookSessionId: sessionId, cwd: source }), e => e.code === "host_binding_ambiguous");
  const before = sent().length;
  const lateStop = await handle({ hook_event_name: "Stop", session_id: sessionId, cwd: source }, { dataDir: dir });
  assert.equal(lateStop.state, "uncorrelated"); assert.equal(sent().length, before);
  assert.deepEqual((await reconcileVerifiedReturns({ dataDir: dir, scope, observeTurn: observe({}), assertActive: active })).map(x => x.state),
    ["nonterminal", "nonterminal"]);
  assert.equal(sent().length, before);
  const bad = await reconcileVerifiedReturns({ dataDir: dir, scope, observeTurn: observe({ [requestA]: { ...fact(a), nativeTurnId: "" } }), assertActive: active });
  assert.equal(bad[0].state, "unverified"); assert.equal(sent().length, before);
  const nonterminalClaim = await reconcileVerifiedReturns({ dataDir: dir, scope,
    observeTurn: observe({ [requestA]: { ...fact(a), terminalOutcome: "running" } }), assertActive: active });
  assert.equal(nonterminalClaim[0].state, "unverified"); assert.equal(sent().length, before);
  assert.deepEqual(await reconcileVerifiedReturns({ dataDir: dir, scope: { ...scope, ownerId: "other.owner" },
    observeTurn: observe({ [requestA]: fact(a) }), assertActive: active }), []);
  assert.equal(sent().length, before);
  await assert.rejects(reconcileVerifiedReturns({ dataDir: dir, scope,
    observeTurn: observe({ [requestA]: fact(a) }), assertActive: () => false }), /Provider inactive/);
  assert.equal(sent().length, before);
  const both = await reconcileVerifiedReturns({ dataDir: dir, scope, observeTurn: observe({ [requestA]: fact(a), [requestB]: fact(b) }), assertActive: active });
  assert.deepEqual(both.map(x => x.state), ["accepted", "accepted"]);
  assert.deepEqual(new Set(sent().map(x => x.threadId)), new Set([targetA, targetB]));
  assert.equal(receipt(dir, requestA).event.data.nativeTurnId, fact(a).nativeTurnId);
  assert.equal(receipt(dir, requestB).identity.targetTaskId, targetB);
  assert.equal((await reconcileVerifiedReturns({ dataDir: dir, scope, observeTurn: observe({ [requestA]: fact(a), [requestB]: fact(b) }), assertActive: active }))[0].state, "accepted");
  assert.equal(sent().length, before + 2);
  assert.equal((await reconcileVerifiedReturns({ dataDir: dir, scope,
    observeTurn: async () => { throw Error("delivered history must not be observed again"); },
    assertActive: active }))[0].state, "accepted");
  assert.equal(sent().length, before + 2);

  const recover = fixture("recover"); const r = bind(recover, "request-recover", targetA, "delivery-recover");
  writeFileSync(join(recover, "scope.json"), JSON.stringify(scope));
  assert.equal((await worker(recover, { [r.requestId]: fact(r) }))[0].state, "host_config_missing");
  assert.equal(receipt(recover, r.requestId).sendState, "recorded");
  host(recover);
  const first = worker(recover, { [r.requestId]: fact(r) }, "barrier");
  const second = worker(recover, { [r.requestId]: fact(r) }, "barrier");
  await waitFor(() => readdirSync(recover).filter(name => name.startsWith("ready-")).length === 2);
  writeFileSync(join(recover, "go"), "");
  const race = [...await Promise.all([first, second])];
  assert.equal(race.filter(x => x[0].state === "accepted").length, 1);
  assert.equal(sent().length, before + 3);
  assert.equal(receipt(recover, r.requestId).sendState, "accepted");

  const unknown = fixture("lost-ack"); const u = bind(unknown, "request-unknown", targetA, "delivery-unknown"); host(unknown);
  writeFileSync(join(unknown, "scope.json"), JSON.stringify(scope));
  writeFileSync(join(root, "host-lost-ack"), "");
  const beforeUnknown = sent().length;
  assert.equal((await worker(unknown, { [u.requestId]: fact(u) }))[0].state, "send_uncertain");
  assert.equal(sent().length, beforeUnknown + 1);
  rmSync(join(root, "host-lost-ack"));
  const uncertainBytes = readFileSync(join(unknown, `receipt-verified_turn_result-${u.requestId}.json`), "utf8");
  assert.equal((await worker(unknown, { [u.requestId]: fact(u) }))[0].state, "uncertain");
  assert.equal(sent().length, beforeUnknown + 1);
  assert.equal(readFileSync(join(unknown, `receipt-verified_turn_result-${u.requestId}.json`), "utf8"), uncertainBytes);
  const oldUnknownReceipt = readFileSync(join(unknown, `receipt-verified_turn_result-${u.requestId}.json`), "utf8");
  const unknownDocument = JSON.parse(readFileSync(join(unknown, "binding.json"), "utf8"));
  unknownDocument.bindings[0].expiresAt = "2000-01-01T00:00:00Z";
  writeFileSync(join(unknown, "binding.json"), JSON.stringify(unknownDocument));
  const oldUnknownBinding = readFileSync(join(unknown, "binding.json"), "utf8");
  assert.deepEqual(await worker(unknown, { [u.requestId]: fact(u) }), []);
  assert.equal(sent().length, beforeUnknown + 1);
  assert.equal(readFileSync(join(unknown, `receipt-verified_turn_result-${u.requestId}.json`), "utf8"), oldUnknownReceipt);
  assert.equal(readFileSync(join(unknown, "binding.json"), "utf8"), oldUnknownBinding);

  const legacy = fixture("legacy");
  const old = createBinding(legacy, "legacy-request", workspaceId, sessionId, sessionId, source, targetA, targetDirA, expiresAt);
  assert.equal(loadBinding(legacy).requestId, old.requestId);
  assert.throws(() => bind(legacy, "native-after-legacy", targetB, "delivery-new"), e => e.code === "binding_route_exists");
  if (process.platform === "win32") assert.throws(() => addBinding(legacy, "native-alias", workspaceId, sessionId,
    sessionId, `\\\\?\\${source}`, targetB, targetDirB, expiresAt,
    { ownerId, deliveryId: "delivery-alias", correlation: "native-turn", returnMode: "native_turn" }),
    e => e.code === "binding_route_exists");
  const expired = fixture("expired"); const e = bind(expired, "request-expired", targetA, "delivery-expired"); host(expired);
  const document = JSON.parse(readFileSync(join(expired, "binding.json"), "utf8"));
  document.bindings[0].expiresAt = "2000-01-01T00:00:00Z";
  writeFileSync(join(expired, "binding.json"), JSON.stringify(document));
  const expiredBytes = readFileSync(join(expired, "binding.json"), "utf8"), beforeExpired = sent().length;
  let expiredObserved = 0;
  assert.deepEqual(await reconcileVerifiedReturns({ dataDir: expired, scope,
    observeTurn: async () => { expiredObserved++; return fact(e); }, assertActive: active }), []);
  assert.equal(expiredObserved, 0);
  assert.equal(sent().length, beforeExpired);
  assert.equal(readFileSync(join(expired, "binding.json"), "utf8"), expiredBytes);

  const observation = fixture("observation-isolation"); host(observation);
  const observedA = bind(observation, "observe-A", targetA, "delivery-observe-A");
  const observedB = bind(observation, "observe-B", targetB, "delivery-observe-B");
  const seen = [], beforeObservation = sent().length;
  const isolated = await reconcileVerifiedReturns({ dataDir: observation, scope,
    observeTurn: async ({ requestId }) => {
      seen.push(requestId);
      if (requestId === observedA.requestId) throw Error("private native history detail");
      return fact(observedB);
    }, assertActive: active });
  assert.deepEqual(seen, [observedA.requestId, observedB.requestId]);
  assert.deepEqual(isolated.map(result => result.state), ["observation_unavailable", "accepted"]);
  assert.equal(sent().length, beforeObservation + 1);
  assert(!JSON.stringify(isolated).includes("private native history detail"));

  const staleCwd = join(root, "stale-cwd"); mkdirSync(staleCwd);
  const pathIsolation = fixture("path-isolation"); host(pathIsolation);
  addBinding(pathIsolation, "stale-A", workspaceId, sessionId, sessionId, staleCwd,
    targetA, targetDirA, expiresAt, { ownerId, deliveryId: "delivery-stale-A", correlation: "native-turn", returnMode: "native_turn" });
  const liveB = bind(pathIsolation, "live-B", targetB, "delivery-live-B");
  if (dirname(resolve(staleCwd)) !== resolve(root)) throw Error("Unexpected stale cwd fixture path");
  rmdirSync(staleCwd);
  const seenPaths = [], beforePath = sent().length;
  const pathResults = await reconcileVerifiedReturns({ dataDir: pathIsolation, scope,
    observeTurn: async ({ requestId }) => { seenPaths.push(requestId); return fact(liveB); }, assertActive: active });
  assert.deepEqual(pathResults.map(result => result.state), ["binding_path_unavailable", "accepted"]);
  assert.deepEqual(seenPaths, [liveB.requestId]);
  assert.equal(sent().length, beforePath + 1);

  const inactive = fixture("inactive-after-observation"); host(inactive);
  const inactiveA = bind(inactive, "inactive-A", targetA, "delivery-inactive-A");
  bind(inactive, "inactive-B", targetB, "delivery-inactive-B");
  let providerActive = true;
  const seenBeforeStop = [], beforeInactive = sent().length;
  await assert.rejects(reconcileVerifiedReturns({ dataDir: inactive, scope,
    observeTurn: async ({ requestId }) => {
      seenBeforeStop.push(requestId);
      providerActive = false;
      throw Error("private scope failure detail");
    }, assertActive: () => providerActive }),
  error => error.code === "provider_inactive" && error.message === "Provider inactive");
  assert.deepEqual(seenBeforeStop, [inactiveA.requestId]);
  assert.equal(sent().length, beforeInactive);

  console.log("native turn return: same-route targets, isolated observation/path errors, global lease stop, late Stop, cross-process claim, lost ACK and legacy boundaries passed");
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("qoder-codex-bridge-"))
    throw Error("Refusing to remove an unexpected fixture path");
  rmSync(root, { recursive: true, force: true });
}
