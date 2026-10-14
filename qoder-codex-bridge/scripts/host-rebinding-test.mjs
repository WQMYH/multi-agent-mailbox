import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import * as host from "./host-notifier.mjs";

const root = fs.mkdtempSync(join(tmpdir(), "codex-host-rebinding-"));
const oldPipe = "\\\\.\\pipe\\codex-browser-use-11111111-1111-1111-1111-111111111111";
const newPipe = "\\\\.\\pipe\\codex-browser-use-22222222-2222-2222-2222-222222222222";
const operator = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function fixture(label) {
  const dir = join(root, label); fs.mkdirSync(dir);
  const script = join(dir, "server.mjs"); fs.writeFileSync(script, "");
  const config = { script, pipePath: oldPipe, threadId: operator, cwd: dir, preserved: "operator-setting" };
  const path = join(dir, "host-config.json"); fs.writeFileSync(path, JSON.stringify(config));
  return { dir, path, config, raw: fs.readFileSync(path, "utf8") };
}
function transport(config, { oldActive = false, wrongOld = false, wrongNew = false, disconnectedNew = false, disconnectSend = false, beforeNewRead } = {}) {
  const launches = [], calls = [], children = [];
  function spawnProcess(_exe, args, options) {
    assert.deepEqual(args, [config.script]);
    const pipe = options.env.CODEX_APP_TOOLS_PIPE_PATH; launches.push(pipe);
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const emit = message => child.stdout.write(JSON.stringify(message) + "\n");
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const message = JSON.parse(bytes); done();
      queueMicrotask(() => {
        if (message.id === undefined) return;
        if (message.method === "initialize") return emit({ id: message.id, result: { protocolVersion: "2025-06-18" } });
        assert.equal(message.params._meta.codexThreadId, operator);
        calls.push({ pipe, name: message.params.name });
        if ((pipe === oldPipe && !oldActive && !wrongOld) || (pipe === newPipe && disconnectedNew))
          return emit({ id: message.id, error: { code: -32603, message: "private-pipe-error" } });
        if (message.params.name === "send_message_to_thread" && disconnectSend) return child.emit("exit", 1);
        if (pipe === newPipe) beforeNewRead?.();
        const wrong = pipe === oldPipe ? wrongOld : wrongNew;
        const payload = message.params.name === "read_thread"
          ? { thread: { id: wrong ? "wrong-operator" : operator, cwd: wrong ? root : config.cwd } }
          : { threadId: message.params.arguments.threadId };
        emit({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
      });
    } });
    child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit("exit", 0); };
    return child;
  }
  return { spawnProcess, timeoutMs: 50, launches, calls, children };
}
// Before the new entrypoint exists, exercise the actual old initialize/operator-read flow.
const connect = host.connectVerifiedHost ?? (async (dataDir, options) => {
  const config = host.loadHostConfig(dataDir), client = new host.HostClient(config, options);
  try { await client.initialize(); await host.hostRead(client, { targetTaskId: config.threadId, targetCwd: config.cwd });
    return { client, config, rebound: false }; }
  catch (error) { client.close(); throw error; }
});
const proof = { serverPid: 123, startedAt: "verified-process-start" };
try {
  if (process.argv.includes("--module-path-child")) {
    const moduleFixture = fixture("module-path"), moduleIO = transport(moduleFixture.config);
    const originalExecFile = childProcess.execFile, inherited = process.env.PSModulePath;
    const probe = `$ErrorActionPreference='Stop'; $null=Get-AuthenticodeSignature -LiteralPath $env:QODER_MODULE_TEST_FILE; '${JSON.stringify(proof)}'`;
    let probes = 0;
    const intercepted = (...args) => originalExecFile(...args);
    intercepted[promisify.custom] = (executable, _args, options) => {
      assert(executable.toLowerCase().endsWith("windowspowershell\\v1.0\\powershell.exe")); probes++;
      // Keep the real production child environment; replace only OS discovery with a real module-loading probe.
      return promisify(originalExecFile)(executable, ["-NoProfile", "-NonInteractive", "-Command", probe],
        { ...options, env: { ...options.env, QODER_MODULE_TEST_FILE: moduleFixture.config.script } });
    };
    childProcess.execFile = intercepted; syncBuiltinESMExports();
    try {
      const ready = await connect(moduleFixture.dir, { ...moduleIO, preferredPipePath: newPipe });
      assert.equal(ready.rebound, true); assert.equal(probes, 2); assert.equal(process.env.PSModulePath, inherited); ready.client.close();
    } finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); }
    console.log("WindowsPowerShell module-path child passed");
  } else {
  const stale = fixture("stale"), staleIO = transport(stale.config), inspected = [];
  const rebound = await connect(stale.dir, { ...staleIO, preferredPipePath: newPipe,
    inspectPipe: async pipe => { inspected.push(pipe); return proof; } });
  assert.equal(rebound.rebound, true);
  assert.deepEqual(rebound.config, { ...stale.config, pipePath: newPipe });
  assert.deepEqual(JSON.parse(fs.readFileSync(stale.path, "utf8")), rebound.config);
  assert.deepEqual(staleIO.launches, [oldPipe, newPipe]);
  assert(inspected.length >= 1 && inspected.every(pipe => pipe === newPipe)); rebound.client.close();

  const live = fixture("live"), liveIO = transport(live.config, { oldActive: true });
  const existing = await connect(live.dir, { ...liveIO, inspectPipe: async () => { throw Error("discovery must not run for a valid configured host"); } });
  assert.equal(existing.rebound, false); assert.equal(fs.readFileSync(live.path, "utf8"), live.raw); existing.client.close();
  const unavailable = fixture("no-formal-binding"), unavailableIO = transport(unavailable.config);
  await assert.rejects(connect(unavailable.dir, { ...unavailableIO }), error => error.code === "host_request_failed"
    && error.hostRpcCode === -32603 && error.hostStage === "operator_read" && error.bindingStatus === "unavailable");
  assert.equal(unavailableIO.launches.length, 1); assert.equal(fs.readFileSync(unavailable.path, "utf8"), unavailable.raw);

  for (const [label, settings, expected] of [["wrong-old", { wrongOld: true }, "host_identity_mismatch"],
    ["wrong-new", { wrongNew: true }, "host_identity_mismatch"], ["unreachable", { disconnectedNew: true }, "host_request_failed"]]) {
    const candidate = fixture(label), io = transport(candidate.config, settings);
    await assert.rejects(connect(candidate.dir, { ...io, preferredPipePath: newPipe, inspectPipe: async () => proof }), error => error.code === expected);
    assert.equal(fs.readFileSync(candidate.path, "utf8"), candidate.raw);
    assert.equal(io.launches.length, label === "wrong-old" ? 1 : 2);
    assert(io.children.every(child => child.killed));
  }
  const untrusted = fixture("untrusted"), untrustedIO = transport(untrusted.config);
  await assert.rejects(connect(untrusted.dir, { ...untrustedIO, preferredPipePath: newPipe,
    inspectPipe: async () => { throw Object.assign(Error("untrusted"), { code: "host_binding_untrusted" }); } }), error => error.code === "host_binding_untrusted");
  assert.equal(fs.readFileSync(untrusted.path, "utf8"), untrusted.raw); assert.equal(untrustedIO.launches.length, 1);

  const invalid = fixture("invalid-preferred"), invalidIO = transport(invalid.config);
  await assert.rejects(connect(invalid.dir, { ...invalidIO, preferredPipePath: "\\\\.\\pipe\\arbitrary", inspectPipe: async () => proof }), error => error.code === "host_binding_invalid");
  assert.equal(fs.readFileSync(invalid.path, "utf8"), invalid.raw);

  const changed = fixture("concurrent-operator"), newConfig = { ...changed.config, threadId: "new-authorized-operator" };
  const changedIO = transport(changed.config, { beforeNewRead: () => fs.writeFileSync(changed.path, JSON.stringify(newConfig)) });
  await assert.rejects(connect(changed.dir, { ...changedIO, preferredPipePath: newPipe, inspectPipe: async () => proof }), error => error.code === "host_config_changed");
  assert.deepEqual(JSON.parse(fs.readFileSync(changed.path, "utf8")), newConfig);

  const manifest = fixture("manifest"), manifestIO = transport(manifest.config), manifestProofs = [];
  fs.writeFileSync(join(manifest.dir, ".mcp.json"), JSON.stringify({ mcpServers: { codex_app: { cwd: manifest.dir,
    args: ["./server.mjs"], env: { CODEX_APP_TOOLS_PIPE_PATH: newPipe } } } }));
  const discovered = await connect(manifest.dir, { ...manifestIO, inspectPipe: async pipe => { manifestProofs.push(pipe); return proof; } });
  assert.equal(discovered.rebound, true); assert(manifestProofs.every(pipe => pipe === newPipe)); discovered.client.close();

  const ambiguous = fixture("ambiguous-manifest"), ambiguousIO = transport(ambiguous.config);
  fs.writeFileSync(join(ambiguous.dir, ".mcp.json"), JSON.stringify({ mcpServers: { codex_app: { cwd: ambiguous.dir,
    args: ["./server.mjs"], env: { CODEX_APP_TOOLS_PIPE_PATH: [oldPipe, newPipe] } } } }));
  await assert.rejects(connect(ambiguous.dir, { ...ambiguousIO, inspectPipe: async () => proof }), error => error.code === "host_binding_invalid");
  assert.equal(fs.readFileSync(ambiguous.path, "utf8"), ambiguous.raw); assert.equal(ambiguousIO.launches.length, 1);

  const sending = fixture("send-disconnect"), sendingIO = transport(sending.config, { oldActive: true, disconnectSend: true });
  const ready = await connect(sending.dir, { ...sendingIO, preferredPipePath: newPipe, inspectPipe: async () => proof });
  await assert.rejects(ready.client.call("send_message_to_thread", { threadId: operator, prompt: "offline fixture" }), error => error.code === "host_disconnected");
  assert.equal(sendingIO.calls.filter(call => call.name === "send_message_to_thread").length, 1);
  assert.equal(sendingIO.launches.length, 1); assert.equal(fs.readFileSync(sending.path, "utf8"), sending.raw); ready.client.close();
  if (process.platform === "win32") {
    const modulePath = join(root, "ps7-modules"), securityModule = join(modulePath, "Microsoft.PowerShell.Security");
    fs.mkdirSync(securityModule, { recursive: true });
    fs.writeFileSync(join(securityModule, "Microsoft.PowerShell.Security.psd1"),
      "@{ModuleVersion='99.0';PowerShellVersion='7.0';RootModule='missing.dll';CmdletsToExport=@('Get-AuthenticodeSignature')}");
    const inheritedEnv = { ...process.env, PSModulePath: modulePath };
    const powershell = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const negative = childProcess.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $null=Get-AuthenticodeSignature -LiteralPath $env:ComSpec"],
      { env: inheritedEnv, windowsHide: true, encoding: "utf8", timeout: 10000 });
    assert.equal(negative.status, 1, "the inherited incompatible module path must actually fail to load the signature cmdlet");
    assert.match(negative.stderr, /Get-AuthenticodeSignature|Microsoft.PowerShell.Security/);
    const checked = childProcess.spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--module-path-child"],
      { env: inheritedEnv, windowsHide: true, encoding: "utf8", timeout: 20000 });
    assert.equal(checked.status, 0, checked.stderr); assert(checked.stdout.includes("module-path child passed"));
    const native = fixture("native-lookalike"), nativeIO = transport(native.config);
    const lookalikePipe = `\\\\.\\pipe\\codex-browser-use-${randomUUID()}`;
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.resume(); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(lookalikePipe, resolve); });
    try {
      await assert.rejects(connect(native.dir, { ...nativeIO, preferredPipePath: lookalikePipe }), error => error.code === "host_binding_untrusted");
      assert.equal(fs.readFileSync(native.path, "utf8"), native.raw); assert.equal(nativeIO.launches.length, 1);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); }
  }
  console.log("host rebinding SOURCE_OFFLINE checks passed; no product pipe, app launch or real send");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
