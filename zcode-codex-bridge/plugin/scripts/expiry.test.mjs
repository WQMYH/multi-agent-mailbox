import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Optional source root runs the same regression against the frozen pre-change source.
const plugin = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const { callTool, loadBinding, tools } = await import(pathToFileURL(join(plugin, "scripts/server.mjs")));
const { hostOperation, loadHostConfig } = await import(pathToFileURL(join(plugin, "scripts/host-client.mjs")));
const oldDate = "2000-01-01T00:00:00Z";
const report = { type: "progress", status: "running", statusBasis: "model_report",
  summary: "Offline fixture only.", evidence: [{ kind: "model_report", summary: "Fixture state." }] };
const canonical = value => normalize(realpathSync.native(value)).toLowerCase();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "zcc-expiry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "codex.js"), cwd = join(root, "workspace");
  writeFileSync(script, ""); mkdirSync(cwd);
  const env = { ZCC_CODEX_SCRIPT: script, ZCC_CODEX_CWD: cwd,
    ZCC_CODEX_THREAD_ID: "00000000-0000-4000-8000-000000000050",
    ZCC_SOURCE_SESSION_ID: "sess_offline-fixture", ZCC_TEAM_ID: "offline-fixture",
    ZCC_EXPECTED_REPLY: "OFFLINE_ONLY", ZCODE_PLUGIN_DATA: root };
  // Future date is used ONLY to prepare old-code-compatible fixtures, not as the fix.
  const binding = loadBinding({ ...env, ZCC_BINDING_EXPIRES_AT: "2030-01-01T00:00:00Z" });
  const config = { script, cwd, threadId: binding.threadId, pipePath: "\\\\.\\pipe\\offline-fixture",
    expiresAt: binding.expiresAt };
  const configPath = join(root, "host-config.json");
  const save = value => writeFileSync(configPath, JSON.stringify(value));
  save(config);
  const counts = { spawn: 0, read: 0, list: 0, send: 0 };
  function transport({ target = binding.threadId, targetCwd = cwd, denied = false, afterRead } = {}) {
    return { report, timeoutMs: 200, spawnProcess: (_node, args, options) => {
      counts.spawn++;
      assert.deepEqual(args, [script]);
      assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, config.pipePath);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const emit = value => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split("\n")) {
          const message = JSON.parse(line);
          if (message.method === "initialize") emit({ id: message.id, result: { protocolVersion: "2025-06-18" } });
          if (message.method === "tools/call") {
            assert.deepEqual(message.params._meta, { codexThreadId: binding.threadId });
            const { name, arguments: args } = message.params;
            let value;
            if (name === "read_thread") {
              counts.read++; assert.equal(args.threadId, binding.threadId);
              value = { thread: { id: target, cwd: targetCwd, status: { type: "idle" } } };
              afterRead?.();
            } else if (name === "list_threads") {
              counts.list++;
              value = { schemaVersion: 4, pinnedThreads: [], threads: [{ kind: "codex", hostId: "local", id: target, status: "active" }], unavailableHosts: [], unavailableSources: [] };
            } else {
              assert.equal(name, "send_message_to_thread"); assert.equal(args.threadId, binding.threadId);
              counts.send++;
              assert.match(args.prompt, /not|不是/);
              value = { threadId: target };
            }
            emit({ id: message.id, result: denied && name === "send_message_to_thread"
              ? { isError: true, content: [{ type: "text", text: "Native permission refused" }] }
              : { content: [{ type: "text", text: JSON.stringify(value) }] } });
          }
        }
        done();
      } });
      child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); };
      return child;
    } };
  }
  return { root, env, binding, config, configPath, save, counts, transport };
}

for (const date of [undefined, oldDate, "invalid"]) {
  test(`binding accepts ${date ?? "omitted"} legacy date without renewal`, t => {
    const f = fixture(t), env = { ...f.env };
    if (date !== undefined) env.ZCC_BINDING_EXPIRES_AT = date;
    const binding = loadBinding(env);
    assert.equal(binding.threadId, f.binding.threadId);
    assert.equal(binding.expiresAt, date === oldDate ? "2000-01-01T00:00:00.000Z" : undefined);
    assert.throws(() => loadBinding({ ...env, ZCC_SOURCE_SESSION_ID: "wrong" }), /source/);
  });
  test(`host accepts ${date ?? "omitted"} date; read and send remain fixed`, async t => {
    const f = fixture(t), config = { ...f.config };
    if (date === undefined) delete config.expiresAt; else config.expiresAt = date;
    f.save(config); assert.equal(loadHostConfig(f.root, f.binding).threadId, f.binding.threadId);
    const binding = { ...f.binding, expiresAt: date };
    const before = readFileSync(f.configPath, "utf8");
    assert.equal((await hostOperation(binding, f.root, undefined, f.transport())).threadId, binding.threadId);
    assert.equal((await hostOperation(binding, f.root, "notification", f.transport())).state, "accepted");
    assert.deepEqual(f.counts, { spawn: 2, read: 2, list: 0, send: 1 });
    assert.equal(readFileSync(f.configPath, "utf8"), before, "no config renewal or rewrite");
    const status = await callTool("codex_binding_status", {}, { env: f.env });
    assert.equal(status.state, "configured"); assert.equal(status.connectionVerified, false);
    assert.equal(f.counts.send, 1);
    t.diagnostic(JSON.stringify(f.counts));
  });
}

test("crossing a legacy date after native read does not suppress a notification", async t => {
  const f = fixture(t);
  const result = await hostOperation(f.binding, f.root, "cross-date", f.transport({ afterRead: () => { f.binding.expiresAt = oldDate; } }));
  assert.equal(result.state, "accepted"); assert.equal(f.counts.send, 1);
  t.diagnostic(JSON.stringify(f.counts));
});

