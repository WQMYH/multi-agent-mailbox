import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALLOWED_HOOKS, ALLOWED_SIGNALS, ALLOWED_SOURCES,
  buildEvent, loadBinding, loadBindings, receiptFilename, recordEvent, signalForHook,
  validateHookInput, parseMarker, readSubmission, createSubmission, updateSubmission, markSent
} from "./event-recorder.mjs";
import { buildNotificationPrompt, HostClient, loadHostConfig, sendNotification } from "./host-notifier.mjs";
import { handle } from "../hooks/handler.mjs";
import { addBinding, createBinding } from "./configure-binding.mjs";
import {
  bindingReservationBytes, managedStoreStatus, messageReservationBytes,
  storeOwnerId, writeManagedAtomic, writeManagedExclusive
} from "./store-budget.mjs";
import { validateManifestObject, validateHooksObject, validatePluginConfig } from "./validate-config.mjs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Real rename-fault injection: wrap fs.renameSync so a rename to a matching target throws EIO,
// then syncBuiltinESMExports() so the recorder's named `renameSync` import sees the wrapper.
// `failRenameTo` is set only inside the fault scenarios and is always cleared afterwards.
const originalRename = fsDefault.renameSync;
let failRenameTo = null;
fsDefault.renameSync = function (from, to) {
  if (failRenameTo && failRenameTo(to)) { const error = Error("injected rename EIO"); error.code = "EIO"; throw error; }
  return originalRename.call(fsDefault, from, to);
};
syncBuiltinESMExports();
const failAnchorRename = dir => target => resolve(target) === resolve(join(dir, `submission-${HOOK_SESSION}.json`));

const root = mkdtempSync(join(tmpdir(), "qoder-codex-bridge-"));
assert(resolve(root).startsWith(resolve(tmpdir())), "fixture root must stay under the system temp dir");
const coreCli = join(root, "budget-cli.mjs");
writeFileSync(coreCli, `import { readFileSync } from "node:fs";
const args = process.argv.slice(2), index = args.indexOf("--registry");
if (index < 0 || args.at(-1) !== "budget-status") process.exit(2);
const state = JSON.parse(readFileSync(args[index + 1], "utf8"));
process.stdout.write(JSON.stringify({ messageBudget: state.messageBudget }) + "\\n");
`);
const REQ = "f9716ff6-97b3-4f7a-ab1a-1686206b2399";
const OTHER_REQ = "11111111-2222-3333-4444-555555555555";
const WORKSPACE = "96003604-76a9-400e-9e50-c7b752977391";
const SESSION = "78d8fae4-1436-458a-b9c3-96ab1730f3ae";
const HOOK_SESSION = "sess_bound_01";
const TARGET_TASK = "01a0b7c0-d0fa-79f3-a566-558eb6f489fc";
const TARGET_CWD = "E:/Programming/AI/Agents/Codex";
const EXPIRES = "2030-01-01T00:00:00Z";
const REQ_B = "22222222-3333-4444-5555-666666666666";
const WORKSPACE_B = "33333333-4444-5555-6666-777777777777";
const SESSION_B = "44444444-5555-6666-7777-888888888888";
const HOOK_SESSION_B = "sess_bound_02";
const TARGET_TASK_B = "01a0b73a-1f26-7b73-bbfe-2dbc4c9bc3d4";

function setupBudget(dir, allocatedBytes = 20_000_000) {
  mkdirSync(dir, { recursive: true });
  const ownerId = storeOwnerId(dir), registryPath = join(dir, "core-registry.json");
  const allocations = [{ ownerId, bytes: allocatedBytes }];
  if (allocatedBytes < 20_000_000) allocations.push({ ownerId: "fixture-other-store", bytes: 20_000_000 - allocatedBytes });
  writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 20_000_000, allocations } }));
  writeFileSync(join(dir, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId, coreCli, registryPath }));
  return registryPath;
}
function setAllocation(dir, allocatedBytes, ownerId = storeOwnerId(dir)) {
  const registryPath = JSON.parse(readFileSync(join(dir, "store-config.json"), "utf8")).registryPath;
  const allocations = [{ ownerId, bytes: allocatedBytes }];
  if (allocatedBytes < 20_000_000) allocations.push({ ownerId: "fixture-other-store", bytes: 20_000_000 - allocatedBytes });
  writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 20_000_000, allocations } }));
}
function fixture(name) { const dir = join(root, name); setupBudget(dir); return dir; }
function makeBinding(dir, requestId = REQ) {
  return createBinding(dir, requestId, WORKSPACE, SESSION, HOOK_SESSION, dir, TARGET_TASK, TARGET_CWD, EXPIRES);
}
function writeHostConfig(dir, binding) {
  const script = join(dir, "adapter.mjs"); writeFileSync(script, "");
  const config = { script, pipePath: "\\\\.\\pipe\\test-only", threadId: binding.targetTaskId, cwd: binding.targetCwd, expiresAt: binding.expiresAt };
  writeFileSync(join(dir, "host-config.json"), JSON.stringify(config));
  return config;
}

function mockTransport({ crash = false, hang = false, wrongTarget = false, breakReceipt = null, hostError = false, tasks = { [TARGET_TASK]: TARGET_CWD } } = {}) {
  const methods = []; const sent = []; const wire = []; const launches = [];
  const spawnProcess = (executable, args, options) => {
    launches.push({ executable, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const emit = value => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); methods.push(message.method); wire.push(message);
      const response = result => emit({ id: message.id, result });
      queueMicrotask(() => {
        if (message.method === "initialize") response({ protocolVersion: "2025-06-18" });
        if (message.method === "tools/call") {
          if (hostError) return emit({ id: message.id, error: { code: -32000, message: options.env.CODEX_APP_TOOLS_PIPE_PATH } });
          const { name, arguments: args } = message.params;
          assert(["read_thread", "send_message_to_thread"].includes(name), `Tool ${name} not allowed`);
          if (name === "read_thread") {
            response({ content: [{ type: "text", text: JSON.stringify({ thread: { id: wrongTarget ? "other" : args.threadId, cwd: tasks[args.threadId] ?? TARGET_CWD, status: { type: "idle" } } }) }] });
          } else {
            sent.push(args.prompt);
            if (breakReceipt) breakReceipt();
            if (crash) { child.emit("exit", 1); return; }
            if (hang) return;
            response({ content: [{ type: "text", text: JSON.stringify({ threadId: wrongTarget ? "other" : args.threadId }) }] });
          }
        }
      });
      done();
    } });
    child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit("exit", 0); };
    return child;
  };
  return { spawnProcess, timeoutMs: 50, methods, sent, wire, launches };
}
const mk = () => ({ spawnProcess: mockTransport().spawnProcess });

