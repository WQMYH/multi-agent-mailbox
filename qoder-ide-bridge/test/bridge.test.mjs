import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activateConversation, listInstances, readConfig, readIdentity, runToolkit,
  readConversationStatus, readMessageOwner, sendCurrentConversation } from "../../modules/agent-qoder-ide/client.mjs";

const require = createRequire(import.meta.url);
const { startBridge } = require("../extension/extension.cjs");
const { collect } = require("../extension/hook-collector.cjs");
const { claimMutation, ownerIdForStateDir, readMessage, reserveMessage } = require("../extension/message-store.cjs");
const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "qoder-ide-bridge-test-")));
const workspace = join(root, "workspace");
const addedWorkspace = join(root, "added-workspace");
const fixture = join(workspace, "fixture-mod");
const outside = join(root, "outside");
const stateDir = join(root, "instances");
const configPath = join(root, "config.json");
const token = "test-token-0123456789-abcdefghijklmnop";
const instanceId = "11111111-1111-4111-8111-111111111111";
const commandCalls = [];
for (const path of [workspace, addedWorkspace, fixture, outside]) mkdirSync(path, { recursive: true });
writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, token, stateDir,
  allowedCommands: ["px.runTiger", "px.reloadScriptDocs", "px.dumpIndexStats",
    "aicoding.chat.history", "workbench.action.aichat.sendText"], timeoutMs: 100 }));

let commandCatalogGate, commandExecutionGate, dumpExecutionGate;
function gate(skipLookups = 0) {
  let enter, release;
  return { entered: new Promise(resolveEntered => { enter = resolveEntered; }),
    wait: new Promise(resolveWait => { release = resolveWait; }), enter, release, skipLookups };
}
const fake = {
  env: { uriScheme: "qoder-cn", appName: "Qoder CN IDE", appHost: "desktop" },
  version: "1.106.3",
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspace } }],
    getConfiguration: () => ({ get: (key, fallback) => key === "configPath" ? configPath : fallback })
  },
  Uri: { file: fsPath => ({ scheme: "file", fsPath }) },
  commands: {
    getCommands: async () => {
      const pending = commandCatalogGate;
      if (pending && pending.skipLookups-- <= 0 && !pending.lookupEntered) {
        pending.lookupEntered = true; pending.enter(); await pending.wait;
      }
      return ["px.runTiger", "px.reloadScriptDocs", "px.dumpIndexStats",
        "aicoding.chat.history", "workbench.action.aichat.sendText"];
    },
    executeCommand: async (command, ...args) => {
      commandCalls.push({ command, args });
      if (command === "workbench.action.aichat.sendText" && commandExecutionGate) {
        const pending = commandExecutionGate;
        pending.enter();
        await pending.wait;
      }
      if (command === "px.dumpIndexStats" && dumpExecutionGate) {
        const pending = dumpExecutionGate;
        pending.enter();
        await pending.wait;
      }
      return undefined;
    }
  }
};
const context = { subscriptions: [] };

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolveRun({ status, stdout, stderr }));
  });
}

function reserveDirect(store, requestId, allocatedBytes, content = "direct page message") {
  mkdirSync(store, { recursive: true });
  const ownerId = ownerIdForStateDir(store);
  claimMutation({ stateDir: store, requestId, instanceId, workspace,
    command: "workbench.action.aichat.sendText", ownerId, allocatedBytes });
  const status = reserveMessage({ stateDir: store, requestId, deliveryId: requestId, correlation: requestId,
    instanceId, workspace, content, ownerId, allocatedBytes });
  return { ownerId, status };
}

function storeBytes(store) {
  return ["message-reservations", "request-reservations"].reduce((total, name) => {
    const dir = join(store, name);
    return total + (existsSync(dir) ? readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0) : 0);
  }, 0);
}

