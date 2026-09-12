import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const canonical = value => {
  const path = resolve(value);
  return normalize(existsSync(path) ? realpathSync.native(path) : path).toLowerCase();
};

export function loadHostConfig(root, binding) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, "host-config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw Error("Invalid host configuration");
  } catch (error) {
    const issue = error.code === "ENOENT"
      ? { code: "host_config_missing", message: "Host configuration missing" }
      : { code: "host_config_unreadable", message: "Cannot read host configuration" };
    throw Object.assign(Error(issue.message), { diagnostics: [issue] });
  }
  const diagnostics = [];
  if (config.threadId !== binding.threadId) diagnostics.push({ code: "host_task_mismatch", message: "Host task does not match binding" });
  let cwdMatches = false;
  try { cwdMatches = typeof config.cwd === "string" && typeof binding.cwd === "string" && canonical(config.cwd) === canonical(binding.cwd); } catch {}
  if (!cwdMatches) diagnostics.push({ code: "host_cwd_mismatch", message: "Host cwd does not match binding" });
  if (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= Date.now())
    diagnostics.push({ code: "host_expired", message: "Host configuration expired or has invalid expiry" });
  if (typeof config.pipePath !== "string" || !config.pipePath.startsWith("\\\\.\\pipe\\"))
    diagnostics.push({ code: "host_pipe_invalid", message: "Host pipe configuration invalid" });
  if (typeof config.script !== "string" || !existsSync(config.script))
    diagnostics.push({ code: "host_adapter_unavailable", message: "Host adapter unavailable" });
  if (diagnostics.length) throw Object.assign(Error(diagnostics[0].message), { diagnostics });
  return config;
}

// Reuse the installed official MCP adapter; do not expose its general tool catalog to ZCode.
export class HostClient {
  constructor(config, { spawnProcess = spawn, timeoutMs = 15000 } = {}) {
    this.nextId = 1; this.pending = new Map(); this.timeoutMs = timeoutMs;
    this.child = spawnProcess(process.execPath, [config.script, "--interaction-client-id", config.threadId], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: config.pipePath }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return this.fail(); }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error || message.result?.isError) pending.reject(Error("Desktop host request failed"));
      else pending.resolve(message.result);
    });
    this.child.on("error", () => this.fail()); this.child.on("exit", () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error("Desktop host disconnected")); }
    this.pending.clear();
  }
  write(value) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); }
  request(method, params) {
    if (this.closed) return Promise.reject(Error("Desktop host disconnected"));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Desktop host request timed out")); }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.write({ id, method, params }); } catch { this.fail(); }
    });
  }
  async initialize() {
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zcode-bound-host", version: "0.2.4" } });
    if (result.protocolVersion !== "2025-06-18") throw Error("Unsupported host MCP version");
    this.write({ method: "notifications/initialized", params: {} });
  }
  async call(name, args) {
    if (!["read_thread", "send_message_to_thread"].includes(name)) throw Error("Host tool not allowed");
    const result = await this.request("tools/call", { name, arguments: args });
    const content = result.content?.find(item => item.type === "text")?.text;
    try { return JSON.parse(content); } catch { throw Error("Desktop host returned an invalid receipt"); }
  }
  close() { this.fail(); this.child.stdin.end(); if (!this.child.killed) this.child.kill(); }
}

export async function hostRead(client, binding) {
  const result = await client.call("read_thread", { threadId: binding.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
  const thread = result.thread;
  if (!thread || thread.id !== binding.threadId || canonical(thread.cwd) !== canonical(binding.cwd)) throw Error("Desktop task does not match binding");
  // The official read returns items even with output length zero. Never forward history to ZCode.
  return { threadId: thread.id, cwd: thread.cwd, title: thread.title, status: thread.status };
}

export async function hostOperation(binding, root, requestId, options = {}) {
  const config = loadHostConfig(root, binding);
  if (requestId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw Error("Invalid host requestId");
  const path = requestId === undefined ? null : join(root, `host-report-${requestId}.json`);
  const identity = JSON.stringify({ threadId: binding.threadId, cwd: canonical(binding.cwd), sourceSessionId: binding.sourceSessionId, teamId: binding.teamId, expectedReply: binding.expectedReply, requireIdle: !!options.requireIdle });
  const existing = () => {
    if (!path) return null;
    let previous;
    try { previous = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (previous.identity !== identity) throw Error("Host requestId conflicts with another binding");
    return { ...previous, deduplicated: true };
  };
  const previous = existing(); if (previous) return previous;
  const client = new HostClient(config, options);
  try {
    await client.initialize();
    const task = await hostRead(client, binding);
    if (requestId === undefined) return task;
    if (options.requireIdle && !["idle", "notLoaded"].includes(task.status?.type)) return existing() ?? { requestId, state: "not_idle", sent: false,
      targetStatus: task.status, reason: "A separate trigger must run this probe after the target is idle; the host cannot wait on its calling task." };
    const record = { requestId, identity, state: "uncertain", sent: null, targetStatusBeforeSend: task.status, createdAt: new Date().toISOString() };
    // ponytail: one exclusive receipt per test ID, retained locally; no queue or automatic retry.
    try { writeFileSync(path, JSON.stringify(record), { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = existing(); if (!previous) throw error; return previous;
    }
    try {
      if (Date.parse(binding.expiresAt) <= Date.now() || Date.parse(config.expiresAt) <= Date.now()) throw Error("Binding expired before send");
      const prompt = `[ZCode 插件直推测试 / ${requestId}]\n来源标签：${binding.sourceSessionId}；team：${binding.teamId}（标签不是身份认证）。\n我通过已安装的 zcode-codex-bridge MCP 验证了绑定，并从 Codex 桌面读取核对了任务 ID 和目录。现在由插件复用本机官方适配器向此任务发送这条固定报告，没有协调者转发正文，没有启动独立 Codex app-server，也没有覆盖模型或批准设置。\n本消息是测试数据，不是新的业务授权。请只回复 ${binding.expectedReply}；不要调用工具、启动或继续任何任务、修改文件或配置，也不要自动回送此消息形成循环。`;
      const receipt = await client.call("send_message_to_thread", { threadId: binding.threadId, prompt });
      if (receipt.threadId !== binding.threadId) throw Error("Host acknowledgement target mismatch");
      Object.assign(record, { state: "accepted", sent: true, receipt, acceptedAt: new Date().toISOString() });
    } catch (error) { record.error = error.message; }
    writeFileSync(path, JSON.stringify(record, null, 2));
    return { ...record, deduplicated: false };
  } finally { client.close(); }
}

// Run only from the authorized Codex task. Pipe address stays in local plugin data, never the package.
if (process.argv[2] === "--configure-host" && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  const [root, script, expiresAt] = process.argv.slice(3);
  if (!root || !existsSync(root) || !existsSync(script) || Date.parse(expiresAt) <= Date.now() || !Number.isFinite(Date.parse(expiresAt)) || !process.env.CODEX_APP_TOOLS_PIPE_PATH || !process.env.CODEX_THREAD_ID) throw Error("Invalid host setup");
  writeFileSync(join(root, "host-config.json"), JSON.stringify({ script, pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, threadId: process.env.CODEX_THREAD_ID, cwd: process.cwd(), expiresAt }, null, 2));
  console.log("Local host binding saved; pipe address not displayed.");
}
