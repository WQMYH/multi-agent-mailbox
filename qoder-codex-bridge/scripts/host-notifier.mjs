import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFileSync, existsSync, realpathSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { markSent, markDispatchIntent, markSendUncertain } from "./event-recorder.mjs";

const canonical = value => {
  const path = resolve(value);
  return normalize(existsSync(path) ? realpathSync.native(path) : path).toLowerCase();
};

// Each failure carries a top-level `code` so the handler can classify missing/invalid
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
  if (typeof config.pipePath !== "string" || !config.pipePath.startsWith("\\\\.\\pipe\\")
      || config.pipePath.length > 4096 || /[\x00-\x1f\x7f\u0080-\u009f]/.test(config.pipePath))
    diagnostics.push({ code: "host_pipe_invalid", message: "Host pipe configuration invalid" });
  if (typeof config.script !== "string" || !existsSync(config.script))
    diagnostics.push({ code: "host_adapter_unavailable", message: "Host adapter unavailable" });
  if (diagnostics.length) throw Object.assign(Error(diagnostics[0].message), { code: diagnostics[0].code, diagnostics });
  return config;
}

export class HostClient {
  constructor(config, { spawnProcess = spawn, timeoutMs = 15000, allowTaskCreation = false } = {}) {
    this.nextId = 1; this.pending = new Map(); this.timeoutMs = timeoutMs; this.codexThreadId = config.threadId;
    this.allowTaskCreation = allowTaskCreation === true;
    this.child = spawnProcess(process.execPath, [config.script], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: config.pipePath }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return this.fail(); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail();
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error || message.result?.isError) pending.reject(Object.assign(Error("Desktop host request failed"), {
        code: "host_request_failed",
        ...(Number.isInteger(message.error?.code) ? { hostRpcCode: message.error.code } : {})
      }));
      else pending.resolve(message.result);
    });
    this.child.on("error", () => this.fail()); this.child.on("exit", () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(Error("Desktop host disconnected"), { code: "host_disconnected" })); }
    this.pending.clear();
  }
  write(value) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); }
  request(method, params) {
    if (this.closed) return Promise.reject(Object.assign(Error("Desktop host disconnected"), { code: "host_disconnected" }));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(Error("Desktop host request timed out"), { code: "host_timeout" })); }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.write({ id, method, params }); } catch { this.fail(); }
    });
  }
  async initialize() {
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qoder-bound-bridge", version: "0.1.0" } });
    if (result.protocolVersion !== "2025-06-18") throw Object.assign(Error("Unsupported host MCP version"), { code: "host_protocol_mismatch" });
    this.write({ method: "notifications/initialized", params: {} });
  }
  async call(name, args) {
    if (!["list_threads", "read_thread", "send_message_to_thread"].includes(name) &&
        !(this.allowTaskCreation && ["list_projects", "create_thread"].includes(name))) throw Error("Host tool not allowed");
    const result = await this.request("tools/call", { name, arguments: args, _meta: { codexThreadId: this.codexThreadId } });
    const content = result.content?.find(item => item.type === "text")?.text;
    try { return JSON.parse(content); } catch { throw Object.assign(Error("Desktop host returned an invalid receipt"), { code: "host_response_invalid" }); }
  }
  close() { this.fail(); this.child.stdin.end(); if (!this.child.killed) this.child.kill(); }
}

