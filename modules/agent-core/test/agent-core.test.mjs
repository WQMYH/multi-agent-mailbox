import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleRegistry } from "../src/registry.mjs";
import { execute } from "../src/cli.mjs";
import { publicTools } from "../src/mcp-server.mjs";
import {
  DEFAULT_OWNER_BUDGET_BYTES,
  MESSAGE_DATA_BUDGET_BYTES,
  checkMessageBudget,
  createMessageBudget,
  planMessageBudget,
  validateMessageBudget,
  validateMessageReceipt
} from "../src/contracts.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-core-test-"));
const registryPath = join(root, "registry.json");
const moduleDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const children = new Set();
function start(args, options = {}) {
  const child = spawn(process.execPath, args, { windowsHide: true, ...options });
  children.add(child);
  child.done = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { children.delete(child); resolveDone({ code, signal }); });
  });
  child.stderrText = "";
  child.stderr?.on("data", chunk => { child.stderrText += chunk; });
  return child;
}

function moduleRoot(id, marker) {
  const moduleDir = join(root, id);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "agent-module.json"), JSON.stringify({
    schemaVersion: 1, id, name: id, version: "0.1.0", entry: "./adapter.mjs",
    targets: [{ id: `${id}-target`, kind: "test", label: id }]
  }));
  writeFileSync(join(moduleDir, "adapter.mjs"), `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "loaded;");
    if (process.env.CORE_TEST_KEEP_ALIVE === "1") setInterval(() => {}, 1000);
    export async function describe() {
      appendFileSync(${JSON.stringify(marker)}, "described;");
      await globalThis.agentCoreTestHook?.(${JSON.stringify(id)});
      return [
      { name: "inspect", description: "Read test state", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "change", description: "Change test state", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }
    ]; }
    export async function call(operation, args, context) {
      if (args.invalid) throw Error("Domain arguments invalid");
      if (args.delay) await new Promise(resolve => setTimeout(resolve, 30));
      if (operation === "inspect") return { id: ${JSON.stringify(id)}, kind: "read", args,
        ...(args.rawReceipt === undefined ? {} : { messageReceipt: args.rawReceipt }) };
      if (operation === "change") {
        appendFileSync(${JSON.stringify(marker + ".actions")}, "called;");
        return { id: ${JSON.stringify(id)}, kind: "act", args,
          ...(args.messageReceipt === undefined ? {} : { messageReceipt: context.validateMessageReceipt(args.messageReceipt) }),
          ...(args.rawReceipt === undefined ? {} : { messageReceipt: args.rawReceipt }),
          ...(args.budgetCheck === undefined ? {} : { budgetCheck: context.messageBudget.check(args.budgetCheck) }) };
      }
      throw Error("adapter operation missing");
    }
  `);
  return moduleDir;
}

async function rpc(child, line, lines) {
  const message = JSON.parse(await new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(timer); lines.removeListener("line", onLine); child.removeListener("error", onError); child.removeListener("close", onClose); };
    const onLine = value => { cleanup(); resolvePromise(value); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => onError(Error(`Server exited before response: ${child.stderrText}`));
    const timer = setTimeout(() => onError(Error("RPC timeout")), 5000);
    lines.once("line", onLine);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(typeof line === "string" ? line + "\n" : `${JSON.stringify(line)}\n`);
  }));
  return message;
}

