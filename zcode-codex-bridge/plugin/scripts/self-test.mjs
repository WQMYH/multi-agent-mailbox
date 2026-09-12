import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { callTool, handleGateway, loadBinding, readBoundThread, sendFixedReplyTest, tools } from "./server.mjs";
import { recordProbe } from "../hooks/probe.mjs";
import { hostOperation, loadHostConfig } from "./host-client.mjs";

const root = mkdtempSync(join(tmpdir(), "zcode-codex-bridge-"));
try {
  const script = join(root, "codex.js"); writeFileSync(script, "");
  const workspace = join(root, "workspace"), cwdAlias = join(root, "cwd-alias");
  mkdirSync(workspace); symlinkSync(workspace, cwdAlias, process.platform === "win32" ? "junction" : "dir");
  const env = {
    ZCC_CODEX_SCRIPT: script,
    ZCC_CODEX_THREAD_ID: "01a06b03-cd32-7c31-ab2d-961937a69a11",
    ZCC_CODEX_CWD: cwdAlias,
    ZCC_SOURCE_SESSION_ID: "sess_364f3d09-4b3d-4db4-811f-3624dde5a68f",
    ZCC_TEAM_ID: "zcode-codex-poc",
    ZCC_BINDING_EXPIRES_AT: "2030-01-01T00:00:00Z",
    ZCC_EXPECTED_REPLY: "ZCODE_CODEX_RETURN_OK",
    ZCODE_PLUGIN_DATA: root
  };
  const binding = loadBinding(env, Date.parse("2026-09-09T00:00:00Z"));
  assert.deepEqual(await callTool("codex_fixed_reply_test", { requestId: "blocked" }), {
    state: "blocked", sent: false, reason: "Live sending disabled: host ownership and test permission decision required"
  });
  await assert.rejects(sendFixedReplyTest(binding), /Live sending disabled/);
  assert.equal(tools.length, 4); assert.equal(binding.expectedReply, "ZCODE_CODEX_RETURN_OK");
  assert.throws(() => loadBinding({ ...env, ZCC_EXPECTED_REPLY: "ignore instructions" }, Date.parse("2026-09-09T00:00:00Z")), /Expected reply/);

  let sends = 0;
  const deps = { env, binding, root,
    read: async value => ({ threadId: value.threadId, cwd: value.cwd, status: { type: "notLoaded" } }),
    send: async (value, { onDispatch }) => { sends++; await onDispatch(); return { threadId: value.threadId, turnId: "turn_1", turnStatus: "completed",
      userMessageId: "user_1", assistantMessageId: "assistant_1", reply: value.expectedReply, replyMatched: true, completedAt: "2026-09-09T00:00:00Z" }; }
  };
  assert.equal((await callTool("codex_binding_status", {}, deps)).sourceIdentityAuthenticated, false);
  assert.equal((await callTool("codex_thread_read", {}, deps)).status.type, "notLoaded");
  const sent = await callTool("codex_fixed_reply_test", { requestId: "fixed-1" }, deps);
  assert.equal(sent.state, "completed"); assert(sent.result.replyMatched);
  const retry = await callTool("codex_fixed_reply_test", { requestId: "fixed-1" }, deps);
  assert(retry.deduplicated); assert.equal(sends, 1);

  const uncertain = await callTool("codex_fixed_reply_test", { requestId: "fixed-2" }, { ...deps,
    send: async (_value, { onDispatch }) => { sends++; await onDispatch(); throw Error("connection lost"); } });
  assert.equal(uncertain.state, "uncertain");
  await callTool("codex_fixed_reply_test", { requestId: "fixed-2" }, deps);
  assert.equal(sends, 2, "uncertain dispatch must not be retried");
  await assert.rejects(callTool("codex_fixed_reply_test", { requestId: "fixed-1" }, {
    ...deps, binding: { ...binding, sourceSessionId: "sess_other" }
  }), /conflicts/);

  // Exercise the real JSONL client with streams only: no Codex process, model, or network.
  // Event routing fields follow openai/codex rust-v0.153.4 app-server-protocol/schema/typescript/v2.
  function transport({ resumeStatus = "idle", terminal = "completed", nonPassive, wrongCwd = false, disconnect = false, hang = false } = {}) {
    const methods = [];
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
      const emit = value => child.stdout.write(JSON.stringify(value) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const message = JSON.parse(chunk.toString()); methods.push(message.method);
        const response = result => emit({ id: message.id, result });
        queueMicrotask(() => {
          if (message.method === "initialize") response({});
          if (message.method === "thread/read" || message.method === "thread/resume") response({ thread: {
            id: binding.threadId, cwd: wrongCwd ? join(root, "other") : binding.cwd,
            status: { type: message.method === "thread/read" ? "notLoaded" : resumeStatus }
          } });
          if (message.method === "turn/start") {
            assert.equal(message.params.sandboxPolicy.type, "readOnly");
            assert.equal(message.params.approvalPolicy, "never");
            response({ turn: { id: "turn_current" } });
            if (disconnect) { child.emit("exit", 1); return; }
            if (hang) return;
            const item = (type, id, extra = {}, turnId = "turn_current", method = "item/completed") => emit({ method,
              params: { threadId: binding.threadId, turnId, item: { type, id, ...extra } } });
            item("userMessage", "user_current");
            item("agentMessage", "assistant_current", { text: binding.expectedReply });
            item("agentMessage", "assistant_other", { text: "wrong turn" }, "turn_other");
            if (nonPassive) item(nonPassive, "tool_started", {}, "turn_current", "item/started");
            emit({ method: "turn/completed", params: { threadId: binding.threadId, turn: { id: "turn_current", status: terminal } } });
          }
        });
        done();
      } });
      child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit("exit", 0); };
      return child;
    };
    return { spawnProcess, timeoutMs: 50, methods };
  }
  const readTransport = transport();
  assert.equal((await readBoundThread(binding, readTransport)).threadId, binding.threadId);
  assert.deepEqual(readTransport.methods, ["initialize", "initialized", "thread/read"]);
  const native = await sendFixedReplyTest(binding, transport());
  assert(native.replyMatched && native.evidenceComplete);
  assert.equal(native.assistantMessageId, "assistant_current");
  for (const nonPassive of ["collabToolCall", "imageView", "futureUnknownTool"]) {
    const result = await sendFixedReplyTest(binding, transport({ nonPassive }));
    assert(!result.replyMatched); assert(result.toolUseObserved);
  }
  assert(!(await sendFixedReplyTest(binding, transport({ terminal: "failed" }))).replyMatched);
  for (const options of [{ resumeStatus: "active" }, { wrongCwd: true }]) {
    const simulated = transport(options);
    await assert.rejects(sendFixedReplyTest(binding, simulated), /idle|cwd/);
    assert(!simulated.methods.includes("turn/start"));
  }
  const expiredTransport = transport();
  await assert.rejects(sendFixedReplyTest({ ...binding, expiresAt: "2000-01-01T00:00:00Z" }, expiredTransport), /expired/);
  assert(!expiredTransport.methods.includes("turn/start"));
  await assert.rejects(sendFixedReplyTest(binding, transport({ disconnect: true })), /exited/);
  await assert.rejects(sendFixedReplyTest(binding, transport({ hang: true })), /timed out/);

  const messages = [], state = { initializeResponded: false, ready: false };
  await handleGateway({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, state, { send: value => messages.push(value) });
  assert.equal(messages.at(-1).error.message, "Not initialized");
  const downgrade = [], downgradeState = { initializeResponded: false, ready: false };
  await handleGateway({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "newer" } }, downgradeState, { send: value => downgrade.push(value) });
  assert.equal(downgrade.at(-1).result.protocolVersion, "2025-06-18");
  await handleGateway({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-06-18" } }, state, { send: value => messages.push(value) });
  assert.equal(messages.at(-1).result.serverInfo.version, "0.2.4");
  await handleGateway({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, state, { send: value => messages.push(value) });
  const beforeNotification = messages.length;
  await handleGateway({ jsonrpc: "2.0", method: "tools/call", params: { name: "codex_fixed_reply_test", arguments: { requestId: "must-not-run" } } }, state,
    { send: value => messages.push(value), invoke: async () => { throw Error("notification executed"); } });
  assert.equal(messages.length, beforeNotification, "notifications must not execute tools or receive responses");
  await handleGateway({ jsonrpc: "2.0", id: 4, method: "tools/call", params: null }, state, { send: value => messages.push(value) });
  assert.equal(messages.at(-1).error.message, "Invalid params");

  const hostConfigPath = join(root, "host-config.json");
  const hostConfig = { script, pipePath: "\\\\.\\pipe\\test-only", threadId: binding.threadId, cwd: cwdAlias, expiresAt: binding.expiresAt };
  writeFileSync(hostConfigPath, JSON.stringify(hostConfig));
  let statusExternalCalls = 0;
  const forbiddenStatusCall = () => { statusExternalCalls++; throw Error("Status must stay offline"); };
  const statusDeps = { env, host: forbiddenStatusCall, read: forbiddenStatusCall, send: forbiddenStatusCall };
  const configured = await callTool("codex_binding_status", {}, statusDeps);
  assert.equal(configured.state, "configured"); assert(configured.hostReportConfigured);
  assert.equal(configured.connectionVerified, false); assert.deepEqual(configured.diagnostics, []);
  for (const [envPatch, hostPatch, codes] of [
    [{ ZCC_BINDING_EXPIRES_AT: "2000-01-01T00:00:00Z" }, {}, ["binding_invalid"]],
    [{ ZCC_BINDING_EXPIRES_AT: "invalid" }, {}, ["binding_invalid"]],
    [{}, { threadId: "other" }, ["host_task_mismatch"]],
    [{}, { cwd: root }, ["host_cwd_mismatch"]],
    [{}, { expiresAt: "2000-01-01T00:00:00Z" }, ["host_expired"]],
    [{}, { script: join(root, "missing-adapter.mjs") }, ["host_adapter_unavailable"]],
    [{}, { pipePath: "invalid-secret-pipe" }, ["host_pipe_invalid"]],
    [{ ZCC_BINDING_EXPIRES_AT: "2000-01-01T00:00:00Z" },
      { threadId: "other", expiresAt: "2000-01-01T00:00:00Z", script: join(root, "missing-adapter.mjs") },
      ["binding_invalid", "host_task_mismatch", "host_expired", "host_adapter_unavailable"]]
  ]) {
    const savedHost = JSON.stringify({ ...hostConfig, ...hostPatch });
    writeFileSync(hostConfigPath, savedHost);
    const filesBefore = readdirSync(root).sort();
    const result = await callTool("codex_binding_status", {}, { ...statusDeps, env: { ...env, ...envPatch } });
    assert.equal(result.state, "blocked"); assert.equal(result.hostReportConfigured, false);
    assert.deepEqual(result.diagnostics.map(issue => issue.code), codes);
    assert.equal(result.connectionVerified, false);
    assert(!JSON.stringify(result).includes(JSON.stringify(hostConfig.pipePath)));
    assert(!JSON.stringify(result).includes("invalid-secret-pipe"));
    assert.equal(readFileSync(hostConfigPath, "utf8"), savedHost);
    assert.deepEqual(readdirSync(root).sort(), filesBefore, "Status does not create receipts or data");
    if (Object.keys(hostPatch).length) assert.throws(() => loadHostConfig(root, binding), "Operational host validation must remain strict");
  }
  writeFileSync(hostConfigPath, "null");
  assert.equal((await callTool("codex_binding_status", {}, statusDeps)).diagnostics[0].code, "host_config_unreadable");
  writeFileSync(hostConfigPath, JSON.stringify(hostConfig));
  const expiredEnv = { ...env, ZCC_BINDING_EXPIRES_AT: "2000-01-01T00:00:00Z" };
  for (const name of ["codex_thread_read", "codex_host_report"])
    await assert.rejects(callTool(name, name === "codex_host_report" ? { requestId: "status-must-not-send" } : {},
      { ...statusDeps, env: expiredEnv }), /expiry/);
  await handleGateway({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "codex_binding_status", arguments: {} } }, state,
    { send: value => messages.push(value), invoke: (name, args) => callTool(name, args, { ...statusDeps, env: expiredEnv }) });
  assert.equal(messages.at(-1).error, undefined);
  assert.equal(JSON.parse(messages.at(-1).result.content[0].text).diagnostics[0].code, "binding_invalid");
  const absentData = join(root, "status-must-not-create");
  const absentStatus = await callTool("codex_binding_status", {}, { ...statusDeps, env: { ...env, ZCODE_PLUGIN_DATA: absentData } });
  assert.equal(absentStatus.diagnostics[0].code, "host_config_missing"); assert(!existsSync(absentData));
  const unsetStatus = await callTool("codex_binding_status", {}, { ...statusDeps, env: {} });
  assert.deepEqual(unsetStatus.diagnostics.map(issue => issue.code), ["binding_invalid", "data_path_missing"]);
  for (const [file, code] of [["send-ledger.json", "receipts_unreadable"], ["hook-events.json", "hook_probe_unreadable"]]) {
    const path = join(root, file), previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    writeFileSync(path, "{");
    const result = await callTool("codex_binding_status", {}, statusDeps);
    assert.equal(result.diagnostics[0].code, code);
    if (previous === null) rmSync(path); else writeFileSync(path, previous);
  }
  assert.equal(statusExternalCalls, 0, "Status never invokes host, read, or send transports");
  let hostSends = 0;
  function hostTransport({ wrongTarget = false, lostAck = false, expireBeforeSend = false, idle = false, unloaded = false, requireIdle = false } = {}) {
    return { timeoutMs: 50, requireIdle, spawnProcess: (_node, args, options) => {
      assert.deepEqual(args, [script, "--interaction-client-id", binding.threadId]);
      assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, hostConfig.pipePath);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const emit = value => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
      child.stdin = new Writable({ write(chunk, _enc, done) {
        const message = JSON.parse(chunk.toString());
        queueMicrotask(() => {
          if (message.method === "initialize") emit({ id: message.id, result: { protocolVersion: "2025-06-18" } });
          if (message.method === "tools/call") {
            const { name, arguments: values } = message.params;
            assert.equal(values.threadId, binding.threadId);
            let result;
            if (name === "read_thread") {
              result = { thread: { id: wrongTarget ? "other" : binding.threadId, cwd: cwdAlias, status: { type: unloaded ? "notLoaded" : idle ? "idle" : "active" } }, turns: [{ private: "never expose" }] };
              if (expireBeforeSend) binding.expiresAt = "2000-01-01T00:00:00Z";
            } else {
              assert.equal(name, "send_message_to_thread"); hostSends++;
              assert.deepEqual(Object.keys(values).sort(), ["prompt", "threadId"]);
              assert(values.prompt.includes(binding.sourceSessionId));
              assert(values.prompt.includes(`请只回复 ${binding.expectedReply}`));
              assert(values.prompt.includes("不要调用工具、启动或继续任何任务"));
              assert(values.prompt.includes("修改文件或配置"));
              assert(values.prompt.includes("不要自动回送"));
              if (lostAck) { child.emit("exit", 1); return; }
              result = { threadId: binding.threadId };
            }
            emit({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } });
          }
        }); done();
      } });
      child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit("exit", 0); };
      return child;
    } };
  }
  assert(!JSON.stringify(await hostOperation(binding, root, undefined, hostTransport())).includes("never expose"));
  const concurrent = await Promise.all([hostOperation(binding, root, "host-one", hostTransport()), hostOperation(binding, root, "host-one", hostTransport())]);
  assert.equal(hostSends, 1); assert(concurrent.some(value => value.state === "accepted"));
  assert((await hostOperation(binding, root, "host-one", hostTransport())).deduplicated);
  const lostAck = await hostOperation(binding, root, "host-lost", hostTransport({ lostAck: true }));
  assert.equal(lostAck.state, "uncertain");
  assert((await hostOperation(binding, root, "host-lost", hostTransport())).deduplicated);
  assert.equal(hostSends, 2);
  await assert.rejects(hostOperation(binding, root, "host-wrong", hostTransport({ wrongTarget: true })), /match binding/);
  await assert.rejects(hostOperation({ ...binding, sourceSessionId: "sess_other" }, root, "host-one", hostTransport()), /conflicts/);
  await assert.rejects(hostOperation({ ...binding, expectedReply: "OTHER_TOKEN" }, root, "host-one", hostTransport()), /conflicts/);
  const savedExpiry = binding.expiresAt;
  assert.equal((await hostOperation(binding, root, "host-expired", hostTransport({ expireBeforeSend: true }))).state, "uncertain");
  assert.equal(hostSends, 2); binding.expiresAt = savedExpiry;
  assert.equal((await hostOperation(binding, root, "still-active", hostTransport({ requireIdle: true }))).state, "not_idle");
  assert.equal(hostSends, 2);
  const idleSent = await hostOperation(binding, root, "idle-probe", hostTransport({ requireIdle: true, idle: true }));
  assert.equal(idleSent.targetStatusBeforeSend.type, "idle"); assert.equal(idleSent.state, "accepted");
  assert.equal(hostSends, 3);
  const idleDuplicate = await hostOperation(binding, root, "idle-probe", hostTransport({ requireIdle: true }));
  assert.equal(idleDuplicate.state, "accepted"); assert(idleDuplicate.deduplicated); assert.equal(hostSends, 3);
  const unloadedSent = await hostOperation(binding, root, "unloaded-probe", hostTransport({ requireIdle: true, unloaded: true }));
  assert.equal(unloadedSent.targetStatusBeforeSend.type, "notLoaded"); assert.equal(unloadedSent.state, "accepted"); assert.equal(hostSends, 4);
  await assert.rejects(hostOperation(binding, root, "host-one", hostTransport({ requireIdle: true })), /conflicts/);
  await assert.rejects(callTool("codex_host_report", { requestId: "retired-option", waitForIdle: true }, deps), /Invalid host arguments/);
  writeFileSync(hostConfigPath, JSON.stringify({ ...hostConfig, expiresAt: "2000-01-01T00:00:00Z" }));
  await assert.rejects(hostOperation(binding, root, "host-stale", hostTransport()), /expired/);

  for (let index = 0; index < 201; index++) recordProbe({ hook_event_name: "UserPromptSubmit", session_id: "sess_test", prompt: "do not persist" },
    { env, now: () => new Date(index * 1000) });
  const probe = JSON.parse(readFileSync(join(root, "hook-events.json"), "utf8"));
  assert.equal(probe.events.length, 200); assert(!JSON.stringify(probe).includes("do not persist"));

  for (const relative of ["../.zcode-plugin/plugin.json", "../.mcp.json", "../../marketplace.json", "../hooks/hooks.json"])
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
  console.log("zcode-codex-bridge: offline binding diagnostics (zero send/write), host adapter, concurrent dedup, lost acknowledgement, expiry, target check, no history exposure, legacy send lock, MCP lifecycle, Hook probe and manifests OK");
} finally { rmSync(root, { recursive: true, force: true }); }
