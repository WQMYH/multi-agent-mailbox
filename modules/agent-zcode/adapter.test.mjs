import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleRegistry } from "../agent-core/src/registry.mjs";

await import("./build.mjs");
const sourceRoot = import.meta.dirname;
assert(!existsSync(join(sourceRoot, ".mcp.json")), "module must not add global MCP tools");
const manifest = JSON.parse(readFileSync(join(sourceRoot, "agent-module.json"), "utf8"));
assert.deepEqual(manifest, {
  schemaVersion: 1,
  id: "agent-zcode",
  name: "ZCode desktop",
  version: "0.1.0",
  entry: "./adapter.mjs",
  targets: [{ id: "zcode-desktop", kind: "desktop", label: "ZCode" }]
});
for (const file of ["adapter.mjs", "runtime/tools.mjs", "runtime/message-queue.mjs", "runtime/queue-worker.mjs"]) {
  assert(existsSync(join(sourceRoot, file)), `missing packaged ${file}`);
}

const isolated = mkdtempSync(join(tmpdir(), "agent-zcode-module-"));
const previousConfig = process.env.ZCODE_OPS_CONFIG;
try {
  const packageRoot = join(isolated, "agent-zcode");
  mkdirSync(packageRoot);
  for (const file of ["adapter.mjs", "agent-module.json", "build-manifest.json", "README.md"])
    cpSync(join(sourceRoot, file), join(packageRoot, file));
  cpSync(join(sourceRoot, "runtime"), join(packageRoot, "runtime"), { recursive: true });
  assert(!existsSync(join(packageRoot, ".mcp.json")), "standalone package must not add global MCP tools");

  const adapter = await import(`${pathToFileURL(join(packageRoot, manifest.entry.slice(2))).href}?test=${Date.now()}`);
  const descriptions = await adapter.describe();
  assert.equal(descriptions.length, 8);
  assert(descriptions.every(tool => tool.name && tool.inputSchema && typeof tool.annotations.readOnlyHint === "boolean"));
  assert.deepEqual(Object.fromEntries(descriptions.map(tool => [tool.name, tool.annotations.readOnlyHint])), {
    zcode_tasks: true, zcode_read: true, zcode_send: false, zcode_control: false,
    zcode_models: true, zcode_set_model: false, zcode_config_status: true, zcode_config_set: false
  });

  process.env.ZCODE_OPS_CONFIG = join(isolated, "config.json");
  const registry = new ModuleRegistry({ registryPath: join(isolated, "registry.json") });
  registry.install(packageRoot);
  assert.equal((await registry.agentDiscover({ moduleId: "agent-zcode" })).operations.length, 8);
  const status = await registry.agentRead({ moduleId: "agent-zcode", operation: "zcode_config_status" });
  assert.equal(status.target.id, "zcode-desktop");
  assert.equal(status.valid, false);
  assert.equal(status.configPath, process.env.ZCODE_OPS_CONFIG);
  const runtime = await import(`${pathToFileURL(join(packageRoot, "runtime/message-queue.mjs")).href}?test=${Date.now()}`);
  const moduleQueuePath = join(isolated, "messages.sqlite"), ownerId = runtime.queueOwnerId(moduleQueuePath);
  registry.initializeMessageBudget([ownerId]);
  const inbox = await registry.agentRead({ moduleId: "agent-zcode", operation: "zcode_read",
    args: { view: "inbox", consumerId: "module-test" } });
  assert.equal(inbox.target.id, "zcode-desktop");
  assert.equal(inbox.view, "inbox");
  assert(existsSync(join(isolated, "messages.sqlite")), "queue must follow the isolated config directory");
  await assert.rejects(registry.agentRead({ moduleId: "agent-zcode", operation: "zcode_send" }), /mutating/);
  await assert.rejects(registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_read" }), /read-only/);
  await assert.rejects(adapter.call("not-a-zcode-operation"), /Unknown ZCode operation/);

  assert.equal(runtime.RATE_RETRY.delayMs, 300_000);
  assert.equal(runtime.RATE_RETRY.maxRetries, 5);
  assert.equal(runtime.LIMITS.diskBytes, 20_000_000);
  let moduleQueue = new runtime.MessageQueue(moduleQueuePath);
  moduleQueue.db.exec("UPDATE worker SET paused=1 WHERE id=1"); moduleQueue.close();
  const coreSend = await registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
    requestId: "core-module-send", taskIds: ["sess_core-a", "sess_core-b"], prompt: "saved through Core"
  } });
  assert.equal(coreSend.ownerId, ownerId); assert.equal(coreSend.messages.length, 2);
  assert(coreSend.messages.every(message => message.messageReceipt.ownerId === ownerId &&
    message.messageReceipt.acceptance.owner.state === "accepted" && message.messageReceipt.acceptance.provider.state === "unknown"));
  const coreRetry = await registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
    requestId: "core-module-send", taskIds: ["sess_core-a", "sess_core-b"], prompt: "saved through Core"
  } });
  assert(coreRetry.deduplicated); assert.deepEqual(coreRetry.messages.map(message => message.deliveryId), coreSend.messages.map(message => message.deliveryId));
  await assert.rejects(registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
    requestId: "spoof", taskIds: ["sess_core-a"], prompt: "x", ownerId: "caller-owner"
  } }), /ownerId/);

  const queuePath = join(isolated, "legacy.sqlite");
  let queue = new runtime.MessageQueue(queuePath);
  queue.enqueue({ requestId: "module-test", taskIds: ["sess_test"], prompt: "saved" });
  queue.close();
  const legacy = new DatabaseSync(queuePath);
  legacy.exec("ALTER TABLE worker DROP COLUMN paused; PRAGMA user_version=0");
  legacy.close();
  queue = new runtime.MessageQueue(queuePath);
  assert.equal(queue.db.prepare("PRAGMA user_version").get().user_version, 9);
  assert.equal(queue.read().messages.length, 1);
  queue.close();
} finally {
  if (previousConfig === undefined) delete process.env.ZCODE_OPS_CONFIG;
  else process.env.ZCODE_OPS_CONFIG = previousConfig;
  rmSync(isolated, { recursive: true, force: true });
}

console.log("agent-zcode package, Core receipts/budget, target identity, isolated inbox, and schema-9 migration OK");
