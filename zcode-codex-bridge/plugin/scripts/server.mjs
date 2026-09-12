import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { hostOperation, loadHostConfig } from "./host-client.mjs";

const text = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength });
export const tools = [
  {
    name: "codex_host_report",
    description: "Send one fixed test report to the bound running Codex desktop task through its official local adapter. Does not change model or approvals. Accepted is not received or completed. No retry after uncertainty. Requires a locally installed, unexpired host binding.",
    inputSchema: { type: "object", properties: { requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" }, requireIdle: { type: "boolean", description: "Send only if the fresh target read confirms idle or notLoaded; otherwise return not_idle without sending. Does not wait or poll." } }, required: ["requestId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "codex_binding_status",
    description: "Inspect the fixed local binding, configuration errors (including expiry), receipt counts, and metadata-only Hook probe summary. Never creates data or contacts Codex; configured does not prove a live connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "codex_thread_read",
    description: "Read the bound Codex task summary without turns or generation. Rejects a task ID or cwd mismatch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "codex_fixed_reply_test",
    description: "Live sending is disabled in this candidate. Returns blocked without starting Codex or changing task settings. The fixed-reply implementation is exercised only with an in-memory test transport.",
    inputSchema: {
      type: "object",
      properties: { requestId: text(128) },
      required: ["requestId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw Error(`Missing plugin configuration: ${name}`);
  return value;
};
const canonical = value => {
  const path = resolve(value);
  return normalize(existsSync(path) ? realpathSync.native(path) : path).toLowerCase();
};

export function loadBinding(env = process.env, now = Date.now()) {
  const codexScript = required(env, "ZCC_CODEX_SCRIPT");
  const cwd = required(env, "ZCC_CODEX_CWD");
  const expiresAt = required(env, "ZCC_BINDING_EXPIRES_AT");
  const expiry = Date.parse(expiresAt);
  if (!existsSync(codexScript) || basename(codexScript).toLowerCase() !== "codex.js") throw Error("Codex script must be an existing codex.js file");
  if (!existsSync(cwd)) throw Error("Bound Codex cwd does not exist");
  if (!Number.isFinite(expiry) || expiry <= now) throw Error("Binding expiry is invalid or has passed");
  const binding = {
    codexScript: realpathSync.native(codexScript),
    threadId: required(env, "ZCC_CODEX_THREAD_ID"),
    cwd: realpathSync.native(cwd),
    sourceSessionId: required(env, "ZCC_SOURCE_SESSION_ID"),
    teamId: required(env, "ZCC_TEAM_ID"),
    expiresAt: new Date(expiry).toISOString(),
    expectedReply: required(env, "ZCC_EXPECTED_REPLY")
  };
  if (!/^[0-9a-f-]{36}$/i.test(binding.threadId)) throw Error("Invalid bound Codex task ID");
  if (!/^sess_[A-Za-z0-9-]+$/.test(binding.sourceSessionId)) throw Error("Invalid source ZCode session ID");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(binding.teamId)) throw Error("Invalid team label");
  if (!/^[A-Z0-9_]{1,64}$/.test(binding.expectedReply)) throw Error("Expected reply must be 1-64 uppercase letters, digits, or underscores");
  return binding;
}

function bindingFingerprint(binding) {
  return createHash("sha256").update(JSON.stringify({ codexScript: canonical(binding.codexScript), threadId: binding.threadId,
    cwd: canonical(binding.cwd), sourceSessionId: binding.sourceSessionId, teamId: binding.teamId,
    expiresAt: binding.expiresAt, expectedReply: binding.expectedReply })).digest("hex");
}

function assertBoundThread(thread, binding) {
  if (!thread || thread.id !== binding.threadId) throw Error("Codex returned a different task");
  if (typeof thread.cwd !== "string" || canonical(thread.cwd) !== canonical(binding.cwd)) throw Error("Codex task cwd does not match the binding");
  return thread;
}

class AppServerClient {
  constructor(binding, { spawnProcess = spawn, timeoutMs = 120000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    this.child = spawnProcess(process.execPath, [binding.codexScript, "app-server"], {
      cwd: binding.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4096); });
    createInterface({ input: this.child.stdout }).on("line", line => this.receive(line));
    this.child.on("error", error => this.failAll(error));
    this.child.on("exit", code => this.failAll(Error(`Codex app-server exited (${code ?? "unknown"})`)));
  }

  write(message) {
    if (!this.child.stdin.writable) throw Error("Codex app-server input is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, "id") && message.method) return this.declineServerRequest(message);
    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      return message.error ? pending.reject(Error(message.error.message ?? "Codex request failed")) : pending.resolve(message.result);
    }
    if (!message.method) return;
    this.events.push(message);
    for (const waiter of [...this.waiters]) if (waiter.predicate(message)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  }

  declineServerRequest(message) {
    if (message.method === "item/permissions/requestApproval") return this.write({ id: message.id, result: { permissions: [] } });
    if (message.method === "mcpServer/elicitation/request") return this.write({ id: message.id, result: { action: "decline", content: null } });
    if (message.method.endsWith("/requestApproval")) return this.write({ id: message.id, result: { decision: "decline" } });
    this.write({ id: message.id, error: { code: -32000, message: "Bound bridge declines interactive server requests" } });
  }

  request(method, params = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Codex ${method} timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.write({ method, id, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  waitFor(predicate) {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate, resolve: resolvePromise, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(Error("Codex turn completion timed out"));
      }, this.timeoutMs);
      this.waiters.push(waiter);
    });
  }

  failAll(error) {
    this.closedError = error;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters = [];
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "zcode_codex_bridge", title: "ZCode Codex Bridge", version: "0.1.0" } });
    this.write({ method: "initialized", params: {} });
  }

  close() {
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }
}

export async function readBoundThread(binding, options) {
  const client = new AppServerClient(binding, options);
  try {
    await client.initialize();
    const { thread } = await client.request("thread/read", { threadId: binding.threadId, includeTurns: false });
    assertBoundThread(thread, binding);
    return { threadId: thread.id, name: thread.name ?? null, cwd: thread.cwd, status: thread.status ?? null, updatedAt: thread.updatedAt ?? null };
  } finally { client.close(); }
}

export async function sendFixedReplyTest(binding, { onDispatch = async () => {}, ...options } = {}) {
  if (!options.spawnProcess) throw Error("Live sending disabled: host ownership and test permission decision required");
  const client = new AppServerClient(binding, options);
  try {
    await client.initialize();
    const read = await client.request("thread/read", { threadId: binding.threadId, includeTurns: false });
    assertBoundThread(read.thread, binding);
    if (!["idle", "notLoaded"].includes(read.thread.status?.type)) throw Error("Bound Codex task is not confirmed idle");
    const resumed = await client.request("thread/resume", { threadId: binding.threadId });
    assertBoundThread(resumed.thread, binding);
    if (resumed.thread.status?.type !== "idle") throw Error("Bound Codex task is not idle after resume");
    const prompt = `这是 ZCode→Codex 固定回复连接验证，不继续该任务原业务。请仅回复：${binding.expectedReply}。不要调用工具、修改文件、启动任务或提出后续行动。`;
    if (Date.parse(binding.expiresAt) <= Date.now()) throw Error("Binding expired before dispatch");
    await onDispatch();
    const started = await client.request("turn/start", { threadId: binding.threadId, input: [{ type: "text", text: prompt }], cwd: binding.cwd,
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } } });
    const turnId = started.turn?.id;
    if (!turnId) throw Error("Codex did not return a turn ID");
    const completed = await client.waitFor(event => event.method === "turn/completed" && event.params?.threadId === binding.threadId && event.params?.turn?.id === turnId);
    const items = client.events.filter(event => event.method === "item/completed" && event.params?.threadId === binding.threadId && event.params?.turnId === turnId)
      .map(event => event.params.item).filter(Boolean);
    const userMessage = items.find(item => item.type === "userMessage");
    const assistantMessage = [...items].reverse().find(item => item.type === "agentMessage");
    const passiveItemTypes = new Set(["userMessage", "agentMessage", "reasoning", "plan"]);
    const observedItems = client.events.filter(event => ["item/started", "item/completed"].includes(event.method) &&
      event.params?.threadId === binding.threadId && event.params?.turnId === turnId).map(event => event.params.item ?? {});
    const nonPassiveItemTypes = [...new Set(observedItems.filter(item => !passiveItemTypes.has(item.type)).map(item => item.type ?? "unknown"))];
    const toolUseObserved = nonPassiveItemTypes.length > 0;
    const reply = assistantMessage?.text ?? "";
    return {
      threadId: binding.threadId,
      turnId,
      turnStatus: completed.params.turn.status,
      userMessageId: userMessage?.id ?? null,
      assistantMessageId: assistantMessage?.id ?? null,
      reply,
      toolUseObserved,
      nonPassiveItemTypes,
      evidenceComplete: completed.params.turn.status === "completed" && !!userMessage?.id && !!assistantMessage?.id,
      replyMatched: completed.params.turn.status === "completed" && !toolUseObserved && reply.trim() === binding.expectedReply,
      completedAt: new Date().toISOString()
    };
  } finally { client.close(); }
}

