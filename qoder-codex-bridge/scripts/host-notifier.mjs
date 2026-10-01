import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { markSent, markDispatchIntent, markSendUncertain } from "./event-recorder.mjs";

const canonical = value => {
  const path = resolve(value);
  return normalize(existsSync(path) ? realpathSync.native(path) : path).toLowerCase();
};

// Each failure carries a top-level `code` so the handler can classify missing/expired/invalid
// host configuration consistently (and separately from a real transport unknown).
export function loadHostConfig(dataDir, binding = null) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(resolve(dataDir), "host-config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw Object.assign(Error("Invalid host configuration"), { code: "host_config_invalid" });
  } catch (error) {
    const issue = error.code === "ENOENT"
      ? { code: "host_config_missing", message: "Host configuration missing" }
      : { code: error.code ?? "host_config_unreadable", message: error.code === "host_config_invalid" ? "Invalid host configuration" : "Cannot read host configuration" };
    throw Object.assign(Error(issue.message), { code: issue.code, diagnostics: [issue] });
  }
  const diagnostics = [];
  if (typeof config.threadId !== "string" || !config.threadId)
    diagnostics.push({ code: "host_task_invalid", message: "Host task configuration invalid" });
  if (binding && config.threadId !== binding.targetTaskId)
    diagnostics.push({ code: "host_task_mismatch", message: "Host task does not match binding" });
  let cwdMatches = false;
  try { cwdMatches = typeof config.cwd === "string" && !!config.cwd && (!binding || (typeof binding.targetCwd === "string" && canonical(config.cwd) === canonical(binding.targetCwd))); } catch {}
  if (!cwdMatches) diagnostics.push({ code: binding ? "host_cwd_mismatch" : "host_cwd_invalid", message: binding ? "Host cwd does not match binding" : "Host cwd configuration invalid" });
  if (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= Date.now())
    diagnostics.push({ code: "host_expired", message: "Host configuration expired or has invalid expiry" });
  if (typeof config.pipePath !== "string" || !config.pipePath.startsWith("\\\\.\\pipe\\")
      || config.pipePath.length > 4096 || /[\x00-\x1f\x7f\u0080-\u009f]/.test(config.pipePath))
    diagnostics.push({ code: "host_pipe_invalid", message: "Host pipe configuration invalid" });
  if (typeof config.script !== "string" || !existsSync(config.script))
    diagnostics.push({ code: "host_adapter_unavailable", message: "Host adapter unavailable" });
  if (diagnostics.length) throw Object.assign(Error(diagnostics[0].message), { code: diagnostics[0].code, diagnostics });
  return config;
}

