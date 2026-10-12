import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBinding } from "./configure-binding.mjs";
import { storeOwnerId } from "./store-budget.mjs";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const root = fs.mkdtempSync(join(tmpdir(), "qoder-codex-bridge-"));
const rel = relative(resolve(tmpdir()), resolve(root));
assert(rel.startsWith("qoder-codex-bridge-") && !rel.includes("/") && !rel.includes("\\") && !isAbsolute(rel));
const children = new Set();
const requestId = "11111111-2222-3333-4444-555555555555";
const bound = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const sectionTarget = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const mcpConfig = JSON.parse(fs.readFileSync(join(pluginRoot, "mcp.json"), "utf8")).mcpServers["qoder-codex-bridge"];
assert.equal(mcpConfig.command, "node");
const script = process.env.QODER_MESSAGE_TEST_SERVER ?? mcpConfig.args[0].replace("${QODER_PLUGIN_ROOT}", pluginRoot);
assert(fs.existsSync(script));
const clockModule = join(root, "test-clock.mjs"), clockOffset = join(root, "clock-offset");

function server(dir, overrides = {}) {
  const env = { ...process.env, QODER_PLUGIN_DATA: dir };
  delete env.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION; delete env.CODEX_CHAT_READ_CONFIG;
  const child = spawn(process.execPath, ["--import", pathToFileURL(clockModule).href, script], { windowsHide: true, env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let next = 0;
  const traces = [];
  createInterface({ input: child.stderr }).on("line", line => traces.push(JSON.parse(line)));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response.result ?? response.error); }
  });
  child.on("exit", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("server exited")); } pending.clear(); });
  return {
    traces,
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
  fs.writeFileSync(clockOffset, "0");
  fs.writeFileSync(clockModule, `import { readFileSync } from "node:fs";
const now = Date.now;
Date.now = () => now() + (Number(readFileSync(${JSON.stringify(clockOffset)}, "utf8")) || 0);
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => schedule(fn,
  ms === 60000 && readFileSync(${JSON.stringify(clockOffset)}, "utf8") === "deadline" ? 1500 : ms, ...args);
`);
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
const bound = ${JSON.stringify(bound)}, target = ${JSON.stringify(target)}, sectionTarget = ${JSON.stringify(sectionTarget)};
if (process.argv.includes("--interaction-client-id")) throw Error("unexpected ChatGPT caller flag");
createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  let result;
  const rejectAt = join(root, "reject-host-at");
  if (fs.existsSync(rejectAt) && fs.readFileSync(rejectAt, "utf8") === (msg.method === "initialize" ? "initialize" : msg.params?.name)) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "RAW-HOST-SENTINEL must remain private" } }) + "\\n");
    return;
  }
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
      { id: "chat", kind: "chatgpt", cwd: root, title: "Excluded" }],
      sections: fs.existsSync(join(root, "include-sections")) ? [{ itemKeys: [
        "codex:thread:local:" + bound, "codex:thread:local:" + sectionTarget,
        "codex:thread:local:" + sectionTarget, "chatgpt:conversation:chat", "codex:project:project"
      ] }] : [] };
    }
    else if (name === "read_thread") {
      fs.appendFileSync(join(root, "reads"), args.threadId + "\\n");
      if (args.threadId === sectionTarget && fs.existsSync(join(root, "stall-section"))) return;
      payload = { thread: { id: args.threadId, kind: "codex", cwd: args.threadId === target && fs.existsSync(join(root, "changed")) ? join(root, "other") : root, title: "Task", status: { type: "idle" } }, turns: [] };
      if (args.threadId === target && fs.existsSync(join(root, "change-after-read"))) fs.writeFileSync(join(root, "changed"), "");
    }
    else if (name === "send_message_to_thread") {
      fs.appendFileSync(join(root, "sends"), "1");
      fs.writeFileSync(join(root, "last-prompt"), args.prompt);
      fs.writeFileSync(join(root, "last-send-args"), JSON.stringify(args));
      if (fs.existsSync(join(root, "lost-ack"))) process.exit(1);
      payload = { threadId: args.threadId };
    }
    result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
    const unsupported = await mcp.call("server/discover");
    assert.equal(unsupported.code, -32601);
    assert.equal(unsupported.message, "unknown_method");
    const init = await mcp.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal((await mcp.call("initialize", { protocolVersion: "2025-11-25" })).protocolVersion, "2025-11-25");
    assert.equal((await mcp.call("initialize", { protocolVersion: "UNKNOWN-VERSION-SENTINEL" })).protocolVersion, "2025-11-25");
    const exposed = await mcp.call("tools/list");
    assert.deepEqual(exposed.tools.map(item => item.name), ["list_codex_tasks", "select_codex_task", "send_codex_message", "codex_message_status"]);
    const sendSchema = exposed.tools.find(item => item.name === "send_codex_message").inputSchema.properties;
    assert.equal(sendSchema.model.type, "string");
    assert.equal(sendSchema.model.enum, undefined); // Native schema delegates model availability to the provider.
    assert.deepEqual(sendSchema.thinking.enum, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    const expiredHost = result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} }));
    assert.equal(expiredHost.error, undefined);
    assert.deepEqual(expiredHost.tasks.map(item => item.threadId), [bound, target]);
    fs.writeFileSync(join(root, "host-config.json"), JSON.stringify({ threadId: bound, cwd: root, script: adapter,
      pipePath: "\\\\.\\pipe\\fixture" }));
    const tasks = result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} })).tasks;
    assert.deepEqual(tasks.map(item => item.threadId), [bound, target]);
    fs.writeFileSync(join(root, "include-sections"), "");
    fs.writeFileSync(join(root, "reads"), "");
    const expanded = result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} })).tasks;
    assert.deepEqual(expanded.map(item => item.threadId), [bound, target, sectionTarget]);
    assert.equal(expanded.find(item => item.threadId === sectionTarget).hostId, "local");
    assert.deepEqual(fs.readFileSync(join(root, "reads"), "utf8").trim().split("\n"), [bound, sectionTarget]);
    const sectionPicked = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: sectionTarget } }));
    assert.equal(sectionPicked.threadId, sectionTarget);
    assert(!fs.existsSync(join(root, "sends")));
    fs.writeFileSync(clockOffset, "deadline");
    fs.writeFileSync(join(root, "stall-section"), "");
    const timedOut = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: sectionTarget } }));
    assert.equal(timedOut.error, "host_timeout");
    assert.equal(timedOut.host_stage, "operation");
    assert.equal(timedOut.selectionToken, undefined);
    assert.match(timedOut.call_id, /^[0-9a-f-]{36}$/);
    assert(!fs.existsSync(join(root, "sends")));
    fs.unlinkSync(join(root, "stall-section"));
    fs.writeFileSync(clockOffset, "0");
    fs.unlinkSync(join(root, "include-sections"));
    for (const invalid of [{ pipePath: "invalid" }, { script: join(root, "missing-adapter.mjs") }, { cwd: "" }, { threadId: "" }]) {
      fs.writeFileSync(join(root, "host-config.json"), JSON.stringify({ threadId: bound, cwd: root, script: adapter,
        pipePath: "\\\\.\\pipe\\fixture", ...invalid }));
      assert.equal(result(await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} })).error, "host_unavailable");
    }
    fs.writeFileSync(join(root, "host-config.json"), JSON.stringify({ threadId: bound, cwd: root, script: adapter,
      pipePath: "\\\\.\\pipe\\fixture", expiresAt: "2020-01-01T00:00:00Z" }));
    for (const [rejectAt, hostStage] of [["initialize", "initialize"], ["read_thread", "operator_read"], ["list_threads", "operation"]]) {
      fs.writeFileSync(join(root, "reject-host-at"), rejectAt);
      const rejected = await mcp.call("tools/call", { name: "list_codex_tasks", arguments: {} });
      assert.equal(rejected.isError, true);
      const diagnostic = result(rejected);
      assert.deepEqual({ error: diagnostic.error, error_code: diagnostic.error_code, host_stage: diagnostic.host_stage, host_rpc_code: diagnostic.host_rpc_code },
        { error: "host_request_failed", error_code: "HOST_REQUEST_FAILED", host_stage: hostStage, host_rpc_code: -32602 });
      assert(diagnostic.error_message.includes('do not replay'));
      assert(diagnostic.health_check.includes('chat status'));
      assert.deepEqual(rejected.structuredContent, diagnostic);
      assert(!JSON.stringify(rejected).includes("RAW-HOST-SENTINEL"));
      assert(!fs.existsSync(join(root, "sends")));
    }
    fs.unlinkSync(join(root, "reject-host-at"));
    const bad = await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: "chat" } });
    assert.equal(bad.isError, true);
    const picked = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(clockOffset, String(6 * 60_000));
    const message = "User-authored message, not a lifecycle notice.";
    const sent = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: picked.selectionToken, threadId: target, message } }));
    assert.equal(sent.error, undefined);
    assert.equal(sent.state, "accepted");
    assert.equal(sent.knownStage, "native_ack_persisted", "Persisted native ACK stage must be disclosed");
    assert.equal(sent.reason, "native_host_ack_recorded");
    assert.equal(sent.receiptScope, "local_owner_record");
    assert.equal(sent.retryScope, "request");
    assert.equal(picked.requestId, picked.selectionToken);
    assert.equal(sent.requestId, picked.requestId);
    assert.equal(sent.deliveryId, `codex:${picked.requestId}`);
    assert.equal(sent.ownerId, ownerId);
    assert.equal(sent.acceptance.owner.state, "accepted");
    assert.equal(sent.acceptance.provider.state, "accepted");
    assert.equal(sent.consumer.state, "unknown");
    assert.equal(sent.turnResult.state, "unknown");
    assert.equal(sent.requestedExecution, undefined);
    assert.equal(sent.retrySafe, false);
    assert.equal(picked.expiresInSeconds, undefined);
    assert.equal(fs.readFileSync(join(root, "last-prompt"), "utf8"), message);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "last-send-args"), "utf8")), { threadId: target, prompt: message });
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "1");
    const recordBefore = fs.readFileSync(join(root, `message-${picked.requestId}.json`));
    const acceptedStatus = result(await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: picked.requestId } }));
    assert.equal(acceptedStatus.deliveryId, sent.deliveryId);
    assert.equal(acceptedStatus.state, "accepted");
    assert.equal(acceptedStatus.consumer.state, "unknown");
    assert.equal(acceptedStatus.selectionToken, undefined);
    assert.equal(acceptedStatus.messageSha256, undefined);
    assert.deepEqual(fs.readFileSync(join(root, `message-${picked.requestId}.json`)), recordBefore);
    assert.equal((await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: "../host-config" } })).isError, true);
    const missing = result(await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: requestId } }));
    assert.equal(missing.state, "not_found");
    assert.equal(missing.retrySafe, false);
    assert.equal(missing.knownStage, "unobserved");
    assert.equal(missing.reason, "local_receipt_not_found");
    assert.equal(missing.receiptScope, "local_owner_record");
    assert.equal(missing.retryScope, "request");
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
    const secondStatus = result(await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: concurrent.requestId } }));
    assert.equal(secondStatus.state, "accepted");
    assert.notEqual(secondStatus.deliveryId, sent.deliveryId);
    assert.equal(secondStatus.correlation, concurrent.requestId);
    assert.equal(secondStatus.turnResult.state, "unknown");

    const replyPick = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    const invalidReply = await mcp.call("tools/call", { name: "send_codex_message", arguments: {
      selectionToken: replyPick.selectionToken, threadId: target, message, replyRequested: "true" } });
    assert.equal(invalidReply.isError, true);
    for (const config of [{ model: 42 }, { model: ["gpt-6.1-sol"] }, { thinking: "automatic" }, { thinking: ["high"] }]) {
      const invalidConfig = await mcp.call("tools/call", { name: "send_codex_message", arguments: {
        selectionToken: replyPick.selectionToken, threadId: target, message, ...config } });
      assert.equal(result(invalidConfig).error, "invalid_arguments");
    }
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "11");
    const replySend = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: {
      selectionToken: replyPick.selectionToken, threadId: target, message, replyRequested: true, model: "gpt-6.1-sol", thinking: "high" } }));
    assert.equal(replySend.state, "accepted");
    assert.deepEqual(replySend.requestedExecution, { model: "gpt-6.1-sol", thinking: "high" });
    assert.equal(replySend.actualExecution, undefined);
    assert.equal(replySend.replyRequested, true);
    assert.equal(replySend.turnResult.state, "unknown");
    const replyPrompt = fs.readFileSync(join(root, "last-prompt"), "utf8");
    assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "last-send-args"), "utf8")), {
      threadId: target, prompt: replyPrompt, model: "gpt-6.1-sol", thinking: "high" });
    assert(replyPrompt.startsWith(`[Post-Core requestId:${replyPick.requestId}]\n`));
    assert(replyPrompt.includes(message));
    assert(replyPrompt.includes(`[Post-Core replyTo:${replyPick.requestId}]`));
    assert(replyPrompt.includes("not authorization"));
    const replyRecord = JSON.parse(fs.readFileSync(join(root, `message-${replyPick.requestId}.json`), "utf8"));
    assert.equal(replyRecord.replyRequested, true);
    assert.deepEqual(replyRecord.requestedExecution, { model: "gpt-6.1-sol", thinking: "high" });
    assert.deepEqual(result(await mcp.call("tools/call", { name: "codex_message_status", arguments: {
      requestId: replyPick.requestId } })).requestedExecution, replyRecord.requestedExecution);
    assert.equal(replyRecord.messageSha256, saved.messageSha256);
    assert.match(replyRecord.dispatchedSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(replyRecord.dispatchedSha256, replyRecord.messageSha256);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "111");

    const changed = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, "changed"), "");
    assert.equal((await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: changed.selectionToken, threadId: target, message } })).isError, true);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "111");
    fs.unlinkSync(join(root, "changed"));

    const oversized = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    const beforeOversized = fs.readdirSync(root).filter(name => /^message-/.test(name));
    const tooLarge = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: {
      selectionToken: oversized.selectionToken, threadId: target, message, model: "m".repeat(66_000) } }));
    assert.equal(tooLarge.state, "not_sent");
    assert.equal(tooLarge.reason, "message_record_too_large");
    assert.deepEqual(fs.readdirSync(root).filter(name => /^message-/.test(name)), beforeOversized);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "111");

    const noIntent = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, `message-${noIntent.selectionToken}.json`), "fixture collision", { flag: "wx" });
    const refused = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: noIntent.selectionToken, threadId: target, message } }));
    assert.equal(refused.state, "not_sent");
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "111");
    assert.equal(result(await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: noIntent.requestId } })).error, "message_record_invalid");
    const badRecordId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    for (const badRecord of [null, false, { ...saved, selectionToken: badRecordId, acceptedAt: undefined },
      ...["threadId", "messageSha256", "createdAt", "acceptedAt"].map(field => ({ ...saved, selectionToken: badRecordId, [field]: [saved[field]] })),
      { ...saved, selectionToken: badRecordId, replyRequested: "true" },
      ...[null, [], { model: 42 }, { thinking: "automatic" }, { actualModel: "gpt-6.1-sol" }].map(requestedExecution => ({
        ...saved, selectionToken: badRecordId, requestedExecution })),
      { ...saved, selectionToken: badRecordId, replyRequested: true, dispatchedSha256: ["a".repeat(64)] },
      { ...saved, selectionToken: badRecordId, state: "dispatch_intent", acceptedAt: "UNVALIDATED-RECORD-TEXT" }]) {
      fs.writeFileSync(join(root, `message-${badRecordId}.json`), JSON.stringify(badRecord));
      assert.equal(result(await mcp.call("tools/call", { name: "codex_message_status", arguments: { requestId: badRecordId } })).error, "message_record_invalid");
    }
    fs.unlinkSync(join(root, `message-${badRecordId}.json`));

    const unknown = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    fs.writeFileSync(join(root, "lost-ack"), "");
    const uncertain = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: {
      selectionToken: unknown.selectionToken, threadId: target, message, thinking: "medium" } }));
    assert.equal(uncertain.state, "uncertain");
    assert.equal(uncertain.requestId, unknown.requestId);
    assert.equal(uncertain.acceptance.provider.state, "unknown");
    assert.deepEqual(uncertain.requestedExecution, { thinking: "medium" });
    assert.equal(JSON.parse(fs.readFileSync(join(root, `message-${unknown.selectionToken}.json`), "utf8")).state, "dispatch_intent");
    assert.equal((await mcp.call("tools/call", { name: "send_codex_message", arguments: { selectionToken: unknown.selectionToken, threadId: target, message } })).isError, true);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "1111");
    // Status works after a server restart and while the desktop host is disconnected.
    const offline = server(root);
    fs.writeFileSync(join(root, "reject-host-at"), "initialize");
    try {
      const unknownBefore = fs.readFileSync(join(root, `message-${unknown.requestId}.json`));
      const status = result(await offline.call("tools/call", { name: "codex_message_status", arguments: { requestId: unknown.requestId } }));
      assert.equal(status.state, "uncertain");
      assert.equal(status.acceptance.owner.state, "accepted");
      assert.equal(status.acceptance.provider.state, "unknown");
      assert.deepEqual(status.requestedExecution, { thinking: "medium" });
      assert.equal(status.actualExecution, undefined);
      assert.equal(status.retrySafe, false);
      assert.equal(status.knownStage, "dispatch_intent_persisted");
      assert.equal(status.reason, "native_acceptance_unknown");
      assert.equal(status.receiptScope, "local_owner_record");
      assert.equal(status.retryScope, "request");
      assert.deepEqual(fs.readFileSync(join(root, `message-${unknown.requestId}.json`)), unknownBefore);
      assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "1111");
    } finally { offline.close(); fs.unlinkSync(join(root, "reject-host-at")); }
    fs.unlinkSync(join(root, "lost-ack"));
    const unknownBeforeNewMessage = fs.readFileSync(join(root, `message-${unknown.requestId}.json`));
    const freshMessage = "A separately authorized new message, not a resend of the uncertain request.";
    const freshPick = result(await mcp.call("tools/call", { name: "select_codex_task", arguments: { threadId: target } }));
    const freshSend = result(await mcp.call("tools/call", { name: "send_codex_message", arguments: {
      selectionToken: freshPick.selectionToken, threadId: target, message: freshMessage } }));
    assert.equal(freshSend.state, "accepted");
    assert.notEqual(freshSend.requestId, unknown.requestId);
    assert.equal(freshSend.retryScope, "request");
    assert.equal(fs.readFileSync(join(root, "last-prompt"), "utf8"), freshMessage);
    assert.equal(fs.readFileSync(join(root, "sends"), "utf8"), "11111");
    assert.deepEqual(fs.readFileSync(join(root, `message-${unknown.requestId}.json`)), unknownBeforeNewMessage);
    await mcp.call("ping"); // Prior completion traces precede this response on stderr.
    const traces = mcp.traces.filter(item => item.event === "post_chat_rpc");
    assert(traces.some(item => item.phase === "end" && item.outcome === "protocol_error" && item.error_code === -32601));
    assert(traces.some(item => item.phase === "end" && item.outcome === "tool_error" && item.error_code === "HOST_TIMEOUT"));
    for (const trace of traces.filter(item => item.phase === "end")) {
      assert(Number.isFinite(trace.duration_ms) && trace.duration_ms >= 0);
      assert(traces.some(start => start.phase === "start" && start.call_id === trace.call_id));
    }
    for (const [tool, id, state] of [
      ["select_codex_task", picked.requestId, undefined],
      ["send_codex_message", picked.requestId, "accepted"],
      ["codex_message_status", picked.requestId, "accepted"],
      ["codex_message_status", requestId, "not_found"],
      ["send_codex_message", unknown.requestId, "uncertain"],
      ["send_codex_message", oversized.requestId, "not_sent"]
    ]) {
      const hash = createHash("sha256").update(id).digest("hex");
      const end = traces.find(item => item.tool === tool && item.phase === "end"
        && item.request_id_sha256 === hash && item.message_state === state);
      assert(end, `${tool}/${state ?? "selected"} must be traceable by request digest`);
      const start = traces.find(item => item.phase === "start" && item.call_id === end.call_id);
      assert.equal(start.input_request_id_sha256, tool === "select_codex_task" ? undefined : hash);
    }
    assert(traces.some(item => item.tool === "codex_message_status" && item.phase === "end"
      && item.error_code === "INVALID_ARGUMENTS" && item.input_request_id_sha256 === undefined
      && item.request_id_sha256 === undefined));
    for (const trace of traces) for (const key of ["input_request_id_sha256", "request_id_sha256"])
      if (trace[key] !== undefined) assert.match(trace[key], /^[0-9a-f]{64}$/);
    assert(!JSON.stringify(traces).includes(message));
    assert(!JSON.stringify(traces).includes(root));
    assert(!JSON.stringify(traces).includes("RAW-HOST-SENTINEL"));
    assert(!JSON.stringify(traces).includes("UNKNOWN-VERSION-SENTINEL"));
    assert(!JSON.stringify(traces).includes(picked.selectionToken));
  } finally { mcp.close(); }
  const grantPolicy = join(root, 'grant-read.json'), grantSession = randomUUID(); let grantActive = true, grantChecks = 0, stopAt = Infinity;
  const supervisor = createServer((_request, response) => response.end(JSON.stringify({ sessionId: grantSession, supervisorPid: process.pid, stopping: !grantActive || ++grantChecks >= stopAt })));
  await new Promise(done => supervisor.listen(0, '127.0.0.1', done));
  const initialGrant = { schemaVersion: 2, mode: 'temporary', threadIds: [bound], workspaceRoots: [root], sessionId: grantSession,
    ownerPid: process.pid, ownerUrl: `http://127.0.0.1:${supervisor.address().port}` };
  fs.writeFileSync(grantPolicy, JSON.stringify(initialGrant));
  const grantState = join(root, 'grant-state'), grantConfig = join(root, 'grant-tunnel.json');
  fs.mkdirSync(grantState);
  fs.writeFileSync(join(grantState, 'status.json'), JSON.stringify({ sessionId: grantSession, supervisorPid: process.pid, controlUrl: initialGrant.ownerUrl }));
  fs.writeFileSync(grantConfig, JSON.stringify({ schemaVersion: 1, readPolicy: grantPolicy, stateDir: grantState }));
  const grantEnv = { CODEX_CHAT_READ_CONFIG: grantPolicy, CODEX_CHAT_READ_SESSION: grantSession,
    CODEX_CHAT_TUNNEL_CONFIG: grantConfig,
    CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: JSON.stringify({ schemaVersion: 1, kind: 'privateConnection', principalId: 'explicit-private-tunnel', readSessionId: grantSession }) };
  const privateMcp = server(root, grantEnv), anotherMcp = server(root, grantEnv);
  const select = (mcp, args) => mcp.call('tools/call', { name: 'select_codex_task', arguments: args }).then(result);
  try {
    const unchanged = fs.readFileSync(grantPolicy, 'utf8');
    await select(privateMcp, { threadId: target }); assert.equal(fs.readFileSync(grantPolicy, 'utf8'), unchanged);
    await select(privateMcp, { threadId: target, grantReadAccess: false }); assert.equal(fs.readFileSync(grantPolicy, 'utf8'), unchanged);
    for (const value of ['true', 1, null]) assert.equal((await select(privateMcp, { threadId: target, grantReadAccess: value })).error, 'invalid_arguments');
    const descriptor = (await privateMcp.call('tools/list')).tools.find(tool => tool.name === 'select_codex_task');
    assert.equal(descriptor.annotations.readOnlyHint, false); assert.equal(descriptor.inputSchema.properties.grantReadAccess.type, 'boolean');
    assert.equal((await select(privateMcp, { threadId: 'missing', grantReadAccess: true })).error, 'target_unavailable');
    fs.writeFileSync(join(root, 'changed'), '');
    assert.equal((await select(privateMcp, { threadId: target, grantReadAccess: true })).error, 'target_unavailable'); fs.unlinkSync(join(root, 'changed'));
    fs.writeFileSync(join(root, 'change-after-read'), '');
    assert.equal((await select(privateMcp, { threadId: target, grantReadAccess: true })).error, 'target_changed');
    fs.unlinkSync(join(root, 'change-after-read')); fs.unlinkSync(join(root, 'changed'));
    const noDelegation = server(root, { CODEX_CHAT_READ_CONFIG: grantPolicy, CODEX_CHAT_READ_SESSION: grantSession });
    try { assert.equal((await select(noDelegation, { threadId: target, grantReadAccess: true })).error, 'read_not_authorized'); } finally { noDelegation.close(); }
    grantActive = false; assert.equal((await select(privateMcp, { threadId: target, grantReadAccess: true })).error, 'read_not_authorized'); grantActive = true;
    grantChecks = 0; stopAt = 3;
    assert.equal((await select(privateMcp, { threadId: target, grantReadAccess: true })).error, 'read_not_authorized'); stopAt = Infinity;
    assert.equal(fs.readFileSync(grantPolicy, 'utf8'), unchanged);
    fs.writeFileSync(join(root, 'include-sections'), '');
    const granted = await Promise.all([select(privateMcp, { threadId: target, grantReadAccess: true }), select(privateMcp, { threadId: sectionTarget, grantReadAccess: true })]);
    assert(granted.every(item => item.readAccess?.mode === 'temporary' && item.readAccess.sessionId === grantSession));
    assert.deepEqual(new Set(JSON.parse(fs.readFileSync(grantPolicy)).threadIds), new Set([bound, target, sectionTarget]));
    assert.deepEqual(JSON.parse(fs.readFileSync(grantPolicy)).workspaceRoots, initialGrant.workspaceRoots);
    // Separate stdio children contend on the same policy lock too.
    fs.writeFileSync(grantPolicy, unchanged);
    const parallel = await Promise.all([select(privateMcp, { threadId: target, grantReadAccess: true }), select(anotherMcp, { threadId: sectionTarget, grantReadAccess: true })]);
    assert(parallel.every(item => item.readAccess?.mode === 'temporary'));
    assert.deepEqual(new Set(JSON.parse(fs.readFileSync(grantPolicy)).threadIds), new Set([bound, target, sectionTarget]));
    const defaultMcp = server(root);
    try {
      for (const selectionMcp of [defaultMcp, privateMcp]) {
        const send = (picked, overrides = {}) => selectionMcp.call('tools/call', { name: 'send_codex_message', arguments: {
          selectionToken: picked.selectionToken, threadId: picked.threadId, message: 'Selection isolation fixture.', ...overrides } }).then(result);
        const sendCount = () => fs.readFileSync(join(root, 'sends'), 'utf8').length;
        const before = sendCount();
        const a = await select(selectionMcp, { threadId: bound }), b = await select(selectionMcp, { threadId: target });
        assert.equal((await send(a, { threadId: target })).error, 'selection_missing_or_mismatched');
        assert.equal((await send(a, { selectionToken: randomUUID() })).error, 'selection_missing_or_mismatched');
        assert.equal((await send(b, { message: ' ' })).error, 'invalid_arguments');
        assert.equal(sendCount(), before, 'Rejected sends must never reach the native host');
        for (const picked of [a, b]) assert(!fs.existsSync(join(root, `message-${picked.requestId}.json`)));
        if (selectionMcp === privateMcp) {
          for (const threadId of [bound, target]) {
            const read = result(await selectionMcp.call('tools/call', { name: 'read_codex', arguments: { kind: 'thread', threadId } }));
            assert.equal(read.error, undefined); assert.equal(read.thread.threadId, threadId);
          }
        }
        assert.equal((await send(b)).state, 'accepted', 'Rejected send A must preserve selected B');
        assert.equal((await send(a)).state, 'accepted', 'Sending B must preserve selected A');
        assert.equal(sendCount(), before + 2);
        const [sameFirst, sameSecond] = await Promise.all([
          select(selectionMcp, { threadId: target }), select(selectionMcp, { threadId: target })]);
        assert.notEqual(sameFirst.selectionToken, sameSecond.selectionToken);
        assert.equal((await send(a)).error, 'selection_missing_or_mismatched');
        assert.equal(sendCount(), before + 2, 'Consumed token reuse must never dispatch again');
        assert.equal((await send(sameFirst)).state, 'accepted');
        assert.equal((await send(sameSecond)).state, 'accepted', 'Selecting the same target must retain both tokens');
        assert.equal(sendCount(), before + 4);
        await selectionMcp.call('ping');
        const traces = JSON.stringify(selectionMcp.traces);
        for (const picked of [a, b, sameFirst, sameSecond]) assert(!traces.includes(picked.selectionToken));
        assert(!traces.includes('Selection isolation fixture.'));
        if (selectionMcp === defaultMcp) {
          const pending = [];
          for (let index = 0; index < 255; index++) {
            const picked = await select(selectionMcp, { threadId: target });
            assert.equal(picked.error, undefined); pending.push(picked);
          }
          const boundary = await Promise.all([
            select(selectionMcp, { threadId: target }), select(selectionMcp, { threadId: target })]);
          assert.equal(boundary.filter(picked => picked.error === 'selection_capacity_reached').length, 1);
          const admitted = boundary.find(picked => picked.selectionToken);
          assert(admitted);
          assert.equal((await select(selectionMcp, { threadId: target })).error, 'selection_capacity_reached');
          assert.equal(sendCount(), before + 4);
          assert.equal((await send(pending[0])).state, 'accepted', 'Full capacity must retain the oldest selection');
          assert.equal((await send(admitted)).state, 'accepted', 'Capacity rejection must preserve the admitted selection');
          assert.equal((await select(selectionMcp, { threadId: target })).error, undefined, 'Consuming a selection must free capacity');
        }
      }
    } finally { defaultMcp.close(); }
  } finally { privateMcp.close(); anotherMcp.close(); await new Promise(done => supervisor.close(done)); }
  console.log("message bridge: no host/selection expiry, isolated multi-selection consumption, read preservation, delayed single-use send, invalid connection rejection, lifecycle isolation, changed target, no-intent no-send and unknown no-replay passed");
} finally {
  for (const child of children) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