function dataDir(env = process.env) {
  const value = required(env, "ZCODE_PLUGIN_DATA");
  mkdirSync(value, { recursive: true });
  return resolve(value);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw Error(`Cannot read ${basename(path)}`); }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

function ledgerAt(root) { return join(root, "send-ledger.json"); }
function readLedger(root) {
  const ledger = readJson(ledgerAt(root), { version: 1, records: {} });
  if (ledger.version !== 1 || !ledger.records || typeof ledger.records !== "object") throw Error("Unsupported send ledger");
  return ledger;
}

function probeSummary(root) {
  const probe = readJson(join(root, "hook-events.json"), { version: 1, events: [] });
  const events = Array.isArray(probe.events) ? probe.events : [];
  return { count: events.length, lastEvent: events.at(-1) ?? null };
}

function validateArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid tool arguments");
  const keys = Object.keys(args);
  if (name === "codex_host_report") {
    if (keys.some(key => !["requestId", "requireIdle"].includes(key)) || !/^[A-Za-z0-9_-]{1,100}$/.test(args.requestId ?? "") || (Object.hasOwn(args, "requireIdle") && typeof args.requireIdle !== "boolean")) throw Error("Invalid host arguments");
    return;
  }
  if (name !== "codex_fixed_reply_test" && keys.length) throw Error("This tool accepts no arguments");
  if (name === "codex_fixed_reply_test" && (keys.length !== 1 || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestId ?? ""))) throw Error("Invalid requestId");
}

