"use strict";

const { createServer } = require("node:http");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
const { claimMutation, ownerIdForStateDir, readMessage, recordCommandOutcome, reserveMessage,
  wireContent } = require("./message-store.cjs");

const target = Object.freeze({ id: "qoder-cn-ide", kind: "desktop", label: "Qoder CN IDE" });
const bridgeVersion = "0.2.0";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commands = Object.freeze({
  "px.runTiger": { argument: "target", completion: "unobservable_after_command_return" },
  "px.reloadScriptDocs": { argument: "none", completion: "command_returned" },
  "px.dumpIndexStats": { argument: "none", completion: "command_returned_result_not_exposed_by_toolkit" },
  "px.tigerUnused": { argument: "none", completion: "unobservable_after_command_return" },
  "aicoding.chat.history": { argument: "conversation", completion: "unobservable_current_page_activation_after_command_return" },
  "workbench.action.aichat.sendText": { argument: "message", completion: "current_page_command_returned_delivery_unobserved" }
});
const plain = value => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (status, message) => Object.assign(Error(message), { status });
const canonical = path => (realpathSync.native ?? realpathSync)(resolve(path));
const same = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const contains = (root, child) => {
  const value = relative(root, child);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

function configPath(vscode, env) {
  const setting = vscode.workspace.getConfiguration("qoderIdeBridge").get("configPath", "");
  const path = setting || env.QODER_IDE_BRIDGE_CONFIG || join(homedir(), ".codex-agent-core", "agent-qoder-ide.json");
  if (!isAbsolute(path)) throw Error("Qoder IDE bridge config path must be absolute");
  return resolve(path);
}

function readConfig(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!plain(value) || value.schemaVersion !== 1 || typeof value.token !== "string" ||
      value.token.length < 32 || value.token.length > 512 || typeof value.stateDir !== "string" ||
      value.token === "replace-with-at-least-32-random-characters" ||
      !isAbsolute(value.stateDir) || !Array.isArray(value.allowedCommands) || !value.allowedCommands.length ||
      !value.allowedCommands.every((command, index, all) => Object.hasOwn(commands, command) && all.indexOf(command) === index) ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30000)
    throw Error("Invalid Qoder IDE bridge config");
  return { token: value.token, stateDir: resolve(value.stateDir),
    allowedCommands: [...value.allowedCommands], timeoutMs: value.timeoutMs };
}

function authorized(header, token) {
  const received = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function send(response, status, value) {
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) {
    status = 500;
    text = JSON.stringify({ error: "Bridge response exceeds 64 KiB" });
  }
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text),
    "cache-control": "no-store", connection: "close" });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 32768) { reject(error(413, "Bridge request exceeds 32 KiB")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!plain(value)) throw Error();
        resolveBody(value);
      } catch { reject(error(400, "Invalid JSON request")); }
    });
    request.on("error", reject);
  });
}

function exact(value, keys) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw error(400, `Unknown argument: ${key}`);
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || !value.length || value.length > maxLength) throw error(400, `Invalid ${name}`);
  return value;
}

function boundedResult(value) {
  if (value === undefined) return { resultAvailable: false };
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= 4096) return { resultAvailable: true, result: value };
  return { resultAvailable: true, resultTruncated: true, resultPreview: text.slice(0, 4096) };
}

