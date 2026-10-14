import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import "./task-state.test.mjs";
import "./remote.test.mjs";
import "./queue.test.mjs";

const agentEnv = JSON.parse(readFileSync("mcacp.json", "utf8")).agent_servers.zcode.env;
const profile = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  import { homedir } from 'node:os';
  import { ZCODE_CREDS_PATH } from './node_modules/zcode-acp-server/dist/utils.js';
  console.log(JSON.stringify({ credentials: ZCODE_CREDS_PATH, home: homedir(), base: process.env.ZCODE_DATA_BASE_DIR }));
`], { env: { ...process.env, ...agentEnv }, encoding: "utf8" }));
assert.equal(profile.credentials.replaceAll("\\", "/"), join(process.env.HOME || process.env.USERPROFILE, ".zcode", "v2", "config.json").replaceAll("\\", "/"));
assert.equal(profile.base, agentEnv.ZCODE_DATA_BASE_DIR ?? process.env.ZCODE_DATA_BASE_DIR);
if (process.platform === "win32") assert.equal(profile.home, process.env.USERPROFILE, "Native CLI home must not move with ACP credentials");
assert(readFileSync("scripts/legacy-gateway.mjs", "utf8").includes("env: { ...process.env, ...zcodeEnv }"), "Inventory must reuse the configured agent environment");
console.log("zcode-ops desktop profile routing: OK");

const child = spawn(process.execPath, ["scripts/legacy-gateway.mjs"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
const version = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8")).version;
const replies = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line); const resolve = replies.get(message.id);
  if (resolve) { replies.delete(message.id); resolve(message); }
});
function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
try {
  const initialized = (await request(1, "initialize", { protocolVersion: "2025-06-18" })).result.serverInfo;
  assert.equal(initialized.name, "zcode-ops");
  assert.equal(initialized.version, version);
  const tools = (await request(2, "tools/list")).result.tools;
  const names = tools.map((tool) => tool.name);
  assert(names.includes("zcode_initialize"));
  assert(names.includes("zcode_desktop_sessions_status"));
  assert(names.includes("zcode_bridge_session_status"));
  assert(names.includes("zcode_task_poll"));
  for (const name of ["zcode_queue_enqueue", "zcode_queue_read", "zcode_queue_control", "zcode_queue_resolve"]) assert(names.includes(name));
  const invalidQueue = await request(21, "tools/call", { name: "zcode_queue_enqueue", arguments: {} });
  assert.match(invalidQueue.error.message, /Missing requestId/);
  for (const name of ["zcode_remote_tasks", "zcode_remote_read", "zcode_remote_wait", "zcode_remote_read_many", "zcode_remote_wait_many", "zcode_remote_cancel", "zcode_remote_models", "zcode_remote_set_model", "zcode_remote_send"]) assert(names.includes(name));
  assert(tools.find(t => t.name === "zcode_remote_read").inputSchema.properties.afterCursor);
  assert.deepEqual(tools.find(t => t.name === "zcode_remote_wait").inputSchema.properties.mode.enum, ["status", "messages"]);
  assert.equal(tools.find(t => t.name === "zcode_remote_read_many").inputSchema.properties.taskIds.type, "array");
  assert(tools.find(t => t.name === "zcode_remote_wait_many").inputSchema.properties.afterCursors);
  for (const name of ["zcode_config_status", "zcode_config_set", "zcode_config_clear"]) assert(names.includes(name));
  assert(!names.includes("zcode_config_prompt"));
  const invalidRemote = await request(20, "tools/call", { name: "zcode_remote_send", arguments: { prompt: "do-not-send" } });
  assert.match(invalidRemote.error.message, /Missing taskId/);
  assert(!names.includes("agent_install"));
  assert(!names.includes("registry_search"));
  for (const [index, name] of ["zcode_new_session", "zcode_load_session", "zcode_prompt_start"].entries()) {
    assert(!names.includes(name), `${name} must not be advertised while unsafe`);
    const denied = await request(10 + index, "tools/call", { name, arguments: { cwd: process.cwd(), sessionId: "do-not-resume", prompt: "do-not-send" } });
    assert.equal(denied.error?.code, -32001);
    assert.match(denied.error.message, /no session was created, loaded, or prompted/);
  }
  const status = JSON.parse((await request(3, "tools/call", { name: "zcode_bridge_session_status", arguments: { sessionId: "not-tracked" } })).result.content[0].text);
  assert.equal(status.state, "untracked");
  console.log("zcode-ops gateway allowlist: OK");
  console.log("zcode-ops unsafe create / load / send blocked before backend startup: OK");
} finally { child.stdin.end(); child.kill(); }