export class HostClient {
  constructor(config, { spawnProcess = spawn, timeoutMs = 15000 } = {}) {
    this.nextId = 1; this.pending = new Map(); this.timeoutMs = timeoutMs; this.codexThreadId = config.threadId;
    this.child = spawnProcess(process.execPath, [config.script], {
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
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qoder-bound-bridge", version: "0.1.0" } });
    if (result.protocolVersion !== "2025-06-18") throw Error("Unsupported host MCP version");
    this.write({ method: "notifications/initialized", params: {} });
  }
  async call(name, args) {
    if (!["list_threads", "read_thread", "send_message_to_thread"].includes(name)) throw Error("Host tool not allowed");
    const result = await this.request("tools/call", { name, arguments: args, _meta: { codexThreadId: this.codexThreadId } });
    const content = result.content?.find(item => item.type === "text")?.text;
    try { return JSON.parse(content); } catch { throw Error("Desktop host returned an invalid receipt"); }
  }
  close() { this.fail(); this.child.stdin.end(); if (!this.child.killed) this.child.kill(); }
}

export async function hostRead(client, binding) {
  const result = await client.call("read_thread", { threadId: binding.targetTaskId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
  const thread = result.thread;
  if (!thread || thread.id !== binding.targetTaskId || canonical(thread.cwd) !== canonical(binding.targetCwd)) throw Error("Desktop task does not match binding");
  return { threadId: thread.id, cwd: thread.cwd, title: thread.title, status: thread.status };
}

export function buildNotificationPrompt(event) {
  if (event.signal === "verified_turn_result" && !["completed", "failed", "interrupted", "cancelled"].includes(event.data?.terminalOutcome))
    throw Error("Verified turn outcome invalid");
  const lines = [
    `[Qoder Return / ${event.requestId}]`,
    `Signal: ${event.signal}`,
    ...(event.signal === "verified_turn_result" ? [`Outcome: ${event.data.terminalOutcome}`] : []),
    `Source: ${event.source}`,
    `Observed: ${event.observedAt}`,
    `Workspace: ${event.workspaceId}`,
    `Session: ${event.sessionId}`,
    `HookSession: ${event.hookSessionId}`,
    `Evidence: ${event.evidenceRef}`,
    "",
    "This is a fixed-template lifecycle notification, not a business message.",
    "Do not invoke tools, start/continue tasks, modify files, or auto-reply."
  ];
  return lines.join("\n");
}

// `dispatched` distinguishes a genuine "not sent" (config/init/read/expiry/intent-persist
// all before the host call) from a real transport unknown (the send_message_to_thread
// attempt was made). A host ACK that cannot be durably recorded is NOT success.
export async function sendNotification(binding, dataDir, event, options = {}) {
  const assertActive = async () => {
    if (!options.assertActive) return;
    try { if (await options.assertActive() === false) throw Error("Provider inactive"); }
    catch { throw Object.assign(Error("Provider inactive"), { code: "provider_inactive", dispatched: false }); }
  };
  let config;
  try {
    config = loadHostConfig(dataDir);
  } catch (error) {
    throw Object.assign(error, { dispatched: false });
  }
  let client;
  try {
    await assertActive();
    // Construction can reject synchronously (Node spawn argument validation, e.g. an embedded
    // NUL in the pipe path). That is still before any send, so it is not-dispatched — reported
    // with a generic message so the raw argument/credential never reaches the caller.
    client = new HostClient(config, options);
  } catch (error) {
    if (error.code === "provider_inactive") throw error;
    throw Object.assign(Error("Host adapter could not be started"), { code: "host_spawn_failed", dispatched: false });
  }
  let dispatched = false;
  try {
    await assertActive();
    await client.initialize();
    const operator = { targetTaskId: config.threadId, targetCwd: config.cwd };
    await assertActive();
    await hostRead(client, operator);
    if (operator.targetTaskId !== binding.targetTaskId || canonical(operator.targetCwd) !== canonical(binding.targetCwd)) {
      await assertActive();
      await hostRead(client, binding);
    }
    if (Date.parse(binding.expiresAt) <= Date.now() || Date.parse(config.expiresAt) <= Date.now())
      throw Object.assign(Error("Binding expired before send"), { code: "binding_expired_before_send" });
    await assertActive();
    if (!markDispatchIntent(dataDir, event, binding))
      throw Object.assign(Error("Cannot persist send intent before dispatch"), { code: "dispatch_intent_failed" });
    await assertActive();
    dispatched = true;
    const prompt = buildNotificationPrompt(event);
    const receipt = await client.call("send_message_to_thread", { threadId: binding.targetTaskId, prompt });
    if (!receipt || receipt.threadId !== binding.targetTaskId)
      throw Object.assign(Error("Host acknowledgement target mismatch"), { code: "host_ack_target_mismatch" });
    if (!markSent(dataDir, event, binding, receipt))
      throw Object.assign(Error("Host accepted but receipt could not be persisted"), { code: "receipt_persist_failed" });
    return receipt;
  } catch (error) {
    if (dispatched) { try { markSendUncertain(dataDir, event, binding, error); } catch {} }
    throw Object.assign(error, { dispatched });
  } finally { client.close(); }
}