try {
  // ---- binding + loadBinding (unchanged guarantees + R2 targetCwd) ----
  const bindingDir = fixture("binding");
  const binding = makeBinding(bindingDir);
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.hookSessionId, HOOK_SESSION);
  assert(existsSync(join(bindingDir, "binding.json")));
  assert.equal(loadBinding(bindingDir).requestId, REQ);

  const noMapDir = fixture("no-hook-map");
  writeFileSync(join(noMapDir, "binding.json"), JSON.stringify({ ...binding, hookSessionId: undefined }));
  assert.throws(() => loadBinding(noMapDir), e => e.code === "host_binding_hook_session");
  // R2: targetCwd is part of the fixed identity, so a binding without it is refused.
  const noTargetCwd = fixture("no-target-cwd");
  writeFileSync(join(noTargetCwd, "binding.json"), JSON.stringify({ ...binding, targetCwd: undefined }));
  assert.throws(() => loadBinding(noTargetCwd), e => e.code === "host_binding_target_cwd");
  const badDir = fixture("bad-binding"); writeFileSync(join(badDir, "binding.json"), "null");
  assert.throws(() => loadBinding(badDir), e => e.code === "host_binding_invalid");
  const expiredDir = fixture("expired");
  writeFileSync(join(expiredDir, "binding.json"), JSON.stringify({ ...binding, expiresAt: "2000-01-01T00:00:00.000Z" }));
  assert.throws(() => loadBinding(expiredDir), e => e.code === "host_binding_expired");
  assert.throws(() => loadBinding(fixture("nonexistent")), e => e.code === "host_binding_missing");

  // ---- schema 2 keyed bindings: legacy migration, exact selection, conflict and expiry ----
  const multiDir = fixture("multi-binding");
  const sourceA = join(multiDir, "source-a"), sourceB = join(multiDir, "source-b"), targetB = join(multiDir, "target-b");
  mkdirSync(sourceA); mkdirSync(sourceB); mkdirSync(targetB);
  const multiA = createBinding(multiDir, REQ, WORKSPACE, SESSION, HOOK_SESSION, sourceA, TARGET_TASK, TARGET_CWD, EXPIRES);
  const multiB = addBinding(multiDir, REQ_B, WORKSPACE_B, SESSION_B, HOOK_SESSION_B, sourceB, TARGET_TASK_B, targetB, EXPIRES,
    { deliveryId: "delivery-b", ownerId: "qoder.queue.owner", correlation: "phase2-b" });
  assert.equal(JSON.parse(readFileSync(join(multiDir, "binding.json"), "utf8")).schemaVersion, 2);
  assert.equal(loadBindings(multiDir).length, 2);
  assert.throws(() => loadBinding(multiDir), e => e.code === "host_binding_selector_required");
  assert.equal(loadBinding(multiDir, { requestId: REQ, hookSessionId: HOOK_SESSION, cwd: sourceA }).targetTaskId, TARGET_TASK);
  assert.equal(loadBinding(multiDir, { requestId: REQ_B, hookSessionId: HOOK_SESSION_B, cwd: sourceB }).targetTaskId, TARGET_TASK_B);
  assert.deepEqual({ deliveryId: multiB.deliveryId, ownerId: multiB.ownerId, correlation: multiB.correlation },
    { deliveryId: "delivery-b", ownerId: "qoder.queue.owner", correlation: "phase2-b" });
  assert.throws(() => loadBinding(multiDir, { requestId: REQ_B, hookSessionId: HOOK_SESSION, cwd: sourceA }), e => e.code === "host_binding_unmatched");
  assert.throws(() => addBinding(multiDir, REQ, WORKSPACE_B, SESSION_B, "sess_bound_03", sourceB, TARGET_TASK_B, targetB, EXPIRES), /requestId already exists/);
  assert.throws(() => addBinding(multiDir, OTHER_REQ, WORKSPACE, SESSION, HOOK_SESSION, sourceA, TARGET_TASK_B, targetB, EXPIRES), /route already exists/);
  assert.throws(() => addBinding(fixture("bad-association"), "req-association", WORKSPACE, SESSION, "sess_assoc", sourceA, TARGET_TASK, TARGET_CWD, EXPIRES,
    { deliveryId: "delivery-only" }), /association/);

  writeHostConfig(multiDir, multiA);
  const multiTransport = mockTransport({ tasks: { [TARGET_TASK]: TARGET_CWD, [TARGET_TASK_B]: targetB } });
  const [multiInputA, multiInputB] = await Promise.all([
    handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: sourceA, prompt: `QODER_RETURN_REQUEST=${REQ}` }, { dataDir: multiDir, transport: multiTransport }),
    handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION_B, cwd: sourceB, prompt: `QODER_RETURN_REQUEST=${REQ_B}` }, { dataDir: multiDir, transport: multiTransport })
  ]);
  assert.equal(multiInputA.state, "notified"); assert.equal(multiInputB.state, "notified");
  assert.equal(multiTransport.sent.length, 2);
  assert(multiTransport.sent.some(prompt => prompt.includes(REQ)) && multiTransport.sent.some(prompt => prompt.includes(REQ_B)));
  const [multiStopA, multiStopB] = await Promise.all([
    handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: sourceA }, { dataDir: multiDir, transport: multiTransport }),
    handle({ hook_event_name: "Stop", session_id: HOOK_SESSION_B, cwd: sourceB }, { dataDir: multiDir, transport: multiTransport })
  ]);
  assert.equal(multiStopA.state, "notified"); assert.equal(multiStopB.state, "notified"); assert.equal(multiTransport.sent.length, 4);
  const duplicateStops = await Promise.all([
    handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: sourceA }, { dataDir: multiDir, transport: multiTransport }),
    handle({ hook_event_name: "Stop", session_id: HOOK_SESSION_B, cwd: sourceB }, { dataDir: multiDir, transport: multiTransport })
  ]);
  assert(duplicateStops.every(result => result.state === "uncorrelated")); assert.equal(multiTransport.sent.length, 4);

  const conflictDir = fixture("multi-conflict"), conflictSource = join(conflictDir, "source"), conflictSourceB = join(conflictDir, "source-b"); mkdirSync(conflictSource); mkdirSync(conflictSourceB);
  writeFileSync(join(conflictDir, "binding.json"), JSON.stringify({ schemaVersion: 2, bindings: [
    { ...multiA, cwd: conflictSource }, { ...multiB, requestId: REQ, cwd: conflictSourceB }
  ] }));
  const conflictCap = mockTransport();
  const conflictResult = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: conflictSource, prompt: `QODER_RETURN_REQUEST=${REQ}` }, { dataDir: conflictDir, transport: conflictCap });
  assert.equal(conflictResult.state, "uncorrelated"); assert.equal(conflictResult.diagnostics[0].code, "host_binding_ambiguous"); assert.equal(conflictCap.methods.length, 0);

  const expiredMulti = fixture("multi-expired"), expiredSource = join(expiredMulti, "source"); mkdirSync(expiredSource);
  writeFileSync(join(expiredMulti, "binding.json"), JSON.stringify({ schemaVersion: 2, bindings: [{ ...multiA, cwd: expiredSource, expiresAt: "2000-01-01T00:00:00Z" }] }));
  const expiredCap = mockTransport();
  const expiredResult = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: expiredSource, prompt: `QODER_RETURN_REQUEST=${REQ}` }, { dataDir: expiredMulti, transport: expiredCap });
  assert.equal(expiredResult.state, "uncorrelated"); assert.equal(expiredResult.diagnostics[0].code, "host_binding_expired"); assert.equal(expiredCap.methods.length, 0);

  // ---- current Core budget, future-growth reservation, and shared store lock ----
  {
    const dir = fixture("budget-reserve"), b = makeBinding(dir); writeHostConfig(dir, b);
    const accepted = managedStoreStatus(dir);
    setAllocation(dir, accepted.usedBytes); // no unreserved byte remains after accepting the binding
    const inputResult = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir,
      prompt: `QODER_RETURN_REQUEST=${REQ}` }, { dataDir: dir, transport: mockTransport() });
    assert.equal(inputResult.state, "notified", "binding acceptance must reserve its bounded follow-up receipt/anchor growth");
    const stopResult = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir },
      { dataDir: dir, transport: mockTransport() });
    assert.equal(stopResult.state, "notified");
    assert(managedStoreStatus(dir).usedBytes <= accepted.usedBytes, "follow-up writes and atomic temp peaks must consume the reservation");
    const before = readFileSync(join(dir, "binding.json"), "utf8");
    setAllocation(dir, accepted.usedBytes - 1); // prove every later write re-reads Core, not a saved allocation
    assert.throws(() => addBinding(dir, "budget-later", WORKSPACE_B, SESSION_B, "sess_budget_later", dir,
      TARGET_TASK_B, dir, EXPIRES), error => error.code === "store_budget_exceeded" && error.deltaBytes >= 1);
    assert.equal(readFileSync(join(dir, "binding.json"), "utf8"), before, "over-budget legacy data must be preserved unchanged");
  }
  {
    const missing = fixture("budget-missing"), missingConfig = JSON.parse(readFileSync(join(missing, "store-config.json"), "utf8"));
    writeFileSync(missingConfig.registryPath, JSON.stringify({ messageBudget: null }));
    assert.throws(() => createBinding(missing, "budget-missing", WORKSPACE, SESSION, "sess_budget_missing", missing,
      TARGET_TASK, missing, EXPIRES), error => error.code === "store_budget_not_configured");
    assert(!existsSync(join(missing, "binding.json")));

    const unallocated = fixture("budget-unallocated"); setAllocation(unallocated, 20_000_000, "another-store-owner");
    assert.throws(() => createBinding(unallocated, "budget-unallocated", WORKSPACE, SESSION, "sess_budget_unallocated", unallocated,
      TARGET_TASK, unallocated, EXPIRES), error => error.code === "store_budget_owner_unallocated");

    const mismatch = fixture("budget-mismatch"), configPath = join(mismatch, "store-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")); config.ownerId = "another-store-owner"; writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => createBinding(mismatch, "budget-mismatch", WORKSPACE, SESSION, "sess_budget_mismatch", mismatch,
      TARGET_TASK, mismatch, EXPIRES), error => error.code === "store_budget_owner_mismatch");


    const legacy = fixture("budget-legacy-20m"), legacyRegistry = JSON.parse(readFileSync(join(legacy, "store-config.json"), "utf8")).registryPath;
    const legacyBudget = readFileSync(legacyRegistry, "utf8"); makeBinding(legacy, "budget-legacy-20m");
    const legacyStatus = managedStoreStatus(legacy);
    assert.equal(legacyStatus.totalBytes, 20_000_000); assert.equal(legacyStatus.allocatedBytes, 20_000_000);
    assert.equal(readFileSync(legacyRegistry, "utf8"), legacyBudget, "reading/writing the store must not rewrite an explicit 20 MB Core budget");

    const expanded = fixture("budget-expanded-200m"), expandedConfig = JSON.parse(readFileSync(join(expanded, "store-config.json"), "utf8"));
    writeFileSync(expandedConfig.registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 200_000_000,
      allocations: [{ ownerId: expandedConfig.ownerId, bytes: 200_000_000 }] } }));
    makeBinding(expanded, "budget-expanded-200m");
    const expandedStatus = managedStoreStatus(expanded);
    assert.equal(expandedStatus.totalBytes, 200_000_000); assert.equal(expandedStatus.allocatedBytes, 200_000_000);

    const adaptive = fixture("budget-adaptive-250m");
    const adaptiveConfig = JSON.parse(readFileSync(join(adaptive, "store-config.json"), "utf8"));
    const adaptiveBudget = { schemaVersion: 1, defaultOwnerBytes: 50_000_000, totalBytes: 250_000_000,
      allocations: [adaptiveConfig.ownerId, "owner-b", "owner-c", "owner-d", "owner-e"]
        .map(ownerId => ({ ownerId, bytes: 50_000_000 })) };
    writeFileSync(adaptiveConfig.registryPath, JSON.stringify({ messageBudget: adaptiveBudget }));
    makeBinding(adaptive, "budget-adaptive-250m");
    const adaptiveStatus = managedStoreStatus(adaptive);
    assert.equal(adaptiveStatus.totalBytes, 250_000_000);
    assert.equal(adaptiveStatus.allocatedBytes, 50_000_000);
    assert.deepEqual(JSON.parse(readFileSync(adaptiveConfig.registryPath, "utf8")).messageBudget, adaptiveBudget);

    const invalidCap = fixture("budget-invalid-cap"), invalidCapConfig = JSON.parse(readFileSync(join(invalidCap, "store-config.json"), "utf8"));
    writeFileSync(invalidCapConfig.registryPath, JSON.stringify({ messageBudget: {
      schemaVersion: 1, defaultOwnerBytes: 50_000_000, totalBytes: 250_000_000, globalLimitBytes: 200_000_000,
      allocations: [{ ownerId: invalidCapConfig.ownerId, bytes: 250_000_000 }] } }));
    assert.throws(() => createBinding(invalidCap, "budget-invalid-cap", WORKSPACE, SESSION, "sess_budget_invalid_cap", invalidCap,
      TARGET_TASK, invalidCap, EXPIRES), error => error.code === "store_budget_unavailable");

    const invalidTotal = fixture("budget-invalid-total"), invalidTotalConfig = JSON.parse(readFileSync(join(invalidTotal, "store-config.json"), "utf8"));
    writeFileSync(invalidTotalConfig.registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 30_000_000,
      allocations: [{ ownerId: invalidTotalConfig.ownerId, bytes: 30_000_000 }] } }));
    assert.throws(() => createBinding(invalidTotal, "budget-invalid-total", WORKSPACE, SESSION, "sess_budget_invalid_total", invalidTotal,
      TARGET_TASK, invalidTotal, EXPIRES), error => error.code === "store_budget_unavailable");

    const invalidSum = fixture("budget-invalid-sum"), invalidSumConfig = JSON.parse(readFileSync(join(invalidSum, "store-config.json"), "utf8"));
    writeFileSync(invalidSumConfig.registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 200_000_000,
      allocations: [{ ownerId: invalidSumConfig.ownerId, bytes: 199_999_999 }] } }));
    assert.throws(() => createBinding(invalidSum, "budget-invalid-sum", WORKSPACE, SESSION, "sess_budget_invalid_sum", invalidSum,
      TARGET_TASK, invalidSum, EXPIRES), error => error.code === "store_budget_unavailable");

    const denied = fixture("budget-hook-diagnostic"); makeBinding(denied);
    const status = managedStoreStatus(denied); setAllocation(denied, status.usedBytes - 1);
    const result = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: denied,
      prompt: `QODER_RETURN_REQUEST=${REQ}` }, { dataDir: denied, transport: mockTransport() });
    assert.equal(result.state, "attribution_unpersistable"); assert.equal(result.blockInput, true);
    assert.deepEqual(result.diagnostics[0], { code: "store_budget_exceeded",
      message: "Request attribution or event receipt could not be durably recorded", deltaBytes: 1 });
  }
  {
    // Two OS processes, two different accepted-write paths, one tight shared allocation: exactly one wins.
    const dir = fixture("budget-cross-path"), b = makeBinding(dir), barrier = join(dir, "budget-barrier"); mkdirSync(barrier);
    const nextBinding = { ...b, requestId: "budget-add-winner", workspaceId: WORKSPACE_B, sessionId: SESSION_B,
      hookSessionId: "sess_budget_add", cwd: join(dir, "add-source"), targetTaskId: TARGET_TASK_B,
      targetCwd: join(dir, "add-target"), createdAt: new Date().toISOString() };
    const nextDocument = JSON.stringify({ schemaVersion: 2, bindings: [b, nextBinding] }, null, 2);
    const intent = { schemaVersion: 1, selectionToken: "budget-message-token", threadId: TARGET_TASK_B, cwd: dir,
      messageSha256: "0".repeat(64), state: "dispatch_intent", createdAt: new Date().toISOString() };
    const base = managedStoreStatus(dir);
    const addCost = Buffer.byteLength(nextDocument) + bindingReservationBytes(nextBinding);
    const messageCost = messageReservationBytes(intent);
    setAllocation(dir, base.usedBytes + Math.max(addCost, messageCost) + 256);
    const workerPath = join(root, "budget-worker.mjs");
    writeFileSync(workerPath, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, action, payload, configureHref, budgetHref, barrier] = process.argv.slice(2);
writeFileSync(join(barrier, "ready-" + process.pid), "");
while (!existsSync(join(barrier, "GO"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
try {
  if (action === "add") {
    const { addBinding } = await import(configureHref); const p = JSON.parse(payload);
    addBinding(dir, p.requestId, p.workspaceId, p.sessionId, p.hookSessionId, p.cwd, p.targetTaskId, p.targetCwd, p.expiresAt);
  } else {
    const { messageReservationBytes, writeManagedExclusive } = await import(budgetHref); const p = JSON.parse(payload);
    writeManagedExclusive(dir, join(dir, "message-" + p.selectionToken + ".json"), JSON.stringify(p),
      { newReservationBytes: messageReservationBytes(p), reservationIncludesWrite: true });
  }
  process.stdout.write(JSON.stringify({ ok:true }));
} catch (error) { process.stdout.write(JSON.stringify({ ok:false, code:error.code })); }
`);
    const configureHref = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "configure-binding.mjs")).href;
    const budgetHref = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "store-budget.mjs")).href;
    const collect = child => new Promise((resolveResult, reject) => { let out = "", err = "";
      child.stdout.on("data", value => out += value); child.stderr.on("data", value => err += value);
      child.on("close", code => code === 0 ? resolveResult(JSON.parse(out)) : reject(Error(`budget worker ${code}: ${err}`)));
    });
    const addPayload = JSON.stringify({ ...nextBinding, expiresAt: EXPIRES });
    const a = spawn(process.execPath, [workerPath, dir, "add", addPayload, configureHref, budgetHref, barrier], { windowsHide: true });
    const m = spawn(process.execPath, [workerPath, dir, "message", JSON.stringify(intent), configureHref, budgetHref, barrier], { windowsHide: true });
    const pa = collect(a), pm = collect(m), deadline = Date.now() + 15_000;
    while (!(existsSync(join(barrier, `ready-${a.pid}`)) && existsSync(join(barrier, `ready-${m.pid}`)))) {
      if (Date.now() > deadline) throw Error("budget cross-path barrier timeout");
    }
    writeFileSync(join(barrier, "GO"), "go");
    const outcomes = [await pa, await pm];
    assert.equal(outcomes.filter(item => item.ok).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(item => item.code === "store_budget_exceeded").length, 1, JSON.stringify(outcomes));
    const status = managedStoreStatus(dir); assert(status.usedBytes <= status.allocatedBytes);
  }
  {
    // create and --add share the same registry lock: every successful CLI write remains in the final document.
    const dir = fixture("binding-create-add-race"), lock = join(dir, "binding.json.lock"); writeFileSync(lock, "");
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "configure-binding.mjs");
    const args = (add, requestId, hookSession) => [cliPath, ...(add ? ["--add"] : []), dir, requestId, WORKSPACE, SESSION,
      hookSession, join(dir, hookSession), TARGET_TASK, TARGET_CWD, EXPIRES];
    const collect = child => new Promise(resolveResult => { let out = "", err = "";
      child.stdout.on("data", value => out += value); child.stderr.on("data", value => err += value);
      child.on("close", code => resolveResult({ code, out, err }));
    });
    const add = spawn(process.execPath, args(true, "race-add", "race_add"), { windowsHide: true });
    const create = spawn(process.execPath, args(false, "race-create", "race_create"), { windowsHide: true });
    const pa = collect(add), pc = collect(create);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    assert(!existsSync(join(dir, "binding.json")), "create must not bypass a held binding registry lock");
    rmSync(lock, { force: true });
    const [added, created] = await Promise.all([pa, pc]);
    assert.equal(added.code, 0, JSON.stringify({ added, created }));
    if (created.code !== 0) {
      const failure = JSON.parse(created.err);
      assert.deepEqual({ code: failure.code, retrySafe: failure.retrySafe },
        { code: "binding_registry_exists", retrySafe: false });
    }
    const saved = loadBindings(dir), accepted = [added, created].filter(item => item.code === 0)
      .map(item => JSON.parse(item.out).requestId);
    assert(accepted.every(requestId => saved.some(binding => binding.requestId === requestId)), JSON.stringify({ accepted, saved }));
    assert.equal(saved.length, accepted.length);
  }
  {
    // A hard exit after the accepted temp is written must consume the original intent reservation.
    const dir = fixture("budget-message-temp-crash"), token = "temp-crash-token", path = join(dir, `message-${token}.json`);
    const intent = { schemaVersion: 1, selectionToken: token, threadId: TARGET_TASK, cwd: dir,
      messageSha256: "1".repeat(64), state: "dispatch_intent", createdAt: new Date().toISOString() };
    writeManagedExclusive(dir, path, JSON.stringify(intent),
      { newReservationBytes: messageReservationBytes(intent), reservationIncludesWrite: true });
    const acceptedBudget = managedStoreStatus(dir); setAllocation(dir, acceptedBudget.usedBytes);
    const accepted = { ...intent, state: "accepted", acceptedAt: new Date().toISOString() };
    const ready = join(dir, "temp-written"), worker = join(root, "message-temp-crash-worker.mjs");
    const budgetHref = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "store-budget.mjs")).href;
    writeFileSync(worker, `import fs from "node:fs";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [budgetHref, dir, target, ready, payload, token] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (resolve(to) === resolve(target)) {
    fs.writeFileSync(ready, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  }
  return rename.call(fs, from, to);
};
syncBuiltinESMExports();
const { writeManagedAtomic } = await import(budgetHref);
writeManagedAtomic(dir, target, payload, { creditKey: "message:" + token });
`);
    const child = spawn(process.execPath, [worker, budgetHref, dir, path, ready, JSON.stringify(accepted), token],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null) throw Error(`message temp worker exited early: ${readFileSync(ready, "utf8")}`);
      if (Date.now() > deadline) throw Error("message temp worker timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    child.kill();
    await new Promise((resolveExit, reject) => {
      if (child.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => reject(Error("message temp worker did not exit")), 5_000);
      child.once("close", () => { clearTimeout(timer); resolveExit(); });
    });
    rmSync(join(dir, ".message-store.lock"), { force: true }); // explicit operator recovery in this isolated fixture
    assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "dispatch_intent");
    assert(readdirSync(dir).some(name => name.startsWith(`message-${token}.json.`) && name.endsWith(".tmp")));
    const reopened = managedStoreStatus(dir);
    assert.equal(reopened.usedBytes, acceptedBudget.usedBytes, JSON.stringify(reopened));
    writeManagedAtomic(dir, path, JSON.stringify(accepted), { creditKey: `message:${token}` });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "accepted");
    const completed = managedStoreStatus(dir);
    assert.equal(completed.allocatedBytes, acceptedBudget.usedBytes);
    assert(completed.usedBytes <= completed.allocatedBytes);
  }
  {
    // Real CLI processes contend on a 5000-record schema2 registry: bounded wait serializes both additions.
    const dir = fixture("binding-cli-race"), records = [];
    for (let index = 0; index < 5_000; index++) records.push({
      schemaVersion: 1, requestId: `old-${index}`, workspaceId: WORKSPACE, sessionId: SESSION,
      hookSessionId: `old_${index}`, cwd: join(dir, `old-${index}`), targetTaskId: TARGET_TASK,
      targetCwd: TARGET_CWD, expiresAt: "2000-01-01T00:00:00Z", createdAt: "2000-01-01T00:00:00Z"
    });
    writeFileSync(join(dir, "binding.json"), JSON.stringify({ schemaVersion: 2, bindings: records }, null, 2));
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "configure-binding.mjs");
    const collect = child => new Promise(resolveResult => { let out = "", err = "";
      child.stdout.on("data", value => out += value); child.stderr.on("data", value => err += value);
      child.on("close", code => resolveResult({ code, out, err }));
    });
    const args = index => [cliPath, "--add", dir, `cli-new-${index}`, WORKSPACE, SESSION, `cli_new_${index}`,
      join(dir, `new-${index}`), TARGET_TASK, TARGET_CWD, EXPIRES];
    const c1 = spawn(process.execPath, args(1), { windowsHide: true }), c2 = spawn(process.execPath, args(2), { windowsHide: true });
    const results = [await collect(c1), await collect(c2)];
    assert(results.every(item => item.code === 0), JSON.stringify(results));
    assert.equal(loadBindings(dir).length, 5_002);
    const before = readFileSync(join(dir, "binding.json"), "utf8");
    writeFileSync(join(dir, "binding.json.lock"), "");
    const blocked = await collect(spawn(process.execPath, args(3), { windowsHide: true }));
    assert.equal(blocked.code, 1); const failure = JSON.parse(blocked.err);
    assert.deepEqual({ code: failure.code, retrySafe: failure.retrySafe }, { code: "binding_registry_busy", retrySafe: true });
    assert.equal(readFileSync(join(dir, "binding.json"), "utf8"), before);
  }

  // ---- signal mapping (R1: SessionStart is observe-only, not a signal) ----
  for (const [hook, signal] of [["UserPromptSubmit", "input_observed"], ["Stop", "stop_observed"], ["StopFailure", "error_observed"]]) {
    assert.equal(signalForHook(hook), signal);
    assert(ALLOWED_HOOKS.has(hook) && ALLOWED_SIGNALS.has(signal));
  }
  assert.equal(signalForHook("SessionStart"), null, "SessionStart must not map to a relayed signal");
  assert.equal(signalForHook("InvalidHook"), null);

  // ---- validateHookInput path safety ----
  assert.throws(() => validateHookInput(null), /not an object/);
  assert.throws(() => validateHookInput({}), /hook_event_name/);
  assert.throws(() => validateHookInput({ hook_event_name: "Invalid", session_id: "sess_a" }), /hook_event_name/);
  for (const bad of ["", "../etc/passwd", "a/b", "a\\b", "a b", "a.b", "..", "sess\u0000x"])
    assert.throws(() => validateHookInput({ hook_event_name: "Stop", session_id: bad }), /session_id/, `expected reject: ${JSON.stringify(bad)}`);
  assert(validateHookInput({ hook_event_name: "Stop", session_id: "01a06b03-cd32-7c31-ab2d-961937a69a11" }));

  // ---- marker parsing (R1.4: ONLY a whole, standalone marker line is recognised) ----
  // a proper standalone marker line passes, incl. surrounding whitespace, CRLF, and other lines
  assert.deepEqual(parseMarker(`QODER_RETURN_REQUEST=${REQ}`), { status: "ok", requestId: REQ });
  assert.deepEqual(parseMarker(`QODER_RETURN_REQUEST=${REQ}\r\n`), { status: "ok", requestId: REQ });
  assert.deepEqual(parseMarker(`some preamble\r\n  QODER_RETURN_REQUEST=${REQ}  \r\ntrailing note`), { status: "ok", requestId: REQ });
  // in-sentence markers are NOT recognised (the R1.4 fix: the old word-boundary regex wrongly
  // accepted `do it QODER_RETURN_REQUEST=<id> now` and `go QODER_RETURN_REQUEST=<id>`)
  assert.deepEqual(parseMarker(`go QODER_RETURN_REQUEST=${REQ}`), { status: "missing" });
  assert.deepEqual(parseMarker(`do it QODER_RETURN_REQUEST=${REQ} now`), { status: "missing" });
  // no marker at all, or a key prefixed into a larger identifier
  assert.deepEqual(parseMarker(undefined), { status: "missing" });
  assert.deepEqual(parseMarker("no marker here"), { status: "missing" });
  assert.deepEqual(parseMarker(`NOT_QODER_RETURN_REQUEST=${REQ}`), { status: "missing" });
  assert.deepEqual(parseMarker(`XQODER_RETURN_REQUEST=${REQ}`), { status: "missing" });
  assert.deepEqual(parseMarker(`see NOT_QODER_RETURN_REQUEST=${REQ} inline`), { status: "missing" });
  // a longer or garbled value on its own line is not this request's clean id
  assert.notEqual(parseMarker(`QODER_RETURN_REQUEST=${REQ}Z`).requestId, REQ);
  assert.deepEqual(parseMarker("QODER_RETURN_REQUEST=abc=def"), { status: "missing" });
  // two standalone marker lines are ambiguous whether they agree or conflict
  assert.deepEqual(parseMarker(`QODER_RETURN_REQUEST=${REQ}\nQODER_RETURN_REQUEST=${OTHER_REQ}`), { status: "ambiguous" });
  assert.deepEqual(parseMarker(`QODER_RETURN_REQUEST=${REQ}\r\nQODER_RETURN_REQUEST=${REQ}`), { status: "ambiguous" });

  // ---- buildEvent evidence ----
  const event = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_test" }, binding);
  assert.equal(event.source, "runtime_hook");
  assert.equal(event.turnId, null);
  assert.equal(event.evidenceRef, receiptFilename(event));
  assert(event.evidenceRef.startsWith("receipt-input_observed-"), "receipt is keyed by signal+request only");
  assert(!event.evidenceRef.includes("sess_test") && !event.evidenceRef.includes("/") && !event.evidenceRef.includes(".."));
  assert.throws(() => buildEvent({ hook_event_name: "SessionStart", session_id: "sess_test" }, binding), /Cannot determine signal/);

  const prompt = buildNotificationPrompt(event);
  assert(prompt.includes(event.requestId) && prompt.includes(event.signal) && prompt.includes("fixed-template"));
  assert(prompt.includes(`Evidence: ${event.evidenceRef}`) && !prompt.includes("Evidence: null"));
  assert(!prompt.includes("请只回复") && !prompt.includes("不要调用工具"));

  // ---- recordEvent create + same-identity dedup (R2) ----
  const unitDir = fixture("unit");
  const ub = makeBinding(unitDir);
  const e1 = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_test" }, ub);
  const first = recordEvent(unitDir, e1, { binding: ub });
  assert(!first.deduplicated && !first.conflict);
  assert.equal(first.record.sendState, "recorded");
  const again = recordEvent(unitDir, e1, { binding: ub });
  assert(again.deduplicated && !again.conflict);

  // remapping the hook session cannot open a second receipt for the same stage (R2)
  const remapped = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_other" }, ub);
  const conflict = recordEvent(unitDir, remapped, { binding: ub });
  assert(conflict.conflict && !conflict.deduplicated, "hook-session remap must be a conflict, not a resendable record");
  assert.equal(conflict.reason, "identity_conflict");

  // a changed target under the same request/signal is also a conflict (R2)
  const swapped = { ...ub, targetTaskId: "other-task" };
  const targetConflict = recordEvent(unitDir, buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_test" }, ub), { binding: swapped });
  assert(targetConflict.conflict && targetConflict.reason === "identity_conflict");

  // R2: identity includes targetCwd, so re-binding the same task to a different cwd
  // must NOT reuse a prior accepted receipt (it is a conflict, never a dedup "already sent").
  const tcDir = fixture("r2-targetcwd"); const tcb = makeBinding(tcDir);
  const tce = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_test" }, tcb);
  recordEvent(tcDir, tce, { binding: tcb });
  assert(markSent(tcDir, tce, tcb, { threadId: tcb.targetTaskId }), "the accepted receipt must persist durably");
  const tcRebind = recordEvent(tcDir, tce, { binding: { ...tcb, targetCwd: "E:/somewhere/else" } });
  assert(tcRebind.conflict && tcRebind.reason === "identity_conflict", "a targetCwd change must not reuse the old accepted receipt");

  for (const field of ["schemaVersion", "workspaceId", "sessionId", "source", "observedAt", "evidenceRef"]) {
    const missing = JSON.parse(readFileSync(join(tcDir, tce.evidenceRef), "utf8"));
    delete missing.event[field];
    const dir = fixture(`r2-missing-${field}`);
    writeFileSync(join(dir, tce.evidenceRef), JSON.stringify(missing));
    assert.equal(recordEvent(dir, tce, { binding: tcb }).reason, "existing_receipt_malformed");
  }

  // malformed / unreadable existing records never yield a dedup "success" (R2)
  const badShapes = fixture("bad-shape"); const bb = makeBinding(badShapes);
  const be = buildEvent({ hook_event_name: "Stop", session_id: "sess_test" }, bb);
  writeFileSync(join(badShapes, be.evidenceRef), "{}");
  assert.equal(recordEvent(badShapes, be, { binding: bb }).reason, "existing_receipt_malformed");
  const be2 = buildEvent({ hook_event_name: "StopFailure", session_id: "sess_test" }, bb);
  writeFileSync(join(badShapes, be2.evidenceRef), "not json {");
  assert.equal(recordEvent(badShapes, be2, { binding: bb }).reason, "existing_receipt_unreadable");

  // R2: a record that CLAIMS accepted but has no durable send evidence is rejected by shape,
  // so it can never be read back as success/alreadyNotified.
  const forgedDir = fixture("forged-accepted"); const fb = makeBinding(forgedDir);
  const fe = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_test" }, fb);
  writeFileSync(join(forgedDir, fe.evidenceRef), JSON.stringify({
    schemaVersion: 1, dedupKey: `${REQ}:input_observed`,
    identity: { requestId: REQ, signal: "input_observed", workspaceId: WORKSPACE, sessionId: SESSION,
      hookSessionId: "sess_test", targetTaskId: TARGET_TASK, targetCwd: TARGET_CWD, cwd: forgedDir },
    event: fe, receivedAt: new Date().toISOString(),
    sent: false, dispatchAttempted: false, sendState: "accepted",
  }));
  const forged = recordEvent(forgedDir, fe, { binding: fb });
  assert(forged.conflict && !forged.deduplicated, "a forged accepted (sent=false/no hostReceipt) is a conflict, not a dedup success");
  assert.equal(forged.reason, "existing_receipt_malformed");
  // an event that contradicts its own identity is rejected by shape too
  const crossDir = fixture("cross-event"); const cb = makeBinding(crossDir);
  const ce = buildEvent({ hook_event_name: "Stop", session_id: "sess_test" }, cb);
  writeFileSync(join(crossDir, ce.evidenceRef), JSON.stringify({
    schemaVersion: 1, dedupKey: "x",
    identity: { requestId: REQ, signal: "stop_observed", workspaceId: WORKSPACE, sessionId: SESSION,
      hookSessionId: "sess_test", targetTaskId: TARGET_TASK, targetCwd: TARGET_CWD, cwd: crossDir },
    event: { ...ce, requestId: OTHER_REQ }, receivedAt: new Date().toISOString(),
    sent: true, dispatchAttempted: true, sendState: "accepted", hostReceipt: { threadId: TARGET_TASK },
  }));
  assert.equal(recordEvent(crossDir, ce, { binding: cb }).reason, "existing_receipt_malformed", "event/identity mismatch must not validate");

  // traversal in a receipt name is refused rather than written outside dataDir (B3)
  const evil = { ...e1, evidenceRef: "../../outside.json" };
  assert.throws(() => recordEvent(unitDir, evil), /Unsafe record name/);
  assert(!existsSync(resolve(unitDir, "..", "outside.json")));

  // ---- matched-submission anchor primitives (R1.1 / R1.2 / R1.3) ----
  const subDir = fixture("sub");
  const c1 = createSubmission(subDir, { requestId: REQ, hookSessionId: HOOK_SESSION, cwd: subDir });
  assert.equal(c1.created, true); assert.equal(c1.conflict, false); assert.equal(c1.error, false);
  // a second create while one is in flight conflicts and must NOT clobber the winner's anchor
  const c2 = createSubmission(subDir, { requestId: OTHER_REQ, hookSessionId: HOOK_SESSION, cwd: subDir });
  assert.equal(c2.created, false); assert.equal(c2.conflict, true); assert.equal(c2.error, false);
  assert.equal(readSubmission(subDir, HOOK_SESSION).requestId, REQ, "losing create must not overwrite the winner");
  // a valid transition persists AND is confirmed by read-after-write
  assert.equal(updateSubmission(subDir, HOOK_SESSION, a => { a.ambiguous = true; }), true);
  assert.equal(readSubmission(subDir, HOOK_SESSION).ambiguous, true);
  // a transition producing an invalid shape is refused, and the prior record is left intact (R1.1)
  assert.equal(updateSubmission(subDir, HOOK_SESSION, a => { a.requestId = "bad id with spaces"; }), false);
  assert.equal(readSubmission(subDir, HOOK_SESSION).requestId, REQ, "a rejected update must not corrupt the anchor");
  assert.equal(readSubmission(subDir, HOOK_SESSION).ambiguous, true, "the prior committed state survives a rejected update");
  // a non-EEXIST write failure surfaces as error, never a silent success (R1.1)
  const errCreate = createSubmission(join(root, "no-such-dir"), { requestId: REQ, hookSessionId: HOOK_SESSION, cwd: subDir });
  assert.equal(errCreate.created, false); assert.equal(errCreate.conflict, false); assert.equal(errCreate.error, true);
  // R1.3: a partial / foreign anchor is invalid; reads report invalid and updates refuse
  const invalidDir = fixture("sub-invalid");
  writeFileSync(join(invalidDir, `submission-${HOOK_SESSION}.json`), JSON.stringify({ schemaVersion: 1, requestId: REQ, hookSessionId: "sess_someone_else" }));
  assert.equal(readSubmission(invalidDir, HOOK_SESSION).invalid, true);
  assert.equal(updateSubmission(invalidDir, HOOK_SESSION, a => { a.terminal = true; }), false);

  // ---- sendNotification: accepted / uncertain / timeout / ACK-but-persist-fail (R3) ----
  const notifyDir = fixture("notify"); const nb = makeBinding(notifyDir); writeHostConfig(notifyDir, nb);
  const okEvent = buildEvent({ hook_event_name: "Stop", session_id: "sess_n" }, nb);
  recordEvent(notifyDir, okEvent, { binding: nb });
  const cap = mockTransport();
  const receipt = await sendNotification(nb, notifyDir, okEvent, cap);
  assert.equal(receipt.threadId, nb.targetTaskId);
  assert.deepEqual(cap.launches, [{ executable: process.execPath, args: [join(notifyDir, "adapter.mjs")] }]);
  assert.equal(cap.wire[0].method, "initialize");
  assert.equal(cap.wire[0].params.clientInfo.name, "qoder-bound-bridge");
  assert.deepEqual(cap.wire.filter(message => message.method === "tools/call").map(message =>
    [message.params.name, message.params._meta]), [
    ["read_thread", { codexThreadId: nb.targetTaskId }],
    ["send_message_to_thread", { codexThreadId: nb.targetTaskId }]
  ]);
  assert.equal(cap.sent.length, 1);
  assert(cap.sent[0].includes(`Evidence: ${okEvent.evidenceRef}`) && !cap.sent[0].includes("Evidence: null"));
  const okRecord = JSON.parse(readFileSync(join(notifyDir, okEvent.evidenceRef), "utf8"));
  assert.equal(okRecord.sent, true); assert.equal(okRecord.sendState, "accepted"); assert.equal(okRecord.dispatchAttempted, true);

  const crashEvent = buildEvent({ hook_event_name: "StopFailure", session_id: "sess_n" }, nb);
  recordEvent(notifyDir, crashEvent, { binding: nb });
  await assert.rejects(sendNotification(nb, notifyDir, crashEvent, mockTransport({ crash: true })), /disconnected/);
  const crashRecord = JSON.parse(readFileSync(join(notifyDir, crashEvent.evidenceRef), "utf8"));
  assert.equal(crashRecord.sent, false); assert.equal(crashRecord.sendState, "uncertain"); assert.equal(crashRecord.dispatchAttempted, true);

  const timeoutEvent = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_n" }, nb);
  recordEvent(notifyDir, timeoutEvent, { binding: nb });
  await assert.rejects(sendNotification(nb, notifyDir, timeoutEvent, mockTransport({ hang: true })), /timed out/);

  // R3: host ACKs but the durable receipt update is broken -> never claim success
  const ackBreakDir = fixture("ackbreak"); const ab = makeBinding(ackBreakDir); writeHostConfig(ackBreakDir, ab);
  const ackEvent = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: "sess_ab" }, ab);
  recordEvent(ackBreakDir, ackEvent, { binding: ab });
  const breaking = mockTransport({ breakReceipt: () => writeFileSync(join(ackBreakDir, ackEvent.evidenceRef), "{ truncated") });
  await assert.rejects(sendNotification(ab, ackBreakDir, ackEvent, breaking), /could not be persisted/);
  assert.equal(breaking.sent.length, 1, "the host really received the ACK-able call, yet success is refused");

  // ---- loadHostConfig: every config failure carries a top-level code (R4) ----
  assert.equal(loadHostConfig(notifyDir, nb).threadId, nb.targetTaskId);
  const wrongTaskDir = fixture("wrong-task"); const wb = makeBinding(wrongTaskDir); writeHostConfig(wrongTaskDir, wb);
  writeFileSync(join(wrongTaskDir, "host-config.json"), JSON.stringify({ script: join(wrongTaskDir, "adapter.mjs"), pipePath: "\\\\.\\pipe\\test-only", threadId: "other", cwd: wb.targetCwd, expiresAt: wb.expiresAt }));
  assert.throws(() => loadHostConfig(wrongTaskDir, wb), e => e.code === "host_task_mismatch");
  // R4: a pipe path carrying a control character is rejected at configuration load (never reaches spawn)
  const nulPipeDir = fixture("r4-nulpipe-cfg"); const nlpb = makeBinding(nulPipeDir);
  const nlpScript = join(nulPipeDir, "adapter.mjs"); writeFileSync(nlpScript, "");
  writeFileSync(join(nulPipeDir, "host-config.json"), JSON.stringify({ script: nlpScript, pipePath: "\\\\.\\pipe\\ok\u0000", threadId: nlpb.targetTaskId, cwd: nlpb.targetCwd, expiresAt: nlpb.expiresAt }));
  assert.throws(() => loadHostConfig(nulPipeDir, nlpb), e => e.code === "host_pipe_invalid");

  // ---- HostClient protocol surface (whitelist only) ----
  const hcDir = fixture("hostclient"); const hb = makeBinding(hcDir); const hcfg = writeHostConfig(hcDir, hb);
  const transport = mockTransport();
  const client = new HostClient(hcfg, transport);
  await client.initialize();
  assert.deepEqual(transport.methods, ["initialize", "notifications/initialized"]);
  await assert.rejects(async () => client.call("forbidden_tool", {}), /not allowed/);
  assert.equal((await client.call("read_thread", { threadId: hb.targetTaskId })).thread.id, hb.targetTaskId);
  client.close();
  const secretPipe = "\\\\.\\pipe\\SECRET_PIPE_PATH_MUST_NOT_LEAK";
  const failingClient = new HostClient({ ...hcfg, pipePath: secretPipe }, mockTransport({ hostError: true }));
  await failingClient.initialize();
  await assert.rejects(failingClient.call("read_thread", { threadId: hb.targetTaskId }),
    error => error.message === "Desktop host request failed" && !error.message.includes(secretPipe));
  failingClient.close();

  // ---- handler: R1 two-layer attribution, positive + negative ----
  {
    const dir = fixture("attr"); const b = makeBinding(dir); writeHostConfig(dir, b);
    // SessionStart observe-only, records nothing, not a submission
    const ss = await handle({ hook_event_name: "SessionStart", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(ss.state, "observed_only"); assert.equal(ss.notified, false); assert.equal(ss.recorded, false); assert.equal(ss.failClosed, false);
    assert(!existsSync(join(dir, `receipt-input_observed-${b.requestId}.json`)));
    // Stop with no prior matched submission -> uncorrelated
    const earlyStop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(earlyStop.state, "uncorrelated"); assert.equal(earlyStop.diagnostics[0].code, "no_matched_submission");
    // UserPromptSubmit with no marker -> uncorrelated
    const noMarker = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(noMarker.state, "uncorrelated"); assert.equal(noMarker.diagnostics[0].code, "request_marker_missing");
    // UserPromptSubmit with the wrong marker -> uncorrelated, no anchor opened
    const wrongMarker = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${OTHER_REQ}` }, { dataDir: dir, transport: mk() });
    assert.equal(wrongMarker.state, "uncorrelated"); assert.equal(wrongMarker.diagnostics[0].code, "request_marker_mismatch");
    assert.equal(readSubmission(dir, HOOK_SESSION), null, "a wrong marker must not open a submission anchor");
    // Correct marker -> notified, anchor opened, real evidence recorded
    const good = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: mk() });
    assert.equal(good.state, "notified"); assert(good.record.event.evidenceRef);
    assert.equal(readSubmission(dir, HOOK_SESSION).requestId, b.requestId);
    // Matched Stop -> notified stop_observed (never completed)
    const stop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(stop.state, "notified"); assert.equal(stop.record.event.signal, "stop_observed"); assert.notEqual(stop.record.event.signal, "completed");
    // Duplicate terminal -> uncorrelated (attribution consumed once)
    const dupStop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(dupStop.state, "uncorrelated"); assert.equal(dupStop.diagnostics[0].code, "duplicate_terminal");
  }
  {
    // R1 key counterexample: correct submission then extra unrelated input, then Stop must NOT reuse the old request
    const dir = fixture("extra"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const up = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: mk() });
    assert.equal(up.state, "notified");
    const extra = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: "unrelated follow-up with no marker" }, { dataDir: dir, transport: mk() });
    assert.equal(extra.state, "uncorrelated"); assert.equal(extra.diagnostics[0].code, "submission_overlap");
    assert.equal(readSubmission(dir, HOOK_SESSION).ambiguous, true, "the overlap must be durably marked on disk, not just refused in-memory");
    const stop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(stop.state, "uncorrelated"); assert.equal(stop.diagnostics[0].code, "submission_ambiguous");
    assert.equal(stop.notified, false); assert(stop.failClosed);
  }
  {
    // R1.3: a partial / foreign anchor (wrong hookSessionId inside the bound-session file) can never authorize a Stop
    const dir = fixture("r13-anchor"); const b = makeBinding(dir); writeHostConfig(dir, b);
    writeFileSync(join(dir, `submission-${HOOK_SESSION}.json`), JSON.stringify({ schemaVersion: 1, requestId: REQ, hookSessionId: "sess_someone_else" }));
    const stop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(stop.state, "uncorrelated"); assert.equal(stop.diagnostics[0].code, "submission_record_invalid"); assert.equal(stop.notified, false);
    assert(!existsSync(join(dir, `receipt-stop_observed-${b.requestId}.json`)));
  }
  {
    // R1.3: an anchor whose cwd differs from the binding cwd cannot authorize a terminal notify
    const dir = fixture("r13-cwd"); const b = makeBinding(dir); writeHostConfig(dir, b);
    createSubmission(dir, { requestId: REQ, hookSessionId: HOOK_SESSION, cwd: join(dir, "different") });
    const stop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(stop.state, "uncorrelated"); assert.equal(stop.diagnostics[0].code, "submission_cwd_mismatch"); assert.equal(stop.notified, false);
  }
  {
    // R1.1/R1.3 end-to-end: an attribution record that can be neither trusted nor advanced fails
    // closed with zero host interaction and no receipt opened.
    const dir = fixture("r11-blocked"); const b = makeBinding(dir); writeHostConfig(dir, b);
    mkdirSync(join(dir, `submission-${HOOK_SESSION}.json`)); // occupied by a directory -> every read is invalid
    const cap = mockTransport();
    const res = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: cap });
    assert.equal(res.state, "uncorrelated"); assert.equal(res.diagnostics[0].code, "submission_record_invalid");
    assert.equal(res.notified, false); assert(res.failClosed);
    assert.equal(cap.methods.length, 0); assert.equal(cap.sent.length, 0);
    assert(!existsSync(join(dir, `receipt-input_observed-${b.requestId}.json`)));
  }
  {
    // R1.1 (a) REAL rename-EIO during the ambiguous-mark transition: a failed persistence must
    // leave durable cross-call quarantine so a LATER Stop cannot notify the stale active request.
    const dir = fixture("r11-amb-fail"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const up = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: mk() });
    assert.equal(up.state, "notified");
    assert.equal(readSubmission(dir, HOOK_SESSION).ambiguous, false, "anchor is trusted+active before the extra input");
    failRenameTo = failAnchorRename(dir);
    const extra = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: "unrelated follow-up with no marker" }, { dataDir: dir, transport: mk() });
    failRenameTo = null;
    assert.equal(extra.state, "attribution_unpersistable"); assert.equal(extra.notified, false); assert(extra.failClosed);
    // on-disk the anchor is STILL the old active record (the rename failed), so state alone is
    // not enough — the durable quarantine marker is what keeps later calls from trusting it.
    assert(readFileSync(join(dir, `submission-${HOOK_SESSION}.json`), "utf8").includes('"ambiguous": false'));
    assert(existsSync(join(dir, `submission-${HOOK_SESSION}.quarantined`)), "a failed transition must leave a durable quarantine marker");
    const stopCap = mockTransport();
    const stop = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: stopCap });
    assert.equal(stop.state, "uncorrelated"); assert.equal(stop.diagnostics[0].code, "submission_concurrent"); assert.equal(stop.notified, false);
    assert.equal(stopCap.methods.length, 0); assert.equal(stopCap.sent.length, 0);
    assert(!existsSync(join(dir, `receipt-stop_observed-${b.requestId}.json`)), "the later Stop must not notify the old request");
  }
  {
    // R1.1 (b) REAL rename-EIO during the terminal-consume transition: same guarantee — after
    // the fault clears, later Stop/StopFailure must not mis-attribute the still-active request.
    const dir = fixture("r11-term-fail"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const up = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: mk() });
    assert.equal(up.state, "notified");
    failRenameTo = failAnchorRename(dir);
    const stop1 = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: mk() });
    failRenameTo = null;
    assert.equal(stop1.state, "attribution_unpersistable"); assert.equal(stop1.notified, false); assert(stop1.failClosed);
    assert(readFileSync(join(dir, `submission-${HOOK_SESSION}.json`), "utf8").includes('"terminal": false'));
    assert(existsSync(join(dir, `submission-${HOOK_SESSION}.quarantined`)));
    const cap = mockTransport();
    const stop2 = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: cap });
    const sf = await handle({ hook_event_name: "StopFailure", session_id: HOOK_SESSION, cwd: dir }, { dataDir: dir, transport: cap });
    assert.equal(stop2.state, "uncorrelated"); assert.equal(stop2.diagnostics[0].code, "submission_concurrent"); assert.equal(stop2.notified, false);
    assert.equal(sf.state, "uncorrelated"); assert.equal(sf.diagnostics[0].code, "submission_concurrent"); assert.equal(sf.notified, false);
    assert.equal(cap.methods.length, 0); assert.equal(cap.sent.length, 0);
    assert(!existsSync(join(dir, `receipt-stop_observed-${b.requestId}.json`)));
  }
  {
    // R1.2: REAL two-process race for the session's single in-flight submission. The exclusive
    // `wx` create is the cross-process arbitration primitive — with two OS processes released
    // simultaneously from a shared barrier, exactly one may open the anchor; the other conflicts.
    const dir = fixture("r12-race"); const barrier = join(dir, "barrier"); mkdirSync(barrier);
    const workerSrc = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, hookSession, requestId, recorderHref, barrier] = process.argv.slice(2);