function bindingStatus({ env = process.env, binding, root } = {}) {
  const diagnostics = [];
  let bindingValid = false, hostReportConfigured = false, receipts = null, hookProbe = null;
  try { binding ??= loadBinding(env); bindingValid = true; }
  catch (error) { diagnostics.push({ scope: "binding", code: "binding_invalid",
    message: error.code ? "Cannot read configured binding paths" : error.message }); }
  // An invalid binding remains display-only; no read/send operation uses this fallback.
  const info = binding ?? { sourceSessionId: env.ZCC_SOURCE_SESSION_ID ?? null, threadId: env.ZCC_CODEX_THREAD_ID ?? null,
    cwd: env.ZCC_CODEX_CWD ?? null, teamId: env.ZCC_TEAM_ID ?? null,
    expiresAt: env.ZCC_BINDING_EXPIRES_AT ?? null, expectedReply: env.ZCC_EXPECTED_REPLY ?? null };
  try { root ??= resolve(required(env, "ZCODE_PLUGIN_DATA")); }
  catch { diagnostics.push({ scope: "storage", code: "data_path_missing", message: "Missing plugin configuration: ZCODE_PLUGIN_DATA" }); }
  if (root) {
    try { loadHostConfig(root, info); hostReportConfigured = bindingValid; }
    catch (error) { diagnostics.push(...(error.diagnostics ?? [{ code: "host_config_unreadable", message: "Cannot inspect host configuration" }])
      .map(issue => ({ scope: "host", ...issue }))); }
    try {
      receipts = Object.values(readLedger(root).records).reduce((result, record) => ({ ...result, [record.state]: (result[record.state] ?? 0) + 1 }), {});
    } catch { diagnostics.push({ scope: "receipts", code: "receipts_unreadable", message: "Cannot read send ledger" }); }
    try { hookProbe = probeSummary(root); }
    catch { diagnostics.push({ scope: "hook_probe", code: "hook_probe_unreadable", message: "Cannot read Hook probe metadata" }); }
  }
  return { state: diagnostics.length ? "blocked" : "configured", bindingValid, connectionVerified: false, diagnostics,
    sourceSessionId: info.sourceSessionId, sourceIdentityAuthenticated: false, threadId: info.threadId, cwd: info.cwd,
    teamId: info.teamId, teamIdAuthorizes: false, expiresAt: info.expiresAt, expectedReply: info.expectedReply,
    fixedReplyTestEnabled: false, hostReportConfigured, receipts, hookProbe };
}