export async function hostRead(client, binding) {
  const result = await client.call("read_thread", { threadId: binding.targetTaskId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
  const thread = result.thread;
  if (!thread || thread.id !== binding.targetTaskId || canonical(thread.cwd) !== canonical(binding.targetCwd)) throw Object.assign(Error("Desktop task does not match binding"), { code: "host_identity_mismatch" });
  return { threadId: thread.id, cwd: thread.cwd, title: thread.title, status: thread.status };
}

const nativePipe = /^\\\\\.\\pipe\\codex-browser-use-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hostFailure = code => Object.assign(Error(code), { code });

// Only inspect the one launcher/manifest-selected pipe; never scan browser endpoints or ports.
async function inspectHostPipe(pipePath) {
  if (process.platform !== "win32" || !nativePipe.test(pipePath)) throw hostFailure("host_binding_untrusted");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint serverProcessId);' -Name PipeOwner -Namespace CodexBinding
$pipe = $null
try {
  $name = $env:QODER_HOST_BINDING_PIPE.Substring(9)
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Anonymous)
  $pipe.Connect(500)
  [uint32]$serverPid = 0
  if (![CodexBinding.PipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$serverPid)) { throw 'unverified' }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
  $owner = Invoke-CimMethod -InputObject $processInfo -MethodName GetOwnerSid
  $server = Get-Process -Id $serverPid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $server.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'unverified' }
  $packages = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and $_.Status -eq 'Ok' -and $_.SignatureKind -eq 'Store' })
  $executables = @($packages | ForEach-Object { Join-Path $_.InstallLocation 'app/ChatGPT.exe' })
  if ($executables -notcontains $processInfo.ExecutablePath) { throw 'unverified' }
  if ((Get-AuthenticodeSignature -LiteralPath $processInfo.ExecutablePath).Status -ne 'Valid') { throw 'unverified' }
  @{serverPid=$serverPid;startedAt=$server.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress
} catch { exit 1 } finally { if ($pipe) { $pipe.Dispose() } }
`;
  try {
    const childEnv = { ...process.env, QODER_HOST_BINDING_PIPE: pipePath };
    // WindowsPowerShell must discover its own modules, not inherit a PowerShell 7 module path.
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: childEnv, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    const proof = JSON.parse(stdout);
    if (!Number.isSafeInteger(proof.serverPid) || proof.serverPid <= 0 || typeof proof.startedAt !== "string") throw Error();
    return proof;
  } catch { throw hostFailure("host_binding_untrusted"); }
}

function manifestPipe(config) {
  let server;
  try {
    server = JSON.parse(readFileSync(join(dirname(resolve(config.script)), ".mcp.json"), "utf8")).mcpServers?.codex_app;
  } catch (error) { throw hostFailure(error.code === "ENOENT" ? "host_binding_unavailable" : "host_binding_invalid"); }
  if (!server || typeof server.cwd !== "string" || canonical(join(server.cwd, "server.mjs")) !== canonical(config.script)
    || !Array.isArray(server.args) || !server.args.includes("./server.mjs")) throw hostFailure("host_binding_invalid");
  if (server.env?.CODEX_APP_TOOLS_PIPE_PATH === undefined) throw hostFailure("host_binding_unavailable");
  return server.env.CODEX_APP_TOOLS_PIPE_PATH;
}

function saveHostPipe(path, expected, config) {
  const lock = `${path}.lock`, temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd, temporaryCreated = false;
  try {
    try { fd = openSync(lock, "wx", 0o600); } catch { throw hostFailure("host_config_busy"); }
    if (readFileSync(path, "utf8") !== expected) throw hostFailure("host_config_changed");
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 }); temporaryCreated = true;
    if (readFileSync(path, "utf8") !== expected) throw hostFailure("host_config_changed");
    renameSync(temporary, path);
  } finally {
    if (temporaryCreated && existsSync(temporary)) unlinkSync(temporary);
    if (fd !== undefined) { closeSync(fd); unlinkSync(lock); }
  }
}

// Call only before dispatch. Returned clients never reconnect/replay an operation or a send.
export async function connectVerifiedHost(dataDir, options = {}) {
  const path = join(resolve(dataDir), "host-config.json"), config = loadHostConfig(dataDir), original = readFileSync(path, "utf8");
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(config)) throw hostFailure("host_config_changed");
  const operator = { targetTaskId: config.threadId, targetCwd: config.cwd };
  let client, originalError, stage = "initialize";
  const verify = async next => {
    await options.assertActive?.(); stage = "initialize";
    try { client = new HostClient(next, options); } catch { throw hostFailure("host_spawn_failed"); }
    await client.initialize(); await options.assertActive?.(); stage = "operator_read"; await hostRead(client, operator);
  };
  try {
    try {
      await verify(config);
      if (readFileSync(path, "utf8") !== original) throw hostFailure("host_config_changed");
      return { client, config, rebound: false };
    } catch (error) {
      client?.close(); client = undefined;
      if (!["host_disconnected", "host_timeout"].includes(error.code)
        && !(error.code === "host_request_failed" && error.hostRpcCode === -32603)) throw error;
      originalError = error;
    }
    let pipePath = options.preferredPipePath;
    if (pipePath === undefined) {
      try { pipePath = manifestPipe(config); }
      catch (error) {
        if (error.code === "host_binding_unavailable") throw Object.assign(originalError, { bindingStatus: "unavailable" });
        throw error;
      }
    }
    if (typeof pipePath !== "string" || !nativePipe.test(pipePath) || pipePath === config.pipePath) throw hostFailure("host_binding_invalid");
    const inspect = options.inspectPipe ?? inspectHostPipe, before = await inspect(pipePath);
    if (!Number.isSafeInteger(before?.serverPid) || before.serverPid <= 0 || typeof before.startedAt !== "string" || !before.startedAt)
      throw hostFailure("host_binding_untrusted");
    const next = { ...config, pipePath };
    await verify(next);
    const after = await inspect(pipePath);
    if (!before || !after || before.serverPid !== after.serverPid || before.startedAt !== after.startedAt) throw hostFailure("host_binding_untrusted");
    await options.assertActive?.();
    saveHostPipe(path, original, next);
    return { client, config: next, rebound: true };
  } catch (error) { client?.close(); throw Object.assign(error, { hostStage: stage }); }
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
    ({ client, config } = await connectVerifiedHost(dataDir, { ...options, assertActive }));
  } catch (error) {
    if (error.code === "provider_inactive") throw error;
    throw Object.assign(error, { dispatched: false });
  }
  let dispatched = false;
  try {
    await assertActive();
    const operator = { targetTaskId: config.threadId, targetCwd: config.cwd };
    await assertActive();
    if (operator.targetTaskId !== binding.targetTaskId || canonical(operator.targetCwd) !== canonical(binding.targetCwd)) {
      await assertActive();
      await hostRead(client, binding);
    }
    if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= Date.now())
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