async function startBridge(vscode, context, options = {}) {
  const env = options.env ?? process.env;
  if (vscode.env.uriScheme !== "qoder-cn") throw Error("Bridge requires Qoder CN IDE (uriScheme=qoder-cn)");
  const config = readConfig(configPath(vscode, env));
  mkdirSync(config.stateDir, { recursive: true });
  const messageOwnerId = ownerIdForStateDir(config.stateDir);
  const instanceId = (options.randomUUID ?? randomUUID)();
  const startedAt = new Date((options.now ?? Date.now)()).toISOString();
  const currentWorkspaces = () => (vscode.workspace.workspaceFolders ?? []).map(folder => canonical(folder.uri.fsPath));
  const startupWorkspaces = currentWorkspaces();
  const seen = new Set();
  const identity = {
    schemaVersion: 1,
    bridgeVersion,
    instanceId,
    pid: options.pid ?? process.pid,
    productId: "qoder-cn-ide",
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    uriScheme: vscode.env.uriScheme,
    vscodeVersion: vscode.version,
    executable: options.executable ?? process.execPath,
    messageOwnerId,
    capabilities: { mutationOwnerBudget: true },
    startedAt,
    workspaces: startupWorkspaces
  };

  function selectedWorkspace(value, workspaces = currentWorkspaces()) {
    if (typeof value !== "string" || !isAbsolute(value)) throw error(400, "An absolute workspace is required");
    const selected = canonical(value);
    if (!workspaces.some(workspace => same(workspace, selected))) throw error(409, "Workspace is not open in this IDE instance");
    return selected;
  }

  async function invoke(body, observeExecution = () => {}) {
    exact(body, ["instanceId", "workspace", "requestId", "command", "targetPath", "sessionId", "sessionType",
      "title", "targetRemoteAuthority", "content", "deliveryId", "correlation", "ownerId", "allocatedBytes"]);
    if (body.instanceId !== instanceId) throw error(409, "IDE instance identity mismatch");
    if (!uuid.test(body.requestId ?? "")) throw error(400, "Invalid requestId");
    const spec = commands[body.command];
    if (!spec || !config.allowedCommands.includes(body.command)) throw error(403, "Command is not enabled");
    if (seen.has(body.requestId)) throw error(409, "requestId already reserved; command was not replayed");
    if (seen.size >= 4096) throw error(503, "Command request reservation capacity reached; restart the bridge before new commands");
    const reservedWorkspace = selectedWorkspace(body.workspace);
    const pageMessage = spec.argument === "message";
    let messageStatus;
    let dispatched = false;
    try {
      if (body.ownerId !== messageOwnerId) throw error(400, "Invalid mutation reservation ownerId");
      if (!pageMessage && ["deliveryId", "correlation"].some(key => body[key] !== undefined))
        throw error(400, "Message reservation fields are only accepted by current-page send");
      claimMutation({ stateDir: config.stateDir, allocatedBytes: body.allocatedBytes, ownerId: body.ownerId,
        requestId: body.requestId, instanceId, workspace: reservedWorkspace, command: body.command });
      if (pageMessage) {
        messageStatus = reserveMessage({ stateDir: config.stateDir, allocatedBytes: body.allocatedBytes,
          requestId: body.requestId, deliveryId: body.deliveryId, instanceId, workspace: reservedWorkspace,
          content: body.content, correlation: body.correlation, ownerId: body.ownerId });
      }
      // Reserve synchronously before the first await so concurrent duplicates cannot both dispatch.
      seen.add(body.requestId);
      const available = await vscode.commands.getCommands(true);
      if (!available.includes(body.command)) throw error(409, "Command is not registered in this IDE instance");
      const workspaces = currentWorkspaces();
      const workspace = selectedWorkspace(body.workspace, workspaces);
      let commandArgs = [];
      if (spec.argument === "target") {
        if (typeof body.targetPath !== "string" || !isAbsolute(body.targetPath)) throw error(400, "An absolute targetPath is required");
        const targetPath = canonical(body.targetPath);
        if (!statSync(targetPath).isDirectory() || !contains(workspace, targetPath))
          throw error(409, "targetPath must be an existing directory inside the selected workspace");
        commandArgs = [vscode.Uri.file(targetPath)];
      } else if (spec.argument === "conversation") {
        if (body.targetPath !== undefined || body.content !== undefined) throw error(400, "Conversation activation accepts only conversation fields");
        if (workspaces.length !== 1) throw error(409, "Conversation activation requires a single-folder IDE workspace");
        const remote = body.targetRemoteAuthority;
        if (remote !== undefined && (typeof remote !== "string" || remote.length > 512)) throw error(400, "Invalid targetRemoteAuthority");
        commandArgs = [requiredString(body.sessionId, "sessionId", 512), requiredString(body.sessionType, "sessionType", 128),
          requiredString(body.title, "title", 1000), remote];
      } else if (spec.argument === "message") {
        if (["targetPath", "sessionId", "sessionType", "title", "targetRemoteAuthority"].some(key => body[key] !== undefined))
          throw error(400, "Current-page send accepts only content");
        if (workspaces.length !== 1) throw error(409, "Current-page send requires a single-folder IDE workspace");
        commandArgs = [{ isNewChat: false, content: wireContent(requiredString(body.content, "content", 16000), body.requestId),
          isSend: true, chatMode: "agent" }];
      } else {
        if (["targetPath", "sessionId", "sessionType", "title", "targetRemoteAuthority", "content"]
            .some(key => body[key] !== undefined)) throw error(400, `${body.command} does not accept arguments`);
        if (workspaces.length !== 1) throw error(409, `${body.command} requires a single-folder IDE workspace`);
      }
      // No await occurs between the live workspace check and the actual command dispatch.
      dispatched = true;
      let execution;
      try { execution = Promise.resolve(vscode.commands.executeCommand(body.command, ...commandArgs)); }
      catch (failure) { execution = Promise.reject(failure); }
      execution.catch(() => {});
      observeExecution(execution);
      let timeout;
      const outcome = await Promise.race([
        execution.then(value => ({ type: "return", value }), failure => ({ type: "failure", failure })),
        new Promise(resolveTimeout => { timeout = setTimeout(() => resolveTimeout({ type: "timeout" }), config.timeoutMs); })
      ]);
      clearTimeout(timeout);
      if (pageMessage) {
        const command = outcome.type === "timeout" ? { state: "unknown_after_timeout" } :
          outcome.type === "failure" ? { state: "failed", error: String(outcome.failure?.message || "Command failed").slice(0, 1000) } :
          { state: "returned_delivery_unobserved" };
        try { messageStatus = recordCommandOutcome(config.stateDir, body.requestId, command); } catch {}
      }
      const messageFields = pageMessage ? { reservation: messageStatus.reservation,
        providerAcceptance: messageStatus.providerAcceptance, deliveryScope: messageStatus.deliveryScope,
        targetPrecision: messageStatus.targetPrecision, reply: messageStatus.reply } : {};
      const base = { requestId: body.requestId, instanceId, workspace, command: body.command, retrySafe: false,
        ...messageFields };
      if (outcome.type === "timeout") return { ...base, state: "unknown", completion: "unknown_after_timeout" };
      if (outcome.type === "failure") return { ...base, state: "failed", completion: "command_failed",
        error: String(outcome.failure?.message || "Command failed").slice(0, 1000) };
      if (pageMessage) return { ...base,
        state: messageStatus.providerAcceptance.state === "accepted" ? "accepted" : "unknown",
        completion: messageStatus.providerAcceptance.state === "accepted" ?
          "provider_input_observed_reply_pending" : "current_page_command_returned_delivery_unobserved" };
      return { ...base, state: spec.completion.startsWith("unobservable") ? "accepted" : "completed",
        completion: spec.completion, ...boundedResult(outcome.value) };
    } catch (failure) {
      if (!dispatched) {
        seen.delete(body.requestId);
        // Retain the file: another process may have replaced this path, so deletion cannot prove ownership.
      }
      throw failure;
    }
  }

  let commandTail = Promise.resolve();
  const serialInvoke = body => {
    if (seen.has(body.requestId)) return Promise.reject(error(409, "requestId already reserved; command was not replayed"));
    const previous = commandTail.catch(() => undefined);
    let releaseLane;
    const lane = new Promise(resolveLane => { releaseLane = resolveLane; });
    commandTail = previous.then(() => lane);
    return previous.then(async () => {
      let executionObserved = false;
      try {
        return await invoke(body, execution => {
          executionObserved = true;
          execution.then(releaseLane, releaseLane);
        });
      } finally {
        if (!executionObserved) releaseLane();
      }
    });
  };

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request.headers.authorization, config.token)) throw error(401, "Unauthorized");
      if (request.method !== "POST") throw error(405, "POST required");
      const body = await readBody(request);
      if (request.url === "/v1/identity") {
        exact(body, ["instanceId", "workspace"]);
        if (body.instanceId !== instanceId) throw error(409, "IDE instance identity mismatch");
        selectedWorkspace(body.workspace);
        const available = await vscode.commands.getCommands(true);
        const workspaces = currentWorkspaces();
        const workspace = selectedWorkspace(body.workspace, workspaces);
        return send(response, 200, { target, identity: { ...identity, workspaces }, workspace, startupStatus: "ready",
          registeredCommands: config.allowedCommands.filter(command => available.includes(command)) });
      }
      if (request.url === "/v1/conversation/status") {
        exact(body, ["instanceId", "workspace", "requestId"]);
        if (body.instanceId !== instanceId) throw error(409, "IDE instance identity mismatch");
        const workspace = selectedWorkspace(body.workspace);
        const status = readMessage(config.stateDir, body.requestId);
        if (status.instanceId !== instanceId || !same(status.workspace, workspace))
          throw error(409, "Page reservation does not belong to this IDE instance/workspace");
        const state = status.reply.state === "observed" ? "reply_observed" :
          status.providerAcceptance.state === "accepted" ? "provider_accepted" : "delivery_unobserved";
        return send(response, 200, { target, ...status, state, readConsumed: false,
          businessAcceptance: "unobserved" });
      }
      if (request.url === "/v1/command") return send(response, 200, await serialInvoke(body));
      throw error(404, "Unknown bridge route");
    } catch (failure) { if (!response.headersSent) send(response, failure.status ?? 500, { error: String(failure.message).slice(0, 1000) }); }
  });
  server.requestTimeout = Math.max(config.timeoutMs + 1000, 5000);
  server.headersTimeout = 5000;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const record = { ...identity, endpoint: `http://127.0.0.1:${address.port}/` };
  const recordPath = join(config.stateDir, `${instanceId}.json`);
  const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, recordPath);
  } catch (failure) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    await new Promise(resolveClose => server.close(resolveClose));
    throw failure;
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await new Promise(resolveClose => server.close(resolveClose));
    try {
      if (existsSync(recordPath) && JSON.parse(readFileSync(recordPath, "utf8")).instanceId === instanceId) unlinkSync(recordPath);
    } catch {}
  };
  context.subscriptions.push({ dispose: () => { void dispose(); } });
  return { record, dispose };
}

let running;
async function activate(context) {
  const vscode = require("vscode");
  try { running = await startBridge(vscode, context); }
  catch (failure) { console.error(`Qoder IDE Command Bridge disabled: ${failure.message}`); }
}

async function deactivate() { await running?.dispose(); running = undefined; }

module.exports = { activate, deactivate, startBridge };