function reserveInChild(store, requestId, allocatedBytes) {
  const modulePath = resolve(here, "../extension/message-store.cjs");
  const script = `const { mkdirSync } = require("node:fs");
const { claimMutation, ownerIdForStateDir, reserveMessage } = require(${JSON.stringify(modulePath)});
const store = ${JSON.stringify(store)}, requestId = ${JSON.stringify(requestId)};
const workspace = ${JSON.stringify(workspace)}, instanceId = ${JSON.stringify(instanceId)};
const allocatedBytes = ${allocatedBytes}; mkdirSync(store, { recursive: true });
const ownerId = ownerIdForStateDir(store); let claimed = false;
function attempt() { try { if (!claimed) { claimMutation({ stateDir: store, requestId, instanceId, workspace,
    command: "workbench.action.aichat.sendText", ownerId, allocatedBytes }); claimed = true; }
    reserveMessage({ stateDir: store, requestId, deliveryId: requestId, correlation: requestId, instanceId, workspace,
      content: "child page message", ownerId, allocatedBytes }); process.stdout.write("accepted"); }
  catch (error) { if (error.code === "OWNER_BUSY") return setTimeout(attempt, 1);
    process.stdout.write(error.code || error.message); } }
attempt();`;
  return runCli(["-e", script]);
}

function crashHookChild(store, requestId, config, raw) {
  const modulePath = resolve(here, "../extension/message-store.cjs");
  const target = join(store, "message-reservations", `${requestId}.json`);
  const script = `const fs = require("node:fs"), originalRename = fs.renameSync;
const target = ${JSON.stringify(target)};
fs.renameSync = (from, to) => { if (to === target && from.endsWith(".tmp")) {
  // Seed the retained lock format of a crashed source4 process as well.
  fs.writeFileSync(require("node:path").join(require("node:path").dirname(target), ".owner.lock"),
    JSON.stringify({ ownerId: store.ownerIdForStateDir(${JSON.stringify(store)}), pid: process.pid,
      createdAt: new Date().toISOString() }), { flag: "wx" });
  process.exit(92); }
  return originalRename(from, to); };
const store = require(${JSON.stringify(modulePath)});
store.collectHook(${JSON.stringify(raw)}, ${JSON.stringify(config)});`;
  return runCli(["-e", script]);
}

function readMessageChild(store, requestId) {
  const modulePath = resolve(here, "../extension/message-store.cjs");
  return runCli(["-e", `const { readMessage } = require(${JSON.stringify(modulePath)});
const deadline = Date.now() + 5000;
function read() { try { process.stdout.write(JSON.stringify(readMessage(${JSON.stringify(store)}, ${JSON.stringify(requestId)}))); }
  catch (error) { if (error.code === "OWNER_BUSY" && Date.now() < deadline) return setTimeout(read, 5); throw error; } }
read();`]);
}

function crashRecoveryChild(store, requestId) {
  const modulePath = resolve(here, "../extension/message-store.cjs");
  return runCli(["-e", `const fs = require("node:fs");
// The kernel gate is already held at the first scan. No recovery cleanup has run.
fs.readdirSync = () => process.exit(93);
const { readMessage } = require(${JSON.stringify(modulePath)});
readMessage(${JSON.stringify(store)}, ${JSON.stringify(requestId)});`]);
}

