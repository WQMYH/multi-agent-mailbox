import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createBinding } from "./configure-binding.mjs";
import { storeOwnerId } from "./store-budget.mjs";

const root = fs.mkdtempSync(join(tmpdir(), "qoder-codex-bridge-"));
const rel = relative(resolve(tmpdir()), resolve(root));
assert(rel.startsWith("qoder-codex-bridge-") && !rel.includes("/") && !rel.includes("\\") && !isAbsolute(rel));
const children = new Set();
const requestId = "11111111-2222-3333-4444-555555555555";
const bound = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const mcpConfig = JSON.parse(fs.readFileSync(join(pluginRoot, "mcp.json"), "utf8")).mcpServers["qoder-codex-bridge"];
assert.equal(mcpConfig.command, "node");
const script = mcpConfig.args[0].replace("${QODER_PLUGIN_ROOT}", pluginRoot);
assert(fs.existsSync(script));

function server(dir) {
  const child = spawn(process.execPath, [script], { windowsHide: true, env: { ...process.env, QODER_PLUGIN_DATA: dir }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let next = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response.result ?? response.error); }
  });
  child.on("exit", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("server exited")); } pending.clear(); });
  return {
    call(method, params = {}) {
      const id = ++next;
      return new Promise((resolveCall, reject) => {
        const timer = setTimeout(() => reject(Error("server timeout")), 15000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() { child.kill(); children.delete(child); }
  };
}

function result(response) {
  return JSON.parse(response.content[0].text);
}

try {
  const budgetCli = join(root, "budget-cli.mjs"), registryPath = join(root, "core-registry.json"), ownerId = storeOwnerId(root);
  fs.writeFileSync(budgetCli, `import { readFileSync } from "node:fs";
const args = process.argv.slice(2), index = args.indexOf("--registry");
const state = JSON.parse(readFileSync(args[index + 1], "utf8"));
process.stdout.write(JSON.stringify({ messageBudget: state.messageBudget }) + "\\n");
`);
  fs.writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 20_000_000,
    allocations: [{ ownerId, bytes: 20_000_000 }] } }));
  fs.writeFileSync(join(root, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId, coreCli: budgetCli, registryPath }));
  const adapter = join(root, "mock-host.mjs");
  fs.writeFileSync(adapter, `import fs from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const root = process.env.QODER_PLUGIN_DATA;
const bound = ${JSON.stringify(bound)}, target = ${JSON.stringify(target)};
if (process.argv.includes("--interaction-client-id")) throw Error("unexpected ChatGPT caller flag");
createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  let result;
  if (msg.method === "initialize") result = { protocolVersion: "2025-06-18" };
  else if (msg.method === "tools/call") {
    if (msg.params._meta?.codexThreadId !== bound) throw Error("missing Codex operator metadata");
    const { name, arguments: args } = msg.params;
    let payload;
    if (name === "list_threads") {
      if (args.limit !== 50) throw Error("invalid list limit");
      payload = { pinnedThreads: [], threads: [
      { id: bound, kind: "codex", cwd: root, title: "Bound", status: { type: "idle" } },
      { id: target, kind: "codex", cwd: root, title: "Selected", status: { type: "idle" } },
      { id: "chat", kind: "chatgpt", cwd: root, title: "Excluded" }] };
    }
    else if (name === "read_thread") payload = { thread: { id: args.threadId, cwd: args.threadId === target && fs.existsSync(join(root, "changed")) ? join(root, "other") : root, title: "Task", status: { type: "idle" } } };
    else if (name === "send_message_to_thread") {
      fs.appendFileSync(join(root, "sends"), "1");
      fs.writeFileSync(join(root, "last-prompt"), args.prompt);
      payload = { threadId: args.threadId };
    }
    result = { content: [{ type: "text", text: JSON.stringify(payload) }], isError: name === "send_message_to_thread" && fs.existsSync(join(root, "reject-send")) };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`);
  createBinding(root, requestId, requestId, requestId, "fixture-session", root, bound, root, "2030-01-01T00:00:00Z");
  const expiredBinding = JSON.parse(fs.readFileSync(join(root, "binding.json"), "utf8"));
  expiredBinding.expiresAt = "2020-01-01T00:00:00Z";
  fs.writeFileSync(join(root, "binding.json"), JSON.stringify(expiredBinding));
  fs.writeFileSync(join(root, "host-config.json"), JSON.stringify({ threadId: bound, cwd: root, script: adapter,
    pipePath: "\\\\.\\pipe\\fixture", expiresAt: "2020-01-01T00:00:00Z" }));

  const unbound = fs.mkdtempSync(join(root, "unbound-"));
  const absent = server(unbound);
  assert.equal(result(await absent.call("tools/call", { name: "list_codex_tasks", arguments: {} })).error, "host_config_missing");
  absent.close();

  const mcp = server(root);
  try {
    const init = await mcp.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.protocolVersion, "2025-06-18");
    const exposed = await mcp.call("tools/list");
    assert.deepEqual(exposed.tools.map(item => item.name), ["list_codex_tasks", "select_codex_task", "send_codex_message"]);
    assert.equal(result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} })).error, "host_expired");
    fs.writeFileSync(join(root, "host-config.json"), JSON.stringify({ threadId: bound, cwd: root, script: adapter,
      pipePath: "\\\\.\\pipe\\fixture", expiresAt: "2030-01-01T00:00:00Z" }));
    const tasks = result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} })).tasks;
    assert.deepEqual(tasks.map(item => item.threadId), [bound, target]);
    const bad = await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: "chat" } });
    assert.equal(bad.isError, true);
    const picked = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    const message = "User-authored message, not a lifecycle notice.";
    const sent = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: picked.selectionToken, threadId: target, message } }));
    assert.equal(sent.state, "accepted");
    assert.equal(fs.readFileSync(join(root, "last-prompt"), "utf8"), message);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "1");
    const saved = JSON.parse(fs.readFileSync(join(root, `message-${picked.selectionToken}.json`), "utf8"));
    assert.equal(saved.state, "accepted");
    assert.equal(saved.threadId, target);
    assert(!JSON.stringify(saved).includes(message));
    assert.equal((await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: picked.selectionToken, threadId: target, message } })).isError, true);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "1");

    const concurrent = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    const raced = await Promise.all([
      mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: concurrent.selectionToken, threadId: target, message } }),
      mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: concurrent.selectionToken, threadId: target, message } })
    ]);
    assert.equal(raced.filter(item => item.isError).length, 1);
    assert.equal(raced.filter(item => !item.isError && result(item).state === "accepted").length, 1);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "11");

    const changed = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, "changed"), "");
    assert.equal((await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: changed.selectionToken, threadId: target, message } })).isError, true);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "11");
    fs.unlinkSync(join(root, "changed"));

    const noIntent = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, `message-${noIntent.selectionToken}.json`), "fixture collision", { flag: "wx" });
    const refused = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: noIntent.selectionToken, threadId: target, message } }));
    assert.equal(refused.state, "not_sent");
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "11");

    const unknown = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, "reject-send"), "");
    const uncertain = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: unknown.selectionToken, threadId: target, message } }));
    assert.equal(uncertain.state, "uncertain");
    assert.equal(JSON.parse(fs.readFileSync(join(root, `message-${unknown.selectionToken}.json`), "utf8")).state, "dispatch_intent");
    assert.equal((await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: unknown.selectionToken, threadId: target, message } })).isError, true);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "111");
  } finally { mcp.close(); }
  console.log("message bridge: host refresh, expired lifecycle isolation, list/select/send, concurrent single-use token, changed target, and no-intent no-send passed");
} finally {
  for (const child of children) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
