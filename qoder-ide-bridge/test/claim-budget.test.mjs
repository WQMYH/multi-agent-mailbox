import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleRegistry } from "../../modules/agent-core/src/registry.mjs";
import { run as runIdeCli } from "../../modules/agent-qoder-ide/cli.mjs";
import { readConfig, readIdentity } from "../../modules/agent-qoder-ide/client.mjs";

const require = createRequire(import.meta.url);
const { claimMutation, ownerIdForStateDir, reserveMessage } = require("../extension/message-store.cjs");
const { collect } = require("../extension/hook-collector.cjs");
const here = dirname(fileURLToPath(import.meta.url));
// Private store and Core registry only. Keep the admitted records for independent inspection.
const root = mkdtempSync(join(process.env.QODER_IDE_F3_EVIDENCE_DIR || tmpdir(), "qoder-ide-f3-budget-"));
const stateDir = join(root, "store"), workspace = join(root, "workspace");
for (const path of [stateDir, workspace]) mkdirSync(path);
const ownerId = ownerIdForStateDir(stateDir), allocatedBytes = 140_000;
const registryPath = join(root, "registry.json"), configPath = join(root, "bridge.json");
const instanceId = randomUUID();
const commands = ["px.runTiger", "px.reloadScriptDocs", "px.dumpIndexStats", "px.tigerUnused",
  "aicoding.chat.history", "workbench.action.aichat.sendText"];
writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, stateDir,
  token: "private-offline-token-0123456789abcdef", allowedCommands: commands, timeoutMs: 100 }));
writeFileSync(join(stateDir, `${instanceId}.json`), JSON.stringify({ schemaVersion: 1,
  instanceId, productId: "qoder-cn-ide", endpoint: "http://127.0.0.1:1/", workspaces: [workspace], messageOwnerId: ownerId,
  capabilities: { mutationOwnerBudget: true } }));
const registry = new ModuleRegistry({ registryPath });
assert.equal(registry.configureMessageBudget({ ownerIds: [ownerId], defaultOwnerBytes: allocatedBytes }).ok, true);
registry.install(resolve(here, "../../modules/agent-qoder-ide"));
const registryBefore = readFileSync(registryPath);
const configBefore = readFileSync(configPath);
const act = (operation, args) => registry.call("act", { moduleId: "agent-qoder-ide", operation,
  args: { instanceId, workspace, requestId: randomUUID(), ...args } });