async function holdStoreInChild(store, requestId) {
  const modulePath = resolve(here, "../extension/message-store.cjs");
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs");
fs.readdirSync = () => { fs.writeSync(1, "held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
require(${JSON.stringify(modulePath)}).readMessage(${JSON.stringify(store)}, ${JSON.stringify(requestId)});`],
  { windowsHide: true });
  const closed = new Promise(resolveClose => child.once("close", resolveClose));
  await new Promise((resolveHeld, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error("lock-holder child did not acquire the gate")); }, 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(Error(`lock-holder child exited ${code}`)); });
    child.stdout.once("data", data => { clearTimeout(timer); assert.equal(String(data), "held"); resolveHeld(); });
  });
  return { child, closed };
}

let bridge;
try {
  bridge = await startBridge(fake, context, { env: {}, randomUUID: () => instanceId,
    pid: 4242, executable: "D:\\Program Files\\Qoder CN IDE\\Qoder CN IDE.exe", now: () => 1700000000000 });
  const config = readConfig(configPath);
  const instances = listInstances(config);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].instanceId, instanceId);
  assert.equal(Object.hasOwn(instances[0], "endpoint"), false, "public discovery omits transport endpoint");

  const identity = await readIdentity({ instanceId, workspace }, config);
  assert.equal(identity.target.id, "qoder-cn-ide");
  assert.equal(identity.identity.uriScheme, "qoder-cn");
  assert.equal(identity.identity.vscodeVersion, "1.106.3");
  const pageOwnerId = identity.identity.messageOwnerId;
  assert.equal(identity.identity.capabilities.mutationOwnerBudget, true);
  assert.equal(listInstances(config)[0].capabilities.mutationOwnerBudget, true);
  const mutationMeta = { ownerId: pageOwnerId, allocatedBytes: 20_000_000 };
  assert.equal(readMessageOwner(config, instanceId), pageOwnerId, "Core adapter and bridge use the same store owner");
  assert.equal(identity.workspace, workspace);
  assert.deepEqual(identity.registeredCommands, ["px.runTiger", "px.reloadScriptDocs", "px.dumpIndexStats",
    "aicoding.chat.history", "workbench.action.aichat.sendText"]);

  const storeA = join(root, "owner-store-a"), storeB = join(root, "owner-store-b");
  const directA = "12121212-1212-4212-8212-121212121212";
  const directB = "13131313-1313-4313-8313-131313131313";
  const reservedA = reserveDirect(storeA, directA, 200_000);
  const reservedB = reserveDirect(storeB, directB, 200_000);
  assert.notEqual(reservedA.ownerId, reservedB.ownerId, "different persistent stores cannot share one owner allocation");
  assert.equal(ownerIdForStateDir(join(storeA, ".")), reservedA.ownerId, "canonical aliases keep one store identity");
  assert.equal(reservedA.status.reservation.state, "persisted");
  assert.equal(reservedB.status.reservation.state, "persisted");
  const liveLock = join(storeA, "message-reservations", ".owner.lock");
  const liveLockText = JSON.stringify({ ownerId: reservedA.ownerId, pid: process.pid, createdAt: new Date().toISOString() });
  writeFileSync(liveLock, liveLockText, { flag: "wx" });
  assert.throws(() => readMessage(storeA, directA), /store is busy/, "an active PID lock is never stolen by age");
  assert.equal(readFileSync(liveLock, "utf8"), liveLockText);
  rmSync(liveLock);
  const unknownLock = join(storeA, "message-reservations", ".owner.lock.unknown");
  writeFileSync(unknownLock, liveLockText, { flag: "wx" });
  assert.throws(() => readMessage(storeA, directA), /Unknown owner-lock helper was preserved/);
  assert.equal(readFileSync(unknownLock, "utf8"), liveLockText);
  rmSync(unknownLock);

  const held = await holdStoreInChild(storeA, directA);
  try {
    assert.throws(() => readMessage(storeA, directA), error => error.code === "OWNER_BUSY");
    assert.equal(readdirSync(join(storeA, "message-reservations")).some(name => name.startsWith(".owner.lock")), false);
  } finally { held.child.kill(); await held.closed; }
  assert.equal(readMessage(storeA, directA).reservation.state, "persisted",
    "the kernel releases the live gate when its process is forcibly terminated");

  const storeC = join(root, "atomic-store-c"), directC = "14141414-1414-4414-8414-141414141414";
  assert.throws(() => reserveDirect(storeC, directC, 1223), /budget exceeded/,
    "admission rejects the old minimum before a message can be dispatched");
  assert.equal(existsSync(join(storeC, "message-reservations", `${directC}.json`)), false);
  const acceptedC = "15151515-1515-4515-8515-151515151515";
  const tightAllocation = 140_000;
  reserveDirect(storeC, acceptedC, tightAllocation);
  const blockedC = "16161616-1616-4616-8616-161616161616";
  assert.throws(() => reserveDirect(storeC, blockedC, tightAllocation), /budget exceeded/,
    "a later reservation cannot consume committed update headroom");
  const tightConfig = join(root, "tight-config.json");
  writeFileSync(tightConfig, JSON.stringify({ schemaVersion: 1, stateDir: storeC }));
  const tightPath = join(storeC, "message-reservations", `${acceptedC}.json`);
  assert.equal(collect(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "tight-session", cwd: workspace,
    transcript_path: join(root, "tight.jsonl"), request_set_id: "tight-set",
    prompt: `direct page message\n\n[agent-core-request:${acceptedC}]` }), tightConfig), "recorded");
  assert.equal(collect(JSON.stringify({ hook_event_name: "Stop", session_id: "tight-session", cwd: workspace,
    transcript_path: join(root, "tight.jsonl"), request_set_id: "tight-set", stop_hook_active: false,
    last_assistant_message: "\u0000".repeat(8000) }), tightConfig), "recorded");
  const tightRecord = JSON.parse(readFileSync(tightPath, "utf8"));
  assert.equal(tightRecord.reply.state, "observed");
  assert.equal(tightRecord.reply.truncated, true);
  assert.equal(statSync(tightPath).size + statSync(join(storeC, "message-reservations", `${acceptedC}.headroom`)).size,
    2 * 64 * 1024, "record and retained headroom keep the full replacement commitment");
  assert.ok(storeBytes(storeC) <= tightAllocation, "committed reservation and bounded updates remain inside allocation");
  assert.equal(readdirSync(join(storeC, "message-reservations")).some(name => name.endsWith(".tmp")), false);

  const raceStore = join(root, "cross-process-budget-race"), raceAllocation = 140_000;
  const race = await Promise.all([
    reserveInChild(raceStore, "17171717-1717-4717-8717-171717171717", raceAllocation),
    reserveInChild(raceStore, "18181818-1818-4818-8818-181818181818", raceAllocation)
  ]);
  assert.deepEqual(race.map(result => result.stdout).sort(), ["OWNER_BUDGET_EXCEEDED", "accepted"],
    "cross-process claim/message paths share one budget lock and admit exactly one reservation");
  assert.ok(storeBytes(raceStore) <= raceAllocation);

  const crashStore = join(root, "crash-recovery-store");
  const crashRequest = "19191919-1919-4919-8919-191919191919", crashAllocation = 140_000;
  reserveDirect(crashStore, crashRequest, crashAllocation);
  const crashConfig = join(root, "crash-config.json");
  writeFileSync(crashConfig, JSON.stringify({ schemaVersion: 1, stateDir: crashStore }));
  const crashPath = join(crashStore, "message-reservations", `${crashRequest}.json`);
  const crashRoom = join(crashStore, "message-reservations", `${crashRequest}.headroom`);
  const beforeCrash = readFileSync(crashPath, "utf8");
  const crashRaw = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "crash-session", cwd: workspace,
    transcript_path: join(root, "crash.jsonl"), request_set_id: "crash-set",
    prompt: `direct page message\n\n[agent-core-request:${crashRequest}]` });
  const crashed = await crashHookChild(crashStore, crashRequest, crashConfig, crashRaw);
  assert.equal(crashed.status, 92, "child exits after headroom shrink and before atomic rename");
  assert.equal(existsSync(join(crashStore, "message-reservations", ".owner.lock")), true);
  assert.ok(statSync(crashPath).size + statSync(crashRoom).size < 2 * 64 * 1024);
  assert.equal(readFileSync(crashPath, "utf8"), beforeCrash, "pre-rename crash keeps the old atomic record");
  assert.equal(readdirSync(join(crashStore, "message-reservations")).some(name => name.endsWith(".tmp")), true);

  const crashFiles = readdirSync(join(crashStore, "message-reservations")).sort();
  const crashBytes = storeBytes(crashStore);
  const crashCommitment = statSync(crashPath).size + statSync(crashRoom).size;
  for (let round = 0; round < 80; round += 1) {
    const recoveryCrash = await crashRecoveryChild(crashStore, crashRequest);
    assert.equal(recoveryCrash.status, 93, recoveryCrash.stderr);
    assert.deepEqual(readdirSync(join(crashStore, "message-reservations")).sort(), crashFiles);
    assert.equal(storeBytes(crashStore), crashBytes, `recovery crash ${round + 1} adds no helper bytes`);
    assert.ok(crashBytes <= crashAllocation);
    assert.equal(readFileSync(crashPath, "utf8"), beforeCrash);
    assert.equal(statSync(crashPath).size + statSync(crashRoom).size, crashCommitment);
  }
  console.log(`recovery crash bound: rounds=80, bytes=${crashBytes}, allocation=${crashAllocation}, addedHelperBytes=0`);

  const recoveredReads = await Promise.all([readMessageChild(crashStore, crashRequest), readMessageChild(crashStore, crashRequest)]);
  for (const recovered of recoveredReads) {
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).providerAcceptance.state, "unknown",
      "maintenance read repairs storage but does not consume the uncommitted provider update");
  }
  assert.equal(readFileSync(crashPath, "utf8"), beforeCrash);
  assert.equal(statSync(crashPath).size + statSync(crashRoom).size, 2 * 64 * 1024);
  assert.equal(readdirSync(join(crashStore, "message-reservations")).some(name => name.endsWith(".tmp")), false);
  assert.equal(existsSync(join(crashStore, "message-reservations", ".owner.lock")), false);
  assert.equal(collect(crashRaw, crashConfig), "recorded", "a later Hook persists after dead-lock recovery");
  assert.equal(collect(JSON.stringify({ hook_event_name: "Stop", session_id: "crash-session", cwd: workspace,
    transcript_path: join(root, "crash.jsonl"), request_set_id: "crash-set", stop_hook_active: false,
    last_assistant_message: "\u0000".repeat(8000) }), crashConfig), "recorded");
  assert.equal(statSync(crashPath).size + statSync(crashRoom).size, 2 * 64 * 1024);
  assert.ok(storeBytes(crashStore) <= crashAllocation);

  const tigerRequest = "22222222-2222-4222-8222-222222222222";
  const tiger = await runToolkit({ ...mutationMeta, instanceId, workspace, requestId: tigerRequest,
    command: "px.runTiger", targetPath: fixture }, config);
  assert.equal(tiger.state, "accepted");
  assert.equal(tiger.completion, "unobservable_after_command_return");
  assert.equal(tiger.retrySafe, false);
  assert.equal(commandCalls.at(-1).command, "px.runTiger");
  assert.equal(commandCalls.at(-1).args[0].fsPath, fixture);
  await assert.rejects(() => runToolkit({ ...mutationMeta, instanceId, workspace, requestId: tigerRequest,
    command: "px.runTiger", targetPath: fixture }, config), /not replayed/);
  await assert.rejects(() => runToolkit({ ...mutationMeta, instanceId, workspace, requestId: "33333333-3333-4333-8333-333333333333",
    command: "px.runTiger", targetPath: outside }, config), /inside the selected workspace/);
  await assert.rejects(() => readIdentity({ instanceId, workspace: outside }, config), /not open/);
  await assert.rejects(() => readIdentity({ instanceId, workspace }, { ...config, token: `${token}x` }), /Unauthorized/);

  fake.workspace.workspaceFolders = [];
  await assert.rejects(() => readIdentity({ instanceId, workspace }, config), /not open/);
  fake.workspace.workspaceFolders = [{ uri: { fsPath: addedWorkspace } }];
  const addedIdentity = await readIdentity({ instanceId, workspace: addedWorkspace }, config);
  assert.deepEqual(addedIdentity.identity.workspaces, [addedWorkspace]);

  fake.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
  commandCatalogGate = gate(1); // Skip the authenticated capability probe; hold the actual command lookup.
  const closeBeforeDispatchCount = commandCalls.length;
  const closesDuringLookup = runToolkit({ ...mutationMeta, instanceId, workspace,
    requestId: "66666666-6666-4666-8666-666666666666", command: "px.runTiger", targetPath: fixture }, config);
  await commandCatalogGate.entered;
  const replacedReservation = join(stateDir, "request-reservations", "66666666-6666-4666-8666-666666666666.json");
  rmSync(replacedReservation);
  const replacement = JSON.stringify({ owner: "another bridge instance" });
  writeFileSync(replacedReservation, replacement, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fake.workspace.workspaceFolders = [];
  commandCatalogGate.release();
  await assert.rejects(closesDuringLookup, /not open/);
  assert.equal(commandCalls.length, closeBeforeDispatchCount, "closed workspace cannot dispatch after awaited command lookup");
  assert.equal(readFileSync(replacedReservation, "utf8"), replacement,
    "pre-dispatch cleanup cannot delete another bridge instance's replacement reservation");
  commandCatalogGate = undefined;

  fake.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
  commandCatalogGate = gate(1);
  const duplicateBefore = commandCalls.length;
  const duplicateArgs = { ...mutationMeta, instanceId, workspace, requestId: "77777777-7777-4777-8777-777777777777",
    command: "px.runTiger", targetPath: fixture };
  const first = runToolkit(duplicateArgs, config);
  await commandCatalogGate.entered;
  await assert.rejects(() => runToolkit(duplicateArgs, config), /already reserved/);
  commandCatalogGate.release();
  assert.equal((await first).state, "accepted");
  assert.equal(commandCalls.length, duplicateBefore + 1, "concurrent duplicate requestId dispatches exactly once");
  commandCatalogGate = undefined;

  fake.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
  commandCatalogGate = gate(1);
  const addBeforeDispatchCount = commandCalls.length;
  const addsDuringLookup = runToolkit({ ...mutationMeta, instanceId, workspace,
    requestId: "88888888-8888-4888-8888-888888888888", command: "px.reloadScriptDocs" }, config);
  await commandCatalogGate.entered;
  fake.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }, { uri: { fsPath: addedWorkspace } }];
  commandCatalogGate.release();
  await assert.rejects(addsDuringLookup, /single-folder/);
  assert.equal(commandCalls.length, addBeforeDispatchCount, "multi-root change cannot dispatch a no-argument command");
  assert.equal(existsSync(join(stateDir, "request-reservations", "88888888-8888-4888-8888-888888888888.json")), true,
    "a pre-dispatch failure remains reserved and requires a fresh requestId");
  commandCatalogGate = undefined;
  fake.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];

  const reload = await runToolkit({ ...mutationMeta, instanceId, workspace, requestId: "44444444-4444-4444-8444-444444444444",
    command: "px.reloadScriptDocs" }, config);
  assert.equal(reload.state, "completed");
  assert.equal(reload.completion, "command_returned");
  dumpExecutionGate = gate();
  const timeoutRun = runToolkit({ ...mutationMeta, instanceId, workspace, requestId: "55555555-5555-4555-8555-555555555555",
    command: "px.dumpIndexStats" }, config);
  await dumpExecutionGate.entered;
  const timeout = await timeoutRun;
  assert.equal(timeout.state, "unknown");
  assert.equal(timeout.completion, "unknown_after_timeout");
  dumpExecutionGate.release();
  dumpExecutionGate = undefined;

  const activationRequest = "99999999-9999-4999-8999-999999999999";
  const activation = await activateConversation({ ...mutationMeta, instanceId, workspace, requestId: activationRequest,
    sessionId: "session-a", sessionType: "agent", title: "Conversation A" }, config);
  assert.equal(activation.state, "accepted");
  assert.equal(activation.completion, "unobservable_current_page_activation_after_command_return");
  assert.deepEqual(commandCalls.at(-1), { command: "aicoding.chat.history",
    args: ["session-a", "agent", "Conversation A", undefined] });
  assert.equal(existsSync(join(stateDir, "request-reservations", `${activationRequest}.json`)), true);
  await assert.rejects(() => activateConversation({ ...mutationMeta, instanceId, workspace, requestId: activationRequest,
    sessionId: "session-a", sessionType: "agent", title: "Conversation A" }, config), /reserved/);

  const sendRequest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sendMeta = requestId => ({ ...mutationMeta, deliveryId: requestId, correlation: requestId });
  const currentSend = await sendCurrentConversation({ instanceId, workspace, requestId: sendRequest,
    content: "hello current page", ...sendMeta(sendRequest) }, config);
  assert.equal(currentSend.state, "unknown");
  assert.equal(currentSend.completion, "current_page_command_returned_delivery_unobserved");
  assert.equal(currentSend.retrySafe, false);
  assert.deepEqual(commandCalls.at(-1), { command: "workbench.action.aichat.sendText", args: [{
    isNewChat: false, content: `hello current page\n\n[agent-core-request:${sendRequest}]`,
    isSend: true, chatMode: "agent" }] });
  assert.equal(existsSync(join(stateDir, "message-reservations", `${sendRequest}.json`)), true);
  await assert.rejects(() => sendCurrentConversation({ instanceId, workspace, requestId: sendRequest,
    content: "must not replay", ...sendMeta(sendRequest) }, config), /reserved/);

  const transcriptPath = join(root, "conversation.jsonl");
  const submitted = { hook_event_name: "UserPromptSubmit", session_id: "native-session-a", cwd: workspace,
    transcript_path: transcriptPath, request_set_id: "native-request-a", prompt: commandCalls.at(-1).args[0].content };
  assert.equal(collect(JSON.stringify(submitted), configPath), "recorded");
  const pendingReply = await readConversationStatus({ instanceId, workspace, requestId: sendRequest }, config);
  assert.equal(pendingReply.state, "provider_accepted");
  assert.equal(pendingReply.reply.state, "pending");
  assert.equal(collect(JSON.stringify({ hook_event_name: "Stop", session_id: "native-session-a", cwd: workspace,
    transcript_path: transcriptPath, request_set_id: "wrong-request", stop_hook_active: false,
    last_assistant_message: "wrong reply" }), configPath), "unattributable");
  assert.equal((await readConversationStatus({ instanceId, workspace, requestId: sendRequest }, config)).reply.state, "pending");
  assert.equal(collect(JSON.stringify({ hook_event_name: "Stop", session_id: "native-session-a", cwd: workspace,
    transcript_path: transcriptPath, request_set_id: "native-request-a", stop_hook_active: false,
    last_assistant_message: "corresponding reply" }), configPath), "recorded");
  const observedReply = await readConversationStatus({ instanceId, workspace, requestId: sendRequest }, config);
  assert.equal(observedReply.state, "reply_observed");
  assert.equal(observedReply.reply.preview, "corresponding reply");
  assert.equal(observedReply.businessAcceptance, "unobserved");
  assert.deepEqual(await readConversationStatus({ instanceId, workspace, requestId: sendRequest }, config), observedReply,
    "status reads do not consume or acknowledge the reply");

  const conflictRequest = "abababab-abab-4bab-8bab-abababababab";
  await sendCurrentConversation({ instanceId, workspace, requestId: conflictRequest,
    content: "conflict attribution", ...sendMeta(conflictRequest) }, config);
  const conflictPrompt = commandCalls.at(-1).args[0].content;
  const firstProvider = { hook_event_name: "UserPromptSubmit", session_id: "native-session-conflict-a",
    cwd: workspace, transcript_path: join(root, "conflict-a.jsonl"), request_set_id: "native-conflict-a",
    prompt: conflictPrompt };
  assert.equal(collect(JSON.stringify(firstProvider), configPath), "recorded");
  assert.equal(collect(JSON.stringify(firstProvider), configPath), "duplicate", "an exact native duplicate is idempotent");
  assert.equal(collect(JSON.stringify({ ...firstProvider, session_id: "native-session-conflict-b",
    transcript_path: join(root, "conflict-b.jsonl"), request_set_id: "native-conflict-b" }), configPath), "conflict");
  const conflicted = await readConversationStatus({ instanceId, workspace, requestId: conflictRequest }, config);
  assert.equal(conflicted.providerAcceptance.state, "unknown");
  assert.deepEqual(conflicted.reply, { state: "quarantined", reason: "provider_attribution_conflict" });

  const noSetRequest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await sendCurrentConversation({ instanceId, workspace, requestId: noSetRequest,
    content: "no native request set", ...sendMeta(noSetRequest) }, config);
  assert.equal(collect(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-session-b", cwd: workspace,
    transcript_path: join(root, "no-set.jsonl"), prompt: commandCalls.at(-1).args[0].content }), configPath), "recorded");
  assert.deepEqual((await readConversationStatus({ instanceId, workspace, requestId: noSetRequest }, config)).reply,
    { state: "unsupported", reason: "native_request_set_id_unavailable" });

  commandExecutionGate = gate();
  const serialBefore = commandCalls.length;
  const firstSerialId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const secondSerialId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const firstSerial = sendCurrentConversation({ instanceId, workspace, requestId: firstSerialId,
    content: "first serialized write", ...sendMeta(firstSerialId) }, config);
  await commandExecutionGate.entered;
  const secondSerial = sendCurrentConversation({ instanceId, workspace, requestId: secondSerialId,
    content: "second serialized write", ...sendMeta(secondSerialId) }, config);
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  assert.equal(commandCalls.length, serialBefore + 1, "a second caller cannot enter a page write concurrently");
  commandExecutionGate.release();
  await Promise.all([firstSerial, secondSerial]);
  assert.equal(commandCalls.length, serialBefore + 2);
  commandExecutionGate = undefined;

  commandExecutionGate = gate();
  const timeoutLaneBefore = commandCalls.length;
  const timeoutLaneId = "15151515-1515-4515-8515-151515151515";
  const afterTimeoutId = "16161616-1616-4616-8616-161616161616";
  const timedPage = sendCurrentConversation({ instanceId, workspace, requestId: timeoutLaneId,
    content: "native promise remains pending", ...sendMeta(timeoutLaneId) }, config);
  await commandExecutionGate.entered;
  const timedPageResult = await timedPage;
  assert.equal(timedPageResult.state, "unknown");
  assert.equal(timedPageResult.completion, "unknown_after_timeout");
  const afterTimedPage = sendCurrentConversation({ instanceId, workspace, requestId: afterTimeoutId,
    content: "must wait for real settlement", ...sendMeta(afterTimeoutId) }, config);
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  assert.equal(commandCalls.length, timeoutLaneBefore + 1,
    "an unknown timed-out native promise keeps the mutating lane isolated");
  assert.equal((await readConversationStatus({ instanceId, workspace, requestId: timeoutLaneId }, config)).state,
    "delivery_unobserved", "read/status remains available while the mutating lane is isolated");
  commandExecutionGate.release();
  await afterTimedPage;
  assert.equal(commandCalls.length, timeoutLaneBefore + 2, "real native settlement releases the mutating lane");
  commandExecutionGate = undefined;

  const budgetBefore = commandCalls.length;
  const budgetRequest = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  for (const invoke of [args => runToolkit({ ...args, command: "px.dumpIndexStats" }, config),
    args => activateConversation({ ...args, sessionId: "session-a", sessionType: "agent", title: "A" }, config)]) {
    await assert.rejects(() => invoke({ instanceId, workspace, requestId: budgetRequest }), /ownerId/);
    await assert.rejects(() => invoke({ ...mutationMeta, instanceId, workspace,
      requestId: budgetRequest, allocatedBytes: 1 }), /budget exceeded/);
    await assert.rejects(() => invoke({ ...mutationMeta, instanceId, workspace,
      requestId: budgetRequest, deliveryId: budgetRequest }), /only accepted by current-page send/);
    assert.equal(existsSync(join(stateDir, "request-reservations", `${budgetRequest}.json`)), false);
  }
  await assert.rejects(() => sendCurrentConversation({ instanceId, workspace, requestId: budgetRequest,
    content: "must be backpressured", ...sendMeta(budgetRequest), allocatedBytes: 1 }, config), /budget exceeded/);
  assert.equal(commandCalls.length, budgetBefore, "budget rejection occurs before command dispatch");

  const cli = resolve(here, "../../modules/agent-qoder-ide/cli.mjs");
  const cliList = await runCli([cli, "--config", configPath, "instances"]);
  assert.equal(cliList.status, 0, cliList.stderr);
  assert.equal(JSON.parse(cliList.stdout).instances[0].instanceId, instanceId);
  const cliIdentity = await runCli([cli, "--config", configPath, "identity", instanceId, workspace]);
  assert.equal(cliIdentity.status, 0, cliIdentity.stderr);
  assert.equal(JSON.parse(cliIdentity.stdout).startupStatus, "ready");

  await bridge.dispose(); bridge = undefined;
  const restartedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  bridge = await startBridge(fake, context, { env: {}, randomUUID: () => restartedId,
    pid: 4343, executable: "D:\\Program Files\\Qoder CN IDE\\Qoder CN IDE.exe", now: () => 1700000001000 });
  const callsBeforePersistentReplay = commandCalls.length;
  await assert.rejects(() => sendCurrentConversation({ instanceId: restartedId, workspace, requestId: sendRequest,
    content: "must remain reserved after restart", ...sendMeta(sendRequest) }, config), /persistently reserved/);
  await assert.rejects(() => runToolkit({ ...mutationMeta, instanceId: restartedId, workspace, requestId: sendRequest,
    command: "px.reloadScriptDocs" }, config), /persistently reserved/);
  await assert.rejects(() => sendCurrentConversation({ instanceId: restartedId, workspace, requestId: tigerRequest,
    content: "cross-type replay must remain blocked", ...sendMeta(tigerRequest) }, config), /persistently reserved/);
  assert.equal(commandCalls.length, callsBeforePersistentReplay, "restart cannot replay a persistently reserved requestId");

  await assert.rejects(() => startBridge({ ...fake, env: { ...fake.env, uriScheme: "vscode" } }, { subscriptions: [] },
    { env: {}, randomUUID: () => "66666666-6666-4666-8666-666666666666" }), /requires Qoder/);
} finally {
  await bridge?.dispose();
  assert.equal(existsSync(join(stateDir, `${instanceId}.json`)), false, "dispose removes only its instance record");
  rmSync(root, { recursive: true, force: true });
}

console.log("qoder-ide bridge tests passed");
