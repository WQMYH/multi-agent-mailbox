import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { publicTools } from "./tools.mjs";

const manifest = path => JSON.parse(readFileSync(path, "utf8"));
const codexMarket = manifest(".agents/plugins/marketplace.json"), zcodeMarket = manifest("marketplace.json");
assert.equal(codexMarket.name, "codex-with-zcode");
assert.equal(zcodeMarket.name, codexMarket.name);
assert.deepEqual(codexMarket.plugins[0].source, { source: "local", path: "./" });
assert.equal(codexMarket.plugins[0].name, manifest(".codex-plugin/plugin.json").name);
const companion = zcodeMarket.plugins[0];
assert.equal(companion.source, "./zcode-codex-bridge/plugin");
assert.equal(companion.name, manifest(companion.source + "/.zcode-plugin/plugin.json").name);
assert.equal(companion.version, manifest(companion.source + "/.zcode-plugin/plugin.json").version);

// These checks temporarily override process.env; do not evaluate them concurrently.
await import("./remote.test.mjs");
await import("./queue.test.mjs");
await import("./queue-blocking.test.mjs");
await import("./rate-retry.test.mjs");
await import("./tools.test.mjs");
await import("./retention.test.mjs");
await import("./concurrency.test.mjs");

const child = spawn(process.execPath, ["scripts/mcp-gateway.mjs"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map(); let id = 0;
createInterface({ input: child.stdout }).on("line", line => {
  const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id);
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => reject(Error("MCP test timed out")), 5000);
    pending.set(key, r => { clearTimeout(timer); resolve(r); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
  });
}
try {
  const info = (await request("initialize")).result.serverInfo;
  assert.equal(info.version, JSON.parse(readFileSync(".codex-plugin/plugin.json")).version);
  const listed = (await request("tools/list")).result.tools;
  assert.deepEqual(listed, publicTools);
  assert.equal(listed.length, 8);
  const config = JSON.parse(readFileSync(".mcp.json")).mcpServers["zcode-ops"].tools;
  assert.deepEqual(Object.keys(config).sort(), listed.map(t => t.name).sort());
  for (const tool of listed) assert.equal(config[tool.name].approval_mode, tool.annotations.readOnlyHint ? "auto" : "prompt");
  for (const name of ["zcode_initialize", "zcode_new_session", "zcode_load_session", "zcode_prompt_start", "zcode_remote_send", "zcode_queue_enqueue", "zcode_remote_read_many"]) {
    const r = await request("tools/call", { name, arguments: {} });
    assert.equal(r.error.code, -32601); assert.match(r.error.message, /No action performed/);
  }
  assert.match((await request("tools/call", { name: "zcode_send", arguments: {} })).error.message, /Missing requestId/);
  assert.match((await request("tools/call", { name: "zcode_read", arguments: { view: "conversation" } })).error.message, /requires taskIds/);
  console.log("zcode-ops public MCP: exactly 8 tools, read/write approvals, legacy and direct sends unavailable OK");
} finally { child.stdin.end(); child.kill(); }