async function cli(args, input, { raw = false, env = process.env, chunks } = {}) {
  const child = start([join(moduleDir, "src/cli.mjs"), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  if (chunks) {
    for (const chunk of chunks) {
      child.stdin.write(chunk);
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    child.stdin.end();
  } else child.stdin.end(input === undefined ? "" : raw ? input : `${JSON.stringify(input)}\n`);
  const done = await child.done;
  return { ...done, stdout, stderr: child.stderrText };
}

async function run() {
  const alphaMarker = join(root, "alpha.loaded");
  const betaMarker = join(root, "beta.loaded");
  const alpha = moduleRoot("agent-alpha", alphaMarker);
  const beta = moduleRoot("agent-beta", betaMarker);
  const registry = new ModuleRegistry({ registryPath, now: () => 1700000000000 });

  registry.install(alpha);
  registry.install(beta);
  assert.equal(existsSync(alphaMarker), false, "install is metadata-only");
  assert.equal(existsSync(betaMarker), false, "install does not import other modules");
  assert.deepEqual(registry.list().map(module => module.id), ["agent-alpha", "agent-beta"]);
  assert.equal((await registry.agentDiscover()).operations, undefined, "unscoped discovery has no operation schema");
  assert.equal(existsSync(alphaMarker), false, "unscoped discovery remains lazy");

  const alphaDescription = await registry.agentDiscover({ moduleId: "agent-alpha" });
  assert.equal(alphaDescription.operations.length, 2);
  assert.equal(existsSync(alphaMarker), true, "selected discovery lazy-loads one module");
  assert.equal(existsSync(betaMarker), false, "selected discovery does not load siblings");
  alphaDescription.operations.find(tool => tool.name === "change").annotations.readOnlyHint = true;
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "change" }), /mutating/);
  for (const bad of [null, [], "path", { root: alpha }, { moduleId: "agent-alpha", operation: "change" }])
    await assert.rejects(() => registry.agentDiscover(bad));
  for (const moduleId of ["constructor", "__proto__", "../escape", "toString"])
    await assert.rejects(() => registry.agentDiscover({ moduleId }), /Invalid moduleId|Unknown module/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", extra: 1 }), /Unknown argument/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha" }), /Invalid operation/);
  assert.deepEqual(await registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", args: { value: 1 } }),
    { id: "agent-alpha", kind: "read", args: { value: 1 } });
  assert.deepEqual(await registry.agentAct({ moduleId: "agent-alpha", operation: "change", args: { value: 2 } }),
    { id: "agent-alpha", kind: "act", args: { value: 2 } });
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "change" }), /mutating/);
  await assert.rejects(() => registry.agentAct({ moduleId: "agent-alpha", operation: "inspect" }), /read-only/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "missing" }), /Unknown operation/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", args: [] }), /JSON object/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", args: null }), /JSON object/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", args: { invalid: true } }), /Domain/);
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-missing", operation: "inspect" }), /Unknown module/);

  const receipt = validateMessageReceipt({
    schemaVersion: 1,
    requestId: "request-1",
    deliveryId: "delivery-1",
    ownerId: "persistent-queue-1",
    target: { moduleId: "agent-alpha", address: "task-1" },
    correlation: "work-1",
    replyTo: { ownerId: "persistent-queue-2", target: { moduleId: "agent-beta", address: "task-2" } },
    acceptance: {
      owner: { state: "accepted", evidence: "durable-owner-record-1" },
      provider: { state: "unknown" }
    }
  });
  assert.equal(receipt.ownerId, "persistent-queue-1");
  assert.throws(() => validateMessageReceipt({ ...receipt,
    acceptance: { owner: { state: "accepted" }, provider: { state: "unknown" } }
  }), /evidence/);
  const receiptResult = await registry.agentAct({ moduleId: "agent-alpha", operation: "change", args: { messageReceipt: receipt } });
  assert.deepEqual(receiptResult.messageReceipt, receipt, "valid normalized receipts are preserved with legacy provider output");
  await assert.rejects(() => registry.agentAct({ moduleId: "agent-alpha", operation: "change", args: {
    messageReceipt: { ...receipt, ownerId: "source agent" }
  } }), /Invalid ownerId/);
  const actionCount = () => readFileSync(alphaMarker + ".actions", "utf8").split("called;").length - 1;
  const actionsBeforeContractError = actionCount();
  const invalidReceipt = { ...receipt, acceptance: {
    owner: { state: "accepted" }, provider: { state: "unknown" }
  } };
  const invalidActResult = await registry.agentAct({ moduleId: "agent-alpha", operation: "change", args: {
    rawReceipt: invalidReceipt
  } });
  assert.deepEqual(invalidActResult.messageReceipt, invalidReceipt, "contract failure preserves the provider result");
  assert.deepEqual(invalidActResult.messageReceiptContract, {
    status: "contract_error", acceptance: "unknown", actionMayHaveOccurred: true,
    retrySafe: false, error: "acceptance.owner.evidence is required for accepted or rejected state"
  });
  assert.equal(actionCount(), actionsBeforeContractError + 1, "post-action contract failure never retries the provider action");
  const invalidReadResult = await registry.agentRead({ moduleId: "agent-alpha", operation: "inspect", args: {
    rawReceipt: invalidReceipt
  } });
  assert.equal(invalidReadResult.messageReceiptContract.actionMayHaveOccurred, false);
  assert.equal(invalidReadResult.messageReceiptContract.retrySafe, true);

  const allocated = createMessageBudget(["queue-d", "queue-c", "queue-b", "queue-a", "queue-a"]);
  assert.equal(allocated.allocations.length, 4, "budget allocation deduplicates queue owners");
  assert(allocated.allocations.every(item => item.bytes === 50_000_000));
  assert.equal(allocated.allocations.reduce((sum, item) => sum + item.bytes, 0), MESSAGE_DATA_BUDGET_BYTES);
  assert.equal(allocated.defaultOwnerBytes, DEFAULT_OWNER_BUDGET_BYTES);
  const initializedBudget = registry.initializeMessageBudget(["queue-d", "queue-c", "queue-b", "queue-a", "queue-a"]);
  assert.equal(initializedBudget.created, true);
  assert.deepEqual(registry.messageBudget(), allocated);
  assert.equal(registry.initializeMessageBudget(["queue-a", "queue-b", "queue-c", "queue-d"]).created, false,
    "upgrade keeps existing owner quotas");
  const expandedBudget = registry.initializeMessageBudget(["queue-a", "queue-b", "queue-c", "queue-d", "queue-e", "queue-e"]);
  assert.equal(expandedBudget.changed, true);
  assert.equal(expandedBudget.config.totalBytes, 250_000_000);
  assert.equal(expandedBudget.config.allocations.length, 5);
  assert(expandedBudget.config.allocations.every(item => item.bytes === 50_000_000));
  const registryBeforeRepeat = readFileSync(registryPath, "utf8");
  assert.equal(registry.initializeMessageBudget(["queue-e", "queue-e"]).changed, false);
  assert.equal(readFileSync(registryPath, "utf8"), registryBeforeRepeat, "duplicate owner never adds or rewrites a quota");
  assert.equal(checkMessageBudget(allocated, { ownerId: "queue-a", usedBytes: 1, additionalBytes: 1 }).ok, true);
  const custom = createMessageBudget(["custom-a", "custom-b"], {
    defaultOwnerBytes: 30_000_000, ownerOverrides: { "custom-b": 60_000_000 }, globalLimitBytes: 120_000_000
  });
  assert.equal(custom.totalBytes, 90_000_000);
  assert.equal(planMessageBudget(custom, ["custom-c"]).config.totalBytes, 120_000_000);
  assert.equal(planMessageBudget(custom, ["custom-c", "custom-c"]).config.allocations.length, 3);
  const capped = planMessageBudget(custom, ["custom-c", "custom-d"]);
  assert.equal(capped.conflict.reason, "global_limit_exceeded");
  assert.equal(capped.conflict.deltaBytes, 30_000_000);
  const decrease = planMessageBudget(custom, ["custom-a"], { ownerOverrides: { "custom-a": 20_000_000 } });
  assert.equal(decrease.conflict.reason, "owner_quota_reduction_requires_usage");
  assert.equal(decrease.conflict.deltaBytes, 10_000_000);
  assert.throws(() => createMessageBudget(["x"], { defaultOwnerBytes: Number.MAX_SAFE_INTEGER + 1 }), /Invalid/);
  assert.throws(() => createMessageBudget(["x", "y"], { defaultOwnerBytes: Number.MAX_SAFE_INTEGER }), /overflows/);
  assert.throws(() => createMessageBudget(["x"], { ownerOverrides: { "not an id": 1 } }), /Invalid/);
  assert.throws(() => createMessageBudget(["x"], { ownerOverrides: { y: 1 } }), /not allocated/);
  assert.throws(() => validateMessageBudget({ ...custom, globalLimitBytes: 1 }), /globalLimitBytes/);
  assert.throws(() => checkMessageBudget(custom, { ownerId: "custom-a", usedBytes: Number.MAX_SAFE_INTEGER,
    additionalBytes: 1 }), /overflows/);
  const legacyBudget = {
    schemaVersion: 1,
    totalBytes: 20_000_000,
    allocations: [{ ownerId: "legacy-a", bytes: 10_000_000 }, { ownerId: "legacy-b", bytes: 10_000_000 }]
  };
  assert.deepEqual(validateMessageBudget(legacyBudget), legacyBudget);
  assert.deepEqual(planMessageBudget(legacyBudget, ["legacy-a", "legacy-b"]),
    { ok: true, created: false, changed: false, config: legacyBudget }, "legacy allocations remain unchanged");
  const legacyConflict = planMessageBudget(legacyBudget, ["legacy-a", "legacy-b", "legacy-c"]);
  assert.equal(legacyConflict.ok, false);
  assert.deepEqual(legacyConflict.config, legacyBudget, "legacy conflict keeps the original allocations");
  assert.equal(legacyConflict.conflict.deltaBytes, 50_000_000);
  const migrated = planMessageBudget(legacyBudget, ["legacy-a", "legacy-b", "legacy-c"], { migrateLegacy: true });
  assert.equal(migrated.config.totalBytes, 70_000_000);
  assert.deepEqual(migrated.config.allocations.map(item => item.bytes), [10_000_000, 10_000_000, 50_000_000]);
  const fixedFour = { schemaVersion: 1, totalBytes: 200_000_000, allocations: allocated.allocations };
  assert.equal(planMessageBudget(fixedFour, ["queue-e"]).conflict.reason, "enabled_owner_unallocated");
  const migratedFive = planMessageBudget(fixedFour, ["queue-e"], { migrateLegacy: true });
  assert.equal(migratedFive.config.totalBytes, 250_000_000);
  assert(migratedFive.config.allocations.every(item => item.bytes === 50_000_000));
  assert.throws(() => validateMessageBudget({ ...legacyBudget, totalBytes: 30_000_000 }), /Unsupported/);
  assert.throws(() => validateMessageBudget({ ...allocated,
    allocations: allocated.allocations.map((item, index) => index ? item : { ...item, bytes: item.bytes - 1 })
  }), /differs/);
  assert.throws(() => validateMessageBudget({ ...legacyBudget,
    allocations: [{ ownerId: "legacy-a", bytes: 10_000_000 }, { ownerId: "legacy-a", bytes: 10_000_000 }]
  }), /Duplicate/);
  const overBudget = checkMessageBudget(legacyBudget, { ownerId: "legacy-a", usedBytes: 10_000_000, additionalBytes: 1 });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.deltaBytes, 1);
  const adapterBudget = await registry.agentAct({ moduleId: "agent-alpha", operation: "change", args: {
    budgetCheck: { ownerId: "queue-a", usedBytes: 1, additionalBytes: 1 }
  } });
  assert.equal(adapterBudget.budgetCheck.ok, true, "revision-isolated adapters receive budget checks through context");

  await registry.agentDiscover({ moduleId: "agent-beta" });
  const externalRegistry = new ModuleRegistry({ registryPath });
  externalRegistry.disable("agent-alpha");
  await assert.rejects(() => registry.agentRead({ moduleId: "agent-alpha", operation: "inspect" }), /disabled/);
  externalRegistry.enable("agent-alpha");
  externalRegistry.uninstall("agent-beta");
  assert.equal(existsSync(beta), true, "uninstall preserves module source");
  await assert.rejects(() => registry.agentDiscover({ moduleId: "agent-beta" }), /Unknown module/);
  assert.equal((await registry.agentRead({ moduleId: "agent-alpha", operation: "inspect" })).id, "agent-alpha",
    "uninstalling a loaded sibling preserves remaining module access");

  // A pending describe must not survive disable+enable, or a replacement registration.
  for (const replace of [false, true]) {
    registry.install(beta);
    let release, entered;
    const ready = new Promise(resolveReady => { entered = resolveReady; });
    globalThis.agentCoreTestHook = id => id === "agent-beta" ? new Promise(resolveHook => { release = resolveHook; entered(); }) : undefined;
    const pending = registry.agentRead({ moduleId: "agent-beta", operation: "inspect" });
    const rejected = assert.rejects(pending, /registration changed/);
    await Promise.race([ready, pending]);
    if (replace) externalRegistry.install(beta);
    else { externalRegistry.disable("agent-beta"); externalRegistry.enable("agent-beta"); }
    release();
    await rejected;
    delete globalThis.agentCoreTestHook;
  }
  const describeCount = () => readFileSync(betaMarker, "utf8").split("described;").length - 1;
  const descriptionsBefore = describeCount();
  await Promise.all([registry.agentDiscover({ moduleId: "agent-beta" }), registry.agentDiscover({ moduleId: "agent-beta" })]);
  assert.equal(describeCount(), descriptionsBefore + 1, "concurrent selected calls share one pending load/describe");

  const outside = join(root, "outside.mjs");
  const escaped = join(root, "escaped");
  mkdirSync(escaped);
  writeFileSync(outside, "export const nope = true;");
  writeFileSync(join(escaped, "agent-module.json"), JSON.stringify({
    schemaVersion: 1, id: "agent-escaped", name: "escaped", version: "0.1.0", entry: "./../outside.mjs",
    targets: [{ id: "escaped-target", kind: "test", label: "escaped" }]
  }));
  assert.throws(() => registry.install(escaped), /escapes/);
  const manifestPath = join(escaped, "agent-module.json");
  const escapeManifest = JSON.parse(readFileSync(manifestPath));
  symlinkSync(root, join(escaped, "link"), "junction");
  writeFileSync(manifestPath, JSON.stringify({ ...escapeManifest, entry: "./link/outside.mjs" }));
  assert.throws(() => registry.install(escaped), /escapes/);
  unlinkSync(join(escaped, "link"));
  mkdirSync(join(escaped, "inside"));
  writeFileSync(join(escaped, "inside", "outside.mjs"), "export const nope = true;");
  symlinkSync(join(escaped, "inside"), join(escaped, "link"), "junction");
  registry.install(escaped);
  unlinkSync(join(escaped, "link"));
  symlinkSync(root, join(escaped, "link"), "junction");
  await assert.rejects(() => registry.agentDiscover({ moduleId: "agent-escaped" }), /escapes/);
  unlinkSync(join(escaped, "link"));
  registry.uninstall("agent-escaped");

  const cliRegistry = join(root, "cli-registry.json");
  assert.equal(execute(["install", beta, "--registry", cliRegistry]).id, "agent-beta");
  assert.equal(execute(["disable", "agent-beta", "--registry", cliRegistry]).enabled, false);
  assert.equal(execute(["enable", "agent-beta", "--registry", cliRegistry]).enabled, true);
  assert.equal(execute(["list", "--registry", cliRegistry]).modules.length, 1);
  assert.equal(execute(["uninstall", "agent-beta", "--registry", cliRegistry]).sourcePreserved, true);
  assert.equal(existsSync(beta), true, "CLI uninstall preserves source");

  // Hold the real writer lock in one process while a second CLI attempts an install.
  const releaseFile = join(root, "writer-release");
  const writer = start(["--input-type=module", "-e", `
    import { ModuleRegistry } from ${JSON.stringify(pathToFileURL(join(moduleDir, "src/registry.mjs")).href)};
    import { existsSync } from "node:fs";
    class HeldRegistry extends ModuleRegistry {
      readState() {
        console.log("locked");
        const end = Date.now() + 10000;
        while (!existsSync(${JSON.stringify(releaseFile)})) {
          if (Date.now() > end) throw Error("Test writer timeout");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return super.readState();
      }
    }
    new HeldRegistry({ registryPath: ${JSON.stringify(cliRegistry)} }).install(${JSON.stringify(alpha)});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const writerLines = createInterface({ input: writer.stdout });
  await new Promise(resolveReady => writerLines.once("line", resolveReady));
  const cliArgs = [join(moduleDir, "src/cli.mjs"), "--registry", cliRegistry, "install", beta];
  const competing = start(cliArgs, { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await competing.done).code, 1);
  assert.match(competing.stderrText, /Registry locked/);
  writeFileSync(releaseFile, "release");
  assert.equal((await writer.done).code, 0);
  writerLines.close();
  const retried = start(cliArgs, { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await retried.done).code, 0);
  assert.deepEqual(new ModuleRegistry({ registryPath: cliRegistry }).list().map(item => item.id), ["agent-alpha", "agent-beta"]);

  const cliBudget = execute(["budget-init", "queue-d", "queue-c", "queue-b", "queue-a", "queue-a", "--registry", cliRegistry]);
  assert.equal(cliBudget.config.allocations.length, 4);
  assert(cliBudget.config.allocations.every(item => item.bytes === 50_000_000));
  assert.equal(execute(["budget-status", "--registry", cliRegistry]).messageBudget.totalBytes, MESSAGE_DATA_BUDGET_BYTES);
  assert.deepEqual(new ModuleRegistry({ registryPath: cliRegistry }).messageBudget(), cliBudget.config,
    "new default budget survives registry reopen");
  const beforeRead = readFileSync(cliRegistry, "utf8");
  const budgetStatusCli = await cli(["budget", "status", "--registry", cliRegistry]);
  assert.equal(JSON.parse(budgetStatusCli.stdout).messageBudget.totalBytes, 200_000_000);
  const budgetCheckCli = await cli(["budget", "check", "--registry", cliRegistry],
    { ownerId: "queue-a", usedBytes: 1, additionalBytes: 1 });
  assert.equal(JSON.parse(budgetCheckCli.stdout).ok, true);
  assert.equal(readFileSync(cliRegistry, "utf8"), beforeRead, "budget status/check do not persist");
  const configuredCli = await cli(["budget", "sync", "--registry", cliRegistry], {
    ownerIds: ["queue-e", "queue-e"], defaultOwnerBytes: 60_000_000,
    ownerOverrides: { "queue-e": 75_000_000 }, globalLimitBytes: 300_000_000
  });
  assert.equal(configuredCli.code, 0);
  assert.equal(JSON.parse(configuredCli.stdout).config.totalBytes, 275_000_000);
  assert.equal(execute(["budget-status", "--registry", cliRegistry]).messageBudget.defaultOwnerBytes, 60_000_000);
  const beforeCapConflict = readFileSync(cliRegistry, "utf8");
  const capConflict = execute(["budget", "sync", "--registry", cliRegistry], {
    input: { ownerIds: ["queue-f"] }
  });
  assert.equal(capConflict.conflict.reason, "global_limit_exceeded");
  assert.equal(capConflict.conflict.deltaBytes, 35_000_000);
  assert.equal(readFileSync(cliRegistry, "utf8"), beforeCapConflict, "cap conflict writes nothing");
  const legacyRegistry = join(root, "legacy-registry.json");
  writeFileSync(legacyRegistry, `${JSON.stringify({ schemaVersion: 1, modules: {}, messageBudget: legacyBudget }, null, 2)}\n`);
  const legacyBeforeInit = readFileSync(legacyRegistry, "utf8");
  assert.deepEqual(execute(["budget-status", "--registry", legacyRegistry]).messageBudget, legacyBudget);
  assert.equal(execute(["budget-init", "legacy-a", "legacy-b", "--registry", legacyRegistry]).created, false);
  assert.equal(readFileSync(legacyRegistry, "utf8"), legacyBeforeInit, "legacy budget-init preserves persisted allocations");
  const legacyMigrated = execute(["budget", "sync", "--registry", legacyRegistry], {
    input: { ownerIds: ["legacy-c"], migrateLegacy: true }
  });
  assert.equal(legacyMigrated.config.totalBytes, 70_000_000);
  assert.equal(legacyMigrated.config.allocations.find(item => item.ownerId === "legacy-a").bytes, 10_000_000);
  const concurrentBudgetPath = join(root, "concurrent-budget.json");
  execute(["budget-init", "queue-a", "--registry", concurrentBudgetPath]);
  const addOwner = async ownerId => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await cli(["budget", "sync", "--registry", concurrentBudgetPath], { ownerIds: [ownerId] });
      if (result.code === 0) return;
      assert.match(result.stderr, /Registry locked/);
    }
    throw Error(`Budget writer could not acquire the lock: ${ownerId}`);
  };
  await Promise.all([addOwner("queue-b"), addOwner("queue-c")]);
  assert.deepEqual(new ModuleRegistry({ registryPath: concurrentBudgetPath }).messageBudget().allocations.map(item => item.ownerId),
    ["queue-a", "queue-b", "queue-c"], "competing budget writers preserve both owners");
  const discoveredCli = await cli(["--registry", cliRegistry, "discover"], { moduleId: "agent-beta" });
  assert.equal(discoveredCli.code, 0);
  assert.equal(discoveredCli.stderr, "");
  assert.equal(JSON.parse(discoveredCli.stdout).module.id, "agent-beta");
  const readCli = await cli(["read", "--registry", cliRegistry], {
    moduleId: "agent-beta", operation: "inspect", args: { from: "cli" }
  });
  assert.deepEqual(JSON.parse(readCli.stdout).args, { from: "cli" });
  const utf8Input = Buffer.from(JSON.stringify({
    moduleId: "agent-beta", operation: "inspect", args: { value: "中文" }
  }));
  const utf8Split = utf8Input.indexOf(Buffer.from("中")) + 1;
  const splitUtf8Cli = await cli(["read", "--registry", cliRegistry], undefined, {
    chunks: [utf8Input.subarray(0, utf8Split), utf8Input.subarray(utf8Split)]
  });
  assert.equal(JSON.parse(splitUtf8Cli.stdout).args.value, "中文", "stdin decodes UTF-8 only after joining byte chunks");
  const stickyCli = await cli(["read", "--registry", cliRegistry], {
    moduleId: "agent-beta", operation: "inspect", args: { sticky: true }
  }, { env: { ...process.env, CORE_TEST_KEEP_ALIVE: "1" } });
  assert.equal(stickyCli.code, 0, "one-shot CLI exits after flushing despite an adapter timer");
  assert.equal(JSON.parse(stickyCli.stdout).args.sticky, true);
  const actCli = await cli(["act", "--registry", cliRegistry], {
    moduleId: "agent-beta", operation: "change", args: { from: "cli" }
  });
  assert.equal(JSON.parse(actCli.stdout).kind, "act");
  const badCli = await cli(["discover", "--registry", cliRegistry], "{invalid", { raw: true });
  assert.equal(badCli.code, 1);
  assert.equal(badCli.stdout, "");
  assert.match(badCli.stderr, /stdin must be one JSON value/);

  assert.deepEqual(publicTools.map(tool => tool.name), ["agent_discover", "agent_read", "agent_act"]);
  const child = start([resolve(moduleDir, "src/mcp-server.mjs")], {
    cwd: moduleDir,
    env: { ...process.env, AGENT_CORE_REGISTRY: registryPath, CORE_TEST_KEEP_ALIVE: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const initialize = await rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, lines);
  assert.equal(initialize.result.serverInfo.name, "agent-core");
  const tools = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, lines);
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ["agent_discover", "agent_read", "agent_act"]);
  const discovered = await rpc(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "agent_discover", arguments: { moduleId: "agent-alpha" }
  } }, lines);
  const discoveredValue = JSON.parse(discovered.result.content[0].text);
  assert.equal(discoveredValue.module.id, "agent-alpha");
  const request = (id, name, args) => rpc(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, lines);
  assert.equal((await request(4, "agent_read", { moduleId: "agent-alpha", operation: "inspect" })).result.isError, undefined);
  assert.equal((await request(5, "agent_read", { moduleId: "agent-alpha", operation: "change" })).result.isError, true);
  const actionsBefore = readFileSync(alphaMarker + ".actions", "utf8");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "agent_act", arguments: { moduleId: "agent-alpha", operation: "change" } } }) + "\n");
  assert.equal((await rpc(child, { jsonrpc: "2.0", id: 6, method: "ping" }, lines)).id, 6);
  assert.equal(readFileSync(alphaMarker + ".actions", "utf8"), actionsBefore, "action notifications must never execute");
  externalRegistry.disable("agent-alpha");
  assert.equal((await request(7, "agent_read", { moduleId: "agent-alpha", operation: "inspect" })).result.isError, true);
  externalRegistry.enable("agent-alpha");
  assert.equal((await request(8, "agent_read", { moduleId: "agent-alpha", operation: "inspect" })).result.isError, undefined);
  externalRegistry.uninstall("agent-alpha");
  assert.equal((await request(9, "agent_read", { moduleId: "agent-alpha", operation: "inspect" })).result.isError, true);
  assert.equal((await rpc(child, "{invalid", lines)).error.code, -32700);
  assert.equal((await rpc(child, { jsonrpc: "2.0", id: 10, method: "initialize", params: null }, lines)).error.code, -32602);
  assert.equal((await request(11, "agent_discover", { path: alpha })).result.isError, true);
  const action = await request(13, "agent_act", { moduleId: "agent-beta", operation: "change" });
  assert.equal(JSON.parse(action.result.content[0].text).kind, "act");
  const finalCall = request(12, "agent_read", { moduleId: "agent-beta", operation: "inspect", args: { delay: true } });
  child.stdin.end();
  assert.equal((await finalCall).id, 12, "EOF drains pending calls");
  assert.equal((await child.done).code, 0, "EOF exits despite adapter interval");
  lines.close();
}

let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("Test deadline exceeded")), 20000); })])
.then(() => console.log("agent-core tests passed"), error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  for (const child of children) child.kill();
  await Promise.allSettled([...children].map(child => child.done));
  delete globalThis.agentCoreTestHook;
  rmSync(root, { recursive: true, force: true });
});
