// Real core + ZCode/Qoder modules, through CLI and MCP stdio. No remote calls or production state.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { queueOwnerId } from "./message-queue.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const core = join(repo, "modules/agent-core/src");
const scratch = mkdtempSync(join(tmpdir(), "agent-modular-integration-"));
const registry = join(scratch, "registry.json");
const config = join(scratch, "config.json");
const database = join(scratch, "messages.sqlite");
const moduleRoot = join(scratch, "agent-zcode");
const qoderRoot = join(scratch, "agent-qoder");
const qoderDelivery = join(scratch, "qoder-delivery");
const env = { ...process.env, AGENT_CORE_REGISTRY: registry, ZCODE_OPS_CONFIG: config,
  USERPROFILE: scratch, HOME: scratch };
for (const key of Object.keys(env)) if (key.startsWith("QODER_")) delete env[key];
let child, lines, closed;
let serial = 0;
let stderr = "";
const pending = new Map();

function cli(...args) {
  return JSON.parse(execFileSync(process.execPath, [join(core, "cli.mjs"), "--registry", registry, ...args], {
    cwd: scratch, env, windowsHide: true, timeout: 10_000, encoding: "utf8"
  }));
}

function request(method, params = {}) {
  const id = ++serial;
  return new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`MCP timeout for ${method}; ${stderr}`));
    }, 10_000);
    pending.set(id, { resolve: reply => { clearTimeout(timer); resolveReply(reply); },
      reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, args = {}) {
  const reply = await request("tools/call", { name, arguments: args });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result.content));
  return JSON.parse(reply.result.content.find(item => item.type === "text").text);
}

async function rejected(name, args, pattern) {
  const reply = await request("tools/call", { name, arguments: args });
  assert.ok(reply.error || reply.result?.isError, "operation must be rejected");
  assert.match(reply.error?.message ?? JSON.stringify(reply.result.content), pattern);
}

try {
  // Copy the current build; no rebuild or writes inside another task's module directory.
  cpSync(join(repo, "modules/agent-zcode"), moduleRoot, { recursive: true });
  assert.equal(cli("install", moduleRoot).id, "agent-zcode");
  mkdirSync(qoderRoot);
  for (const file of ["agent-module.json", "adapter.mjs", "desktop.mjs", "config.mjs", "launch.mjs", "worker.mjs"])
    cpSync(join(repo, "modules/agent-qoder", file), join(qoderRoot, file));
  assert.equal(cli("install", qoderRoot).id, "agent-qoder");
  cli("budget-init", queueOwnerId(database));
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(database), false, "registration must not open a queue");

  child = spawn(process.execPath, [join(core, "mcp-server.mjs")], {
    cwd: scratch, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  closed = new Promise(resolveClose => child.once("close", (code, signal) => resolveClose({ code, signal })));
  const failPending = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", failPending);
  child.on("close", code => failPending(Error(`MCP exited ${code}; ${stderr}`)));
  child.stdin.on("error", failPending);
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
  lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const reply = JSON.parse(line);
      const waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); waiter.resolve(reply); }
    } catch (error) { failPending(error); }
  });

  const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "modular-integration-test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "agent-core");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  assert.deepEqual((await request("tools/list")).result.tools.map(item => item.name),
    ["agent_discover", "agent_read", "agent_act"]);
  const available = await tool("agent_discover");
  assert.deepEqual(available.modules.map(item => item.id).sort(), ["agent-qoder", "agent-zcode"]);
  assert.equal(available.operations, undefined);
  const qoderDescription = await tool("agent_discover", { moduleId: "agent-qoder" });
  assert.equal(qoderDescription.operations.length, 12);
  assert.ok(qoderDescription.operations.some(item => item.name === "recover_queue" && !item.annotations.readOnlyHint));
  assert.ok(qoderDescription.operations.some(item => item.name === "launch" && !item.annotations.readOnlyHint));
  assert.ok(qoderDescription.operations.some(item => item.name === "queue_status" && item.annotations.readOnlyHint));
  assert.ok(qoderDescription.operations.some(item => item.name === "send_new_session" && !item.annotations.readOnlyHint));
  assert.ok(qoderDescription.operations.some(item => item.name === "read_interactions"));
  assert.ok(qoderDescription.operations.some(item => item.name === "respond_permission"));
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "send", args: {} }, /mutating/i);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "launch", args: {} }, /mutating/i);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "send_new_session", args: {} }, /mutating/i);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "respond_permission", args: {} }, /mutating/i);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "read_interactions",
    args: { sessionId: "78d8fae4-1436-458a-b9c3-96ab1730f3ae" } }, /Operator-owned workspace/);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "queue_status",
    args: { sessionId: "78d8fae4-1436-458a-b9c3-96ab1730f3ae" } }, /Operator-owned workspace/);
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "identity", args: {} }, /Explicit local/);
  assert.equal(existsSync(qoderDelivery), false, "Qoder discovery/read must not reserve a send");
  const description = await tool("agent_discover", { moduleId: "agent-zcode" });
  assert.equal(description.operations.length, 8);
  assert.equal(existsSync(database), false, "discovery must not open a queue");
  const call = (operation, args = {}) => ({ moduleId: "agent-zcode", operation, args });
  const status = await tool("agent_read", call("zcode_config_status"));
  assert.equal(status.configPath, config);
  assert.equal(status.target.id, "zcode-desktop");
  assert.equal(status.valid, false);
  await rejected("agent_read", call("zcode_config_set", { sharingLink: null }), /mutating/i);
  assert.equal(existsSync(config), false, "read route must not write configuration");
  await tool("agent_act", call("zcode_config_set", { sharingLink: null }));
  assert.equal((await tool("agent_read", call("zcode_config_status"))).valid, true);
  const inbox = await tool("agent_read", call("zcode_read", { view: "inbox", consumerId: "integration-test" }));
  assert.equal(inbox.target.id, "zcode-desktop");
  assert.deepEqual(inbox.messages, []);
  assert.equal(existsSync(database), true, "inbox uses the isolated queue next to config");

  cli("disable", "agent-zcode");
  await rejected("agent_read", call("zcode_config_status"), /disabled/i);
  assert.equal((await tool("agent_discover", { moduleId: "agent-qoder" })).operations.length, 12);
  cli("enable", "agent-zcode");
  assert.equal((await tool("agent_read", call("zcode_config_status"))).valid, true);
  cli("uninstall", "agent-qoder");
  await rejected("agent_read", { moduleId: "agent-qoder", operation: "identity" }, /unknown module/i);
  assert.equal((await tool("agent_read", call("zcode_config_status"))).valid, true);
  assert.equal(existsSync(qoderRoot), true, "unregister preserves Qoder source");
  assert.equal(existsSync(qoderDelivery), false, "no Qoder send occurred");
  cli("uninstall", "agent-zcode");
  await rejected("agent_read", call("zcode_config_status"), /unknown module/i);
  assert.deepEqual((await tool("agent_discover")).modules, []);
  assert.equal(existsSync(moduleRoot), true, "unregister preserves source");
  assert.equal(existsSync(database), true, "unregister preserves message history");
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5000);
  const exit = await closed;
  clearTimeout(timer);
  assert.equal(exit.code, 0, stderr);
  console.log("PASS: fixed-three-tool core -> ZCode/Qoder modules; lazy discovery, read/write boundaries, isolated ZCode inbox, independent disable/unregister. Live providers NOT tested.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  if (closed) await closed;
  lines?.close();
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()), "cleanup must stay in the temporary directory");
  rmSync(scratch, { recursive: true, force: true });
}