test("fixed config/native target, cwd and source checks still refuse mismatches", async t => {
  const f = fixture(t);
  for (const patch of [{ threadId: "other" }, { cwd: f.root }]) {
    f.save({ ...f.config, ...patch });
    await assert.rejects(hostOperation(f.binding, f.root, "wrong-config", f.transport()), /does not match/);
  }
  assert.equal(f.counts.spawn, 0); f.save(f.config);
  for (const patch of [{ target: "other" }, { targetCwd: f.root }])
    await assert.rejects(hostOperation(f.binding, f.root, "wrong-native", f.transport(patch)), /does not match/);
  assert.equal(f.counts.send, 0);
  assert.equal((await hostOperation(f.binding, f.root, "bound", f.transport())).state, "accepted");
  await assert.rejects(hostOperation({ ...f.binding, sourceSessionId: "sess_other" }, f.root, "bound", f.transport()), /conflicts/);
  assert.equal(f.counts.send, 1); assert(!existsSync(join(f.root, "host-report-wrong-native.json")));
  t.diagnostic(JSON.stringify(f.counts));
});

test("statistics are read-only and do not consume the notification", async t => {
  const f = fixture(t); delete f.binding.expiresAt; delete f.config.expiresAt; f.save(f.config);
  const before = readdirSync(f.root).sort();
  const count = await hostOperation(f.binding, f.root, undefined, { ...f.transport(), view: "active_count" });
  assert.equal(count.count, 1); assert.equal(count.coverage.state, "complete");
  assert.deepEqual(readdirSync(f.root).sort(), before); assert.equal(f.counts.send, 0);
  assert.equal((await hostOperation(f.binding, f.root, "after-count", f.transport())).state, "accepted");
  assert.deepEqual(f.counts, { spawn: 2, read: 2, list: 1, send: 1 });
  t.diagnostic(JSON.stringify(f.counts));
});

test("old accepted and uncertain host receipts survive date removal byte-for-byte without replay", async t => {
  const f = fixture(t);
  for (const [id, denied, state] of [["accepted", false, "accepted"], ["unknown", true, "uncertain"]]) {
    f.binding.expiresAt = "2030-01-01T00:00:00.000Z"; f.config.expiresAt = f.binding.expiresAt; f.save(f.config);
    assert.equal((await hostOperation(f.binding, f.root, id, f.transport({ denied }))).state, state);
    const path = join(f.root, `host-report-${id}.json`), before = readFileSync(path, "utf8");
    delete f.binding.expiresAt; delete f.config.expiresAt; f.save(f.config);
    const effects = { ...f.counts };
    const receipt = await hostOperation(f.binding, f.root, id, f.transport());
    assert.equal(receipt.state, state); assert.equal(receipt.deduplicated, true);
    assert.equal(readFileSync(path, "utf8"), before); assert.deepEqual(f.counts, effects);
  }
  assert.equal(f.counts.send, 2, "one accepted call and one refused/unknown call; neither replays");
  t.diagnostic(JSON.stringify(f.counts));
});

test("legacy expired fingerprint and terminal records retain the old format; live sender stays blocked", async t => {
  const f = fixture(t), env = { ...f.env, ZCC_BINDING_EXPIRES_AT: oldDate };
  const fingerprint = createHash("sha256").update(JSON.stringify({ codexScript: canonical(f.binding.codexScript),
    threadId: f.binding.threadId, cwd: canonical(f.binding.cwd), sourceSessionId: f.binding.sourceSessionId,
    teamId: f.binding.teamId, expiresAt: "2000-01-01T00:00:00.000Z", expectedReply: f.binding.expectedReply })).digest("hex");
  const records = Object.fromEntries(["completed", "uncertain"].map(state => [state, { requestId: state, state, bindingFingerprint: fingerprint }]));
  const path = join(f.root, "send-ledger.json"); writeFileSync(path, JSON.stringify({ version: 1, records }));
  const before = readFileSync(path, "utf8"); let sends = 0;
  for (const state of Object.keys(records)) {
    const result = await callTool("codex_fixed_reply_test", { requestId: state }, { env, send: () => { sends++; throw Error("must not replay"); } });
    assert.equal(result.deduplicated, true); assert.equal(result.state, state);
  }
  assert.equal(sends, 0); assert.equal(readFileSync(path, "utf8"), before);
  const blocked = await callTool("codex_fixed_reply_test", { requestId: "production" }, { env });
  assert.equal(blocked.state, "blocked"); assert.equal(blocked.sent, false); assert.equal(tools.length, 4);
  t.diagnostic("legacy injected sends=0; production sent=false; ledger unchanged");
});

test("configure-host needs no date and ignores an old optional date; source templates do not require expiry", t => {
  const f = fixture(t);
  for (const extra of [[], [oldDate]]) {
    execFileSync(process.execPath, [join(plugin, "scripts/host-client.mjs"), "--configure-host", f.root, f.config.script, ...extra],
      { cwd: f.config.cwd, env: { ...process.env, CODEX_THREAD_ID: f.binding.threadId, CODEX_APP_TOOLS_PIPE_PATH: f.config.pipePath }, windowsHide: true });
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    assert.equal(Object.hasOwn(config, "expiresAt"), false); assert.equal(config.threadId, f.binding.threadId);
  }
  const manifest = JSON.parse(readFileSync(join(plugin, ".zcode-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest.userConfig, "binding_expires_at"), false);
  assert.equal(Object.hasOwn(mcp.mcpServers["codex-bridge"].env, "ZCC_BINDING_EXPIRES_AT"), false);
  assert.equal(f.counts.send, 0, "setup never contacts a host");
  t.diagnostic(JSON.stringify(f.counts));
});