export async function callTool(name, args = {}, deps = {}) {
  if (!tools.some(tool => tool.name === name)) throw Error("Unknown tool");
  validateArgs(name, args);
  if (name === "codex_fixed_reply_test" && !deps.send) return { state: "blocked", sent: false,
    reason: "Live sending disabled: host ownership and test permission decision required" };
  if (name === "codex_binding_status") return bindingStatus(deps);
  const binding = deps.binding ?? loadBinding(deps.env);
  const root = deps.root ?? dataDir(deps.env);
  if (name === "codex_host_report") return (deps.host ?? hostOperation)(binding, root, args.requestId, { requireIdle: args.requireIdle === true });
  if (name === "codex_thread_read") return deps.read ? deps.read(binding) : hostOperation(binding, root);

  const ledger = readLedger(root);
  let record = ledger.records[args.requestId];
  const fingerprint = bindingFingerprint(binding);
  if (record && record.bindingFingerprint !== fingerprint) throw Error("requestId conflicts with another binding");
  if (record?.state === "dispatching") {
    record = { ...record, state: "uncertain", updatedAt: new Date().toISOString(), error: "Previous process ended after dispatch became possible" };
    ledger.records[args.requestId] = record; writeJson(ledgerAt(root), ledger);
  }
  if (record && !["queued", "failed_preflight"].includes(record.state)) return { deduplicated: true, ...record };
  const stamp = new Date().toISOString();
  record = { requestId: args.requestId, bindingFingerprint: fingerprint, threadId: binding.threadId, expectedReply: binding.expectedReply,
    state: "queued", createdAt: record?.createdAt ?? stamp, updatedAt: stamp };
  ledger.records[args.requestId] = record; writeJson(ledgerAt(root), ledger);
  let dispatching = false;
  try {
    const result = await (deps.send ?? sendFixedReplyTest)(binding, { onDispatch: async () => {
      dispatching = true; record = { ...record, state: "dispatching", updatedAt: new Date().toISOString() };
      ledger.records[args.requestId] = record; writeJson(ledgerAt(root), ledger);
    } });
    record = { ...record, state: result.turnStatus === "completed" ? "completed" : "failed_terminal", updatedAt: new Date().toISOString(), result };
  } catch (error) {
    record = { ...record, state: dispatching ? "uncertain" : "failed_preflight", updatedAt: new Date().toISOString(), error: error.message };
  }
  ledger.records[args.requestId] = record; writeJson(ledgerAt(root), ledger);
  return { deduplicated: false, ...record };
}

const output = message => process.stdout.write(JSON.stringify(message) + "\n");
const protocolVersion = "2025-06-18";

export async function handleGateway(message, state, { send = output, invoke = callTool } = {}) {
  const failure = (id, code, errorMessage) => send({ jsonrpc: "2.0", id, error: { code, message: errorMessage } });
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  const hasId = Object.hasOwn(message, "id") && (typeof message.id === "number" || typeof message.id === "string");
  const { method, params = {} } = message;
  if (!hasId) {
    if (method === "notifications/initialized" && state.initializeResponded) state.ready = true;
    return;
  }
  const id = message.id;
  if (!params || typeof params !== "object" || Array.isArray(params)) return failure(id, -32602, "Invalid params");
  if (method === "initialize") {
    if (state.initializeResponded) return failure(id, -32600, "Already initialized");
    if (typeof params.protocolVersion !== "string") return failure(id, -32602, "Missing protocol version");
    state.initializeResponded = true;
    return send({ jsonrpc: "2.0", id, result: { protocolVersion,
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: "zcode-codex-bridge", version: "0.2.4" } } });
  }
  if (!state.ready) return failure(id, -32002, "Not initialized");
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
  if (method !== "tools/call") return failure(id, -32601, "Unsupported method");
  try { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(await invoke(params.name, params.arguments)) }] } }); }
  catch (error) { failure(id, -32602, error.message); }
}

export async function runGateway() {
  const state = { initializeResponded: false, ready: false };
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC" } }); continue; }
    await handleGateway(message, state);
  }
}

if (canonical(fileURLToPath(import.meta.url)) === canonical(process.argv[1] ?? "")) await runGateway();