const { createSubmission, readSubmission } = await import(recorderHref);
writeFileSync(join(barrier, 'ready-' + process.pid), String(process.pid));
let deadline = Date.now() + 15000;
while (!existsSync(join(barrier, 'GO'))) { if (Date.now() > deadline) { process.stderr.write('worker barrier timeout'); process.exit(2); } }
const before = readSubmission(dir, hookSession);
const r = createSubmission(dir, { requestId, hookSessionId: hookSession, cwd: dir });
process.stdout.write(JSON.stringify({ pid: process.pid, requestId, created: r.created, conflict: r.conflict, error: r.error, sawNull: before === null }));
`;
    const worker = join(dir, "race-worker.mjs"); writeFileSync(worker, workerSrc);
    const recorderHref = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "event-recorder.mjs")).href;
    const collect = proc => new Promise((res, rej) => {
      let out = ""; let err = "";
      proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => err += d);
      proc.on("close", code => code === 0 ? res(out) : rej(Error(`child exit ${code}: ${err || out}`)));
    });
    const reqA = "race-aaa-111"; const reqB = "race-bbb-222";
    const procA = spawn(process.execPath, [worker, dir, HOOK_SESSION, reqA, recorderHref, barrier], { windowsHide: true });
    const procB = spawn(process.execPath, [worker, dir, HOOK_SESSION, reqB, recorderHref, barrier], { windowsHide: true });
    const outA = collect(procA); const outB = collect(procB);
    const readyA = join(barrier, `ready-${procA.pid}`); const readyB = join(barrier, `ready-${procB.pid}`);
    const release = Date.now() + 15000;
    while (!(existsSync(readyA) && existsSync(readyB))) { if (Date.now() > release) { failRenameTo = null; throw Error("two-process barrier timeout"); } }
    writeFileSync(join(barrier, "GO"), "go");
    const results = [JSON.parse(await outA), JSON.parse(await outB)];
    const winners = results.filter(r => r.created === true);
    const losers = results.filter(r => r.conflict === true && r.created === false);
    assert.equal(winners.length, 1, `exactly one process must win the exclusive create, got ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1, "the other process must observe a conflict, never a second open");
    const disk = readSubmission(dir, HOOK_SESSION);
    assert.equal(disk.requestId, winners[0].requestId, "the on-disk anchor must be the single winner, never the loser");
    assert.equal(disk.ambiguous, false); assert.equal(disk.terminal, false);
  }
  {
    // session/cwd mismatches fail closed; no receipt is written for them
    const dir = fixture("sess"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const wrongSession = await handle({ hook_event_name: "Stop", session_id: "sess_evil", cwd: dir }, { dataDir: dir, transport: mk() });
    assert.equal(wrongSession.state, "uncorrelated"); assert(wrongSession.failClosed);
    const wrongCwd = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION, cwd: join(dir, "elsewhere") }, { dataDir: dir });
    assert.equal(wrongCwd.state, "uncorrelated");
    const missingCwd = await handle({ hook_event_name: "Stop", session_id: HOOK_SESSION }, { dataDir: dir });
    assert.equal(missingCwd.state, "uncorrelated"); assert(missingCwd.diagnostics.some(d => d.code === "hook_input_cwd_missing"));
    assert(!existsSync(join(dir, `receipt-stop_observed-${b.requestId}.json`)));
  }
  {
    // R2: a forged "accepted" receipt must NOT be reported as alreadyNotified with 0 sends
    const dir = fixture("r2-forged"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const fe = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION }, b);
    writeFileSync(join(dir, fe.evidenceRef), JSON.stringify({
      schemaVersion: 1, dedupKey: `${REQ}:input_observed`,
      identity: { requestId: REQ, signal: "input_observed", workspaceId: WORKSPACE, sessionId: SESSION,
        hookSessionId: HOOK_SESSION, targetTaskId: TARGET_TASK, targetCwd: TARGET_CWD, cwd: dir },
      event: fe, receivedAt: new Date().toISOString(),
      sent: false, dispatchAttempted: false, sendState: "accepted",
    }));
    const cap = mockTransport();
    const res = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: cap });
    assert.equal(res.state, "uncorrelated"); assert.equal(res.conflict, true);
    assert.notEqual(res.alreadyNotified, true, "a forged accepted receipt must not be reported as already notified");
    assert.equal(cap.methods.length, 0); assert.equal(cap.sent.length, 0);
  }
  {
    // R4: valid binding, missing host config -> recorded_not_dispatched (genuinely NOT sent), not uncertain
    const dir = fixture("nocfg"); const b = makeBinding(dir);
    const up = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: mk() });
    assert.equal(up.state, "recorded_not_dispatched"); assert.equal(up.notified, false);
    assert(up.diagnostics.some(d => d.code === "host_config_missing"));
    const rec = JSON.parse(readFileSync(join(dir, `receipt-input_observed-${b.requestId}.json`), "utf8"));
    assert.equal(rec.sendState, "recorded"); assert.equal(rec.dispatchAttempted, false);
  }
  {
    // R4: an invalid pipe configuration is rejected before the host call -> recorded_not_dispatched
    const dir = fixture("r4-pipe"); const b = makeBinding(dir);
    const script = join(dir, "adapter.mjs"); writeFileSync(script, "");
    writeFileSync(join(dir, "host-config.json"), JSON.stringify({ script, pipePath: "\\\\.\\pipe\\bad\u0000pipe", threadId: b.targetTaskId, cwd: b.targetCwd, expiresAt: b.expiresAt }));
    const cap = mockTransport();
    const res = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport: cap });
    assert.equal(res.state, "recorded_not_dispatched"); assert(res.diagnostics.some(d => d.code === "host_pipe_invalid"));
    assert.equal(cap.methods.length, 0, "an invalid pipe must never reach the host");
    const rec = JSON.parse(readFileSync(join(dir, `receipt-input_observed-${b.requestId}.json`), "utf8"));
    assert.equal(rec.sendState, "recorded"); assert.equal(rec.dispatchAttempted, false);
  }
  {
    // R4: a synchronous spawn rejection after valid config is NOT-dispatched and redacted
    const dir = fixture("r4-spawn"); const b = makeBinding(dir); writeHostConfig(dir, b);
    const secret = "SECRET_CREDENTIAL_MUST_NOT_LEAK";
    const transport = { spawnProcess: () => { throw Error(`spawn ${secret} ERR_INVALID_ARG_VALUE`); }, timeoutMs: 50 };
    const res = await handle({ hook_event_name: "UserPromptSubmit", session_id: HOOK_SESSION, cwd: dir, prompt: `QODER_RETURN_REQUEST=${b.requestId}` }, { dataDir: dir, transport });
    assert.equal(res.state, "recorded_not_dispatched");
    assert(res.diagnostics.some(d => d.code === "host_spawn_failed"));
    assert(!JSON.stringify(res).includes(secret), "the raw spawn error/credential must not reach the caller");
    const rec = JSON.parse(readFileSync(join(dir, `receipt-input_observed-${b.requestId}.json`), "utf8"));
    assert.equal(rec.sendState, "recorded"); assert.equal(rec.dispatchAttempted, false, "a spawn-time rejection is not an attempted send");
  }

  // createBinding argument validation
  const cb1 = fixture("cb1");
  assert.throws(() => createBinding(cb1, "bad id", WORKSPACE, SESSION, HOOK_SESSION, cb1, TARGET_TASK, TARGET_CWD, EXPIRES), /requestId/);
  assert.throws(() => createBinding(fixture("cb2"), "req1", "bad-ws", SESSION, HOOK_SESSION, root, TARGET_TASK, TARGET_CWD, EXPIRES), /workspaceId/);
  assert.throws(() => createBinding(fixture("cb3"), "req2", WORKSPACE, "bad-sess", HOOK_SESSION, root, TARGET_TASK, TARGET_CWD, EXPIRES), /sessionId/);
  assert.throws(() => createBinding(fixture("cb4"), "req3", WORKSPACE, SESSION, "bad/../sess", root, TARGET_TASK, TARGET_CWD, EXPIRES), /hookSessionId/);
  assert.throws(() => createBinding(fixture("cb5"), "req4", WORKSPACE, SESSION, HOOK_SESSION, root, TARGET_TASK, TARGET_CWD, "2000-01-01T00:00:00Z"), /expiresAt/);

  // ---- manifest / hooks semantic validation (P3) ----
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const shipped = validatePluginConfig(pluginDir);
  assert.equal(shipped.ok, true, `shipped config must be spec-valid: ${JSON.stringify(shipped.diagnostics)}`);
  assert(JSON.parse(readFileSync(join(pluginDir, ".qoder-plugin", "plugin.json"), "utf8")).hooks === "./hooks/hooks.json");
  assert(JSON.parse(readFileSync(join(pluginDir, ".qoder-plugin", "plugin.json"), "utf8")).mcpServers === "./mcp.json");
  const shippedHooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"));
  assert(Object.values(shippedHooks.hooks).every(g => g.every(m => m.hooks.every(h => h.type === "command" && !("args" in h) && !("timeoutMs" in h)))));

  assert(validateManifestObject({ name: "bad Name!", version: "0.1.0", hooks: "./hooks/hooks.json" }).some(d => d.path === "manifest.name"));
  assert(validateManifestObject({ name: "qoder-codex-bridge", version: "0.1.0", hooks: "hooks/hooks.json" }).some(d => d.path === "manifest.hooks"));
  assert(validateManifestObject({ name: "qoder-codex-bridge", version: "0.1.0", hooks: "./hooks/hooks.json", mcpServers: "../outside.json" }).some(d => d.path === "manifest.mcpServers"));
  assert(validateHooksObject({ hooks: { Stop: [{ hooks: [{ type: "process", command: "node", timeoutMs: 5 }] }] } })
    .some(d => /legacy ZCode|only Qoder command-type/.test(d.message)));
  // args is valid Qoder exec-form but outside this plugin's shell-string subset (P3)
  assert(validateHooksObject({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node \"${QODER_PLUGIN_ROOT}/hooks/handler.mjs\"", args: ["x"] }] }] } })
    .some(d => /shell-string command subset/.test(d.message)));
  // Fail-closed BEFORE reading the hooks body: an escaping reference is refused and the
  // target is provably never opened (trap is a valid readable body, so ok=false is not a lucky miss).
  const escapedDir = fixture("escaped-plugin"); mkdirSync(join(escapedDir, ".qoder-plugin"), { recursive: true });
  writeFileSync(join(escapedDir, ".qoder-plugin", "plugin.json"), JSON.stringify({ name: "ok-name", version: "0.1.0", hooks: "../outside-trap.json" }));
  const trapPath = join(root, "outside-trap.json");
  writeFileSync(trapPath, JSON.stringify({ hooks: shippedHooks.hooks }));
  const readSeen = [];
  const escaped = validatePluginConfig(escapedDir, { read: p => { readSeen.push(resolve(p)); return readFileSync(p, "utf8"); } });
  assert.equal(escaped.ok, false);
  assert(escaped.diagnostics.some(d => d.source === "plugin.json" && /escapes the plugin root/.test(d.message)));
  assert(readSeen.includes(resolve(join(escapedDir, ".qoder-plugin", "plugin.json"))));
  assert(!readSeen.includes(resolve(trapPath)), "escaping hooks body must NOT be read");
  assert(readSeen.every(p => p.startsWith(resolve(escapedDir))));

  console.log("qoder-codex-bridge: standalone-line marker only (in-sentence/NOT_/duplicate rejected), durable cross-call quarantine survives a real rename EIO so a later Stop/StopFailure cannot trust a stale active anchor, exclusive-create arbitration, full anchor-shape validation, identity+event+state receipt consistency (incl. targetCwd), and config-vs-spawn failures classified as not-dispatched all OK");
} finally { rmSync(root, { recursive: true, force: true }); }