const snapshot = () => Object.fromEntries(["request-reservations", "message-reservations"].flatMap(name => {
  const dir = join(stateDir, name);
  return existsSync(dir) ? readdirSync(dir).sort().map(file => [`${name}/${file}`, readFileSync(join(dir, file))]) : [];
}));
const bytes = () => Object.values(snapshot()).reduce((total, value) => total + value.length, 0);
const originalFetch = globalThis.fetch, previousConfig = process.env.QODER_IDE_BRIDGE_CONFIG;
let transportCalls = 0, simulatedDispatches = 0, liveBudgetCapability = true;
globalThis.fetch = async (url, options) => {
  // Transport stub, not a listener or a real IDE. The existing bridge suite tests the extension boundary.
  if (url === "http://127.0.0.1:1/v1/identity")
    return Response.json({ identity: { ...JSON.parse(readFileSync(join(stateDir, `${instanceId}.json`))),
      capabilities: liveBudgetCapability ? { mutationOwnerBudget: true } : undefined } });
  assert.equal(url, "http://127.0.0.1:1/v1/command");
  transportCalls++;
  const body = JSON.parse(options.body);
  assert.equal(body.ownerId, ownerId);
  assert.equal(body.allocatedBytes, allocatedBytes, "real Core allocation reaches every transport call");
  try {
    claimMutation({ stateDir, ...body });
    const status = body.command === "workbench.action.aichat.sendText" ? reserveMessage({ stateDir, ...body }) : {};
    simulatedDispatches++;
    return Response.json({ requestId: body.requestId, state: "unknown", retrySafe: false, ...status });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 503 }); }
};
process.env.QODER_IDE_BRIDGE_CONFIG = configPath;
try {
  const instancePath = join(stateDir, `${instanceId}.json`), instanceBefore = readFileSync(instancePath);
  const oldInstance = JSON.parse(instanceBefore);
  delete oldInstance.capabilities;
  liveBudgetCapability = false;
  writeFileSync(instancePath, JSON.stringify(oldInstance));
  for (const [operation, args] of [["toolkit_check", { command: "px.dumpIndexStats" }],
    ["conversation_activate", { sessionId: "private-session", sessionType: "agent", title: "Private" }],
    ["conversation_send_current", { content: "old instance must not dispatch" }]])
    await assert.rejects(() => act(operation, args), /lacks all-mutation/);
  assert.equal(transportCalls, 0, "old instance capability refusal precedes transport and claims");
  assert.deepEqual(snapshot(), {});
  assert.equal((await readIdentity({ instanceId, workspace }, readConfig(configPath))).identity.instanceId, instanceId,
    "unsupported instance remains available for authenticated read-only identity");
  writeFileSync(instancePath, instanceBefore);
  for (const [operation, args] of [["toolkit_check", { command: "px.dumpIndexStats" }],
    ["conversation_activate", { sessionId: "private-session", sessionType: "agent", title: "Private" }],
    ["conversation_send_current", { content: "local capability alone must not dispatch" }]])
    await assert.rejects(() => act(operation, args), /lacks authenticated/);
  assert.equal(transportCalls, 0, "a misleading local record cannot bypass the authenticated capability check");
  assert.deepEqual(snapshot(), {});
  liveBudgetCapability = true;
  const seedRequest = randomUUID(), content = "existing page message";
  const seed = await act("conversation_send_current", { requestId: seedRequest, content });
  assert.equal(seed.messageReceipt.acceptance.owner.state, "accepted");
  const initialBytes = bytes();
  const cliEnv = { AGENT_CORE_REGISTRY: registryPath };
  const cliArgs = ["--config", configPath, "toolkit", instanceId, workspace, "px.dumpIndexStats"];
  await runIdeCli(cliArgs, cliEnv);
  const beforeMissing = transportCalls;
  await assert.rejects(() => runIdeCli(cliArgs, { AGENT_CORE_REGISTRY: join(root, "unconfigured.json") }), /backpressure/);
  assert.equal(transportCalls, beforeMissing);
  assert.equal(existsSync(join(root, "unconfigured.json")), false, "CLI never creates or allocates a registry");
  const operations = commands.slice(0, 4).map(command => ["toolkit_check",
    { command, ...(command === "px.runTiger" ? { targetPath: workspace } : {}) }]);
  operations.push(["conversation_activate", { sessionId: "private-session", sessionType: "agent", title: "Private" }]);
  let accepted = 1, firstBlockedOperation;
  const acceptedByCommand = { "px.dumpIndexStats": 1 };
  for (let index = 0; index < 100; index++) {
    const [operation, args] = operations[index % operations.length];
    const before = snapshot(), dispatchBefore = simulatedDispatches;
    try { await act(operation, args); }
    catch (error) {
      assert.match(error.message, /budget exceeded/);
      assert.deepEqual(snapshot(), before, "first backpressure retains every record and headroom byte");
      assert.equal(simulatedDispatches, dispatchBefore);
      firstBlockedOperation = operation;
      break;
    }
    accepted++;
    const command = args.command || "aicoding.chat.history";
    acceptedByCommand[command] = (acceptedByCommand[command] || 0) + 1;
    assert.ok(bytes() <= allocatedBytes);
  }
  assert.ok(firstBlockedOperation, "non-page admission must stop under the real owner quota");
  for (const command of commands.slice(0, 5)) assert.ok(acceptedByCommand[command] > 0);
  const full = snapshot(), fullBytes = bytes(), dispatchBefore = simulatedDispatches;
  for (const [operation, args] of operations) await assert.rejects(() => act(operation, args), /budget exceeded/);
  await assert.rejects(() => runIdeCli(cliArgs, cliEnv), /budget exceeded/);
  const claimArgs = { stateDir, instanceId, workspace, command: "px.dumpIndexStats", requestId: randomUUID() };
  for (const meta of [{}, { ownerId }, { ownerId: "wrong-owner", allocatedBytes },
    { ownerId, allocatedBytes: 0 }]) assert.throws(() => claimMutation({ ...claimArgs, ...meta }), { code: "INVALID_OWNER" });
  await assert.rejects(() => act("conversation_send_current", { requestId: seedRequest, content }), /not replayed/);
  assert.deepEqual(snapshot(), full, "missing quota, all rejected mutations and replay preserve the store");
  assert.equal(simulatedDispatches, dispatchBefore);
  assert.ok(fullBytes + 512 <= allocatedBytes, "retained claims leave the existing conservative lock margin");
  const transcriptPath = join(root, "private-transcript.jsonl");
  assert.equal(collect(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "private-native-session",
    cwd: workspace, transcript_path: transcriptPath, request_set_id: "private-request-set",
    prompt: `${content}\n\n[agent-core-request:${seedRequest}]` }), configPath), "recorded");
  assert.equal(collect(JSON.stringify({ hook_event_name: "Stop", session_id: "private-native-session",
    cwd: workspace, transcript_path: transcriptPath, request_set_id: "private-request-set", stop_hook_active: false,
    last_assistant_message: "\u0000".repeat(8000) }), configPath), "recorded");
  for (const [path, original] of Object.entries(full)) if (path.startsWith("request-reservations/"))
    assert.deepEqual(readFileSync(join(stateDir, path)), original, "legal Hooks do not consume or delete claims");
  assert.equal(bytes(), fullBytes, "Hooks use the already committed record/headroom capacity");
  assert.deepEqual(readFileSync(registryPath), registryBefore);
  assert.deepEqual(readFileSync(configPath), configBefore);
  const finalPage = JSON.parse(readFileSync(join(stateDir, "message-reservations", `${seedRequest}.json`)));
  console.log(JSON.stringify({ passed: true, root, ownerId, allocatedBytes, initialBytes,
    acceptedNonPageClaims: accepted, acceptedByCommand, firstBlockedOperation, finalBytes: fullBytes,
    retainedClaimCount: readdirSync(join(stateDir, "request-reservations")).length,
    retainedPageBytes: statSync(join(stateDir, "message-reservations", `${seedRequest}.json`)).size,
    replyState: finalPage.reply.state, oldInstanceRejectedBeforeCommandTransport: true,
    localCapabilityAloneRejected: true,
    coreRegistryUnchanged: true, bridgeConfigUnchanged: true,
    realIde: false, network: "stubbed; no socket or provider", transportCalls, simulatedDispatches }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (previousConfig === undefined) delete process.env.QODER_IDE_BRIDGE_CONFIG;
  else process.env.QODER_IDE_BRIDGE_CONFIG = previousConfig;
}
