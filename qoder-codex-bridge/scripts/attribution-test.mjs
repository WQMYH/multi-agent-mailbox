import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createBinding } from "./configure-binding.mjs";
import { handle } from "../hooks/handler.mjs";
import { storeOwnerId } from "./store-budget.mjs";

const requestId = "11111111-2222-3333-4444-555555555555";
const hookSession = "attribution-test";
const script = fileURLToPath(import.meta.url);
const input = (dir, event, prompt) => ({ hook_event_name: event, session_id: hookSession, cwd: dir, prompt });
const pauseUntil = path => {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw Error("fixture barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

if (process.argv[2] === "--worker") {
  const [dir, mode, event, prompt] = process.argv.slice(3);
  const anchor = join(dir, `submission-${hookSession}.json`);
  if (mode === "rename-fault" || mode === "quarantine-fault") {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const target = mode === "rename-fault" ? anchor : join(dir, `submission-${hookSession}.quarantined`);
      if (resolve(to) === resolve(target)) throw Object.assign(Error("fixture EIO"), { code: "EIO" });
      return rename(from, to);
    };
    syncBuiltinESMExports();
  }
  if (mode === "busy-fault") {
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (resolve(path) === resolve(`${anchor}.busy`)) throw Object.assign(Error("fixture EIO"), { code: "EIO" });
      return write(path, ...args);
    };
    syncBuiltinESMExports();
  }
  if (mode === "hold-lock") {
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      if (resolve(path) === resolve(anchor) && fs.existsSync(`${anchor}.busy`)) {
        fs.writeFileSync(join(dir, "LOCKED"), "");
        pauseUntil(join(dir, "RELEASE"));
      }
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  }
  let hostStarts = 0;
  const result = await handle(input(dir, event, prompt), {
    dataDir: dir,
    transport: { spawnProcess: () => { hostStarts++; throw Error("No real host in tests"); } }
  });
  process.stdout.write(JSON.stringify({ result, hostStarts }));
} else {
  const root = fs.mkdtempSync(join(tmpdir(), "qoder-codex-bridge-"));
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert(rel.startsWith("qoder-codex-bridge-") && !rel.includes("/") && !rel.includes("\\") && !isAbsolute(rel));
  const children = new Set();
  const coreCli = join(root, "budget-cli.mjs");
  fs.writeFileSync(coreCli, `import { readFileSync } from "node:fs";
const args = process.argv.slice(2), index = args.indexOf("--registry");
const state = JSON.parse(readFileSync(args[index + 1], "utf8"));
process.stdout.write(JSON.stringify({ messageBudget: state.messageBudget }) + "\\n");
`);
  function setupBudget(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const ownerId = storeOwnerId(dir), registryPath = join(dir, "core-registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 20_000_000,
      allocations: [{ ownerId, bytes: 20_000_000 }] } }));
    fs.writeFileSync(join(dir, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId, coreCli, registryPath }));
  }
  function worker(dir, mode, event, prompt = "") {
    const child = spawn(process.execPath, [script, "--worker", dir, mode, event, prompt], { windowsHide: true });
    children.add(child);
    return new Promise((resolveResult, reject) => {
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); reject(Error("worker timeout")); }, 15000);
      child.stdout.on("data", value => { out += value; });
      child.stderr.on("data", value => { err += value; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => {
        children.delete(child); clearTimeout(timer);
        if (code !== 0) return reject(Error(`worker exit ${code}: ${err}`));
        try { resolveResult(JSON.parse(out)); } catch (error) { reject(error); }
      });
    });
  }
  function cli(dir, event, prompt = "", faultPath = "") {
    const preload = join(root, "fault-preload.mjs");
    const args = faultPath ? ["--import", pathToFileURL(preload).href] : [];
    // Use the real command Hook entry point so the process exit code is observed.
    const handler = fileURLToPath(new URL("../hooks/handler.mjs", import.meta.url));
    const child = spawn(process.execPath, [...args, handler], {
      windowsHide: true, env: { ...process.env, QODER_PLUGIN_DATA: dir, QODER_TEST_FAULT_PATH: faultPath }
    });
    children.add(child);
    child.stdin.end(JSON.stringify(input(dir, event, prompt)));
    return new Promise((resolveResult, reject) => {
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); reject(Error("hook timeout")); }, 15000);
      child.stdout.on("data", value => { out += value; });
      child.stderr.on("data", value => { err += value; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => {
        children.delete(child); clearTimeout(timer);
        try { resolveResult({ code, result: JSON.parse(out) }); }
        catch (error) { reject(Error(`hook exit ${code}: ${err || error.message}`)); }
      });
    });
  }
  function fixture(name) {
    const dir = join(root, name);
    setupBudget(dir);
    createBinding(dir, requestId, requestId, requestId, hookSession, dir, requestId, dir, "2030-01-01T00:00:00Z");
    return dir;
  }
  async function assertNoTerminal(dir) {
    for (const event of ["Stop", "StopFailure"]) {
      const { result, hostStarts } = await worker(dir, "normal", event);
      assert.equal(result.notified, false);
      assert.equal(result.state, "uncorrelated");
      assert.equal(hostStarts, 0);
    }
    assert(!fs.existsSync(join(dir, `receipt-stop_observed-${requestId}.json`)));
    assert(!fs.existsSync(join(dir, `receipt-error_observed-${requestId}.json`)));
  }
  try {
    fs.writeFileSync(join(root, "fault-preload.mjs"), `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
const write = fs.writeFileSync;
fs.writeFileSync = (path, ...args) => {
  if (resolve(path) === resolve(process.env.QODER_TEST_FAULT_PATH)) throw Object.assign(Error("fixture EIO"), { code: "EIO" });
  return write(path, ...args);
};
syncBuiltinESMExports();
`);
    const unbound = join(root, "unbound");
    fs.mkdirSync(unbound);
    const unboundHook = await cli(unbound, "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
    assert.equal(unboundHook.code, 0);
    assert.equal(unboundHook.result.state, "host_binding_missing");
    const denied = fixture("hook-denied");
    const deniedHook = await cli(denied, "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`, join(denied, `submission-${hookSession}.json.busy`));
    assert.equal(deniedHook.code, 2);
    assert.equal(deniedHook.result.blockInput, true);
    assert.equal(deniedHook.result.state, "attribution_unpersistable");
    const receiptDenied = fixture("hook-receipt-denied");
    const receiptHook = await cli(receiptDenied, "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`,
      join(receiptDenied, `receipt-input_observed-${requestId}.json`));
    assert.equal(receiptHook.code, 2);
    assert.equal(receiptHook.result.blockInput, true);
    assert.equal(receiptHook.result.state, "record_unpersistable");
    assert(fs.existsSync(join(receiptDenied, `submission-${hookSession}.json.busy`)));
    const afterRejectedInput = await cli(receiptDenied, "Stop");
    assert.equal(afterRejectedInput.result.state, "uncorrelated");
    assert.equal(afterRejectedInput.result.notified, false);
    const stopHook = await cli(fixture("hook-stop"), "Stop");
    assert.equal(stopHook.code, 1);
    assert.equal(stopHook.result.blockInput, false);
    const good = fixture("hook-recorded");
    const recordedHook = await cli(good, "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
    assert.equal(recordedHook.code, 0);
    assert.equal(recordedHook.result.state, "recorded_not_dispatched");
    const overlapHook = await cli(good, "UserPromptSubmit", "extra input");
    assert.equal(overlapHook.code, 1);
    assert.equal(overlapHook.result.blockInput, false);

    // Both workers execute the actual handler with the SAME request and distinct inputs.
    // Hold A inside its acquired lock so B must genuinely contend, not run sequentially.
    const race = fixture("race");
    const a = worker(race, "hold-lock", "UserPromptSubmit", `first\nQODER_RETURN_REQUEST=${requestId}`);
    pauseUntil(join(race, "LOCKED"));
    const b = await worker(race, "normal", "UserPromptSubmit", `second\nQODER_RETURN_REQUEST=${requestId}`);
    fs.writeFileSync(join(race, "RELEASE"), "");
    const ar = await a;
    assert.equal(b.result.state, "uncorrelated");
    assert.equal(ar.result.state, "uncorrelated");
    assert.equal(ar.hostStarts + b.hostStarts, 0);
    await assertNoTerminal(race);

    // Fault in a separate process; subsequent terminal events run in fresh processes.
    for (const mode of ["rename-fault", "quarantine-fault"]) for (const event of ["UserPromptSubmit", "Stop"]) {
      const dir = fixture(`${mode}-${event}`);
      const first = await worker(dir, "normal", "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
      assert.equal(first.result.state, "recorded_not_dispatched");
      const failed = await worker(dir, mode, event, "extra input");
      assert.equal(failed.result.state, "attribution_unpersistable");
      assert.equal(failed.hostStarts, 0);
      await assertNoTerminal(dir);
    }

    // The initial busy creation alone fails. Other writes still work, so the
    // handler must leave an independent fence before a fresh process sees Stop.
    const busy = fixture("busy-fault");
    const opened = await worker(busy, "normal", "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
    assert.equal(opened.result.state, "recorded_not_dispatched");
    const failedBusy = await worker(busy, "busy-fault", "UserPromptSubmit", "extra input");
    assert.equal(failedBusy.result.state, "attribution_unpersistable");
    assert.equal(failedBusy.hostStarts, 0);
    assert(fs.existsSync(join(busy, `submission-${hookSession}.json.conflicted`)));
    assert(!fs.existsSync(join(busy, `submission-${hookSession}.json.busy`)));
    const old = JSON.parse(fs.readFileSync(join(busy, `submission-${hookSession}.json`), "utf8"));
    assert.equal(old.ambiguous, false); assert.equal(old.terminal, false);
    await assertNoTerminal(busy);

    // A completed request cannot reopen its old attribution through a duplicate marker.
    const done = fixture("done");
    await worker(done, "normal", "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
    await worker(done, "normal", "Stop");
    const reopened = await worker(done, "normal", "UserPromptSubmit", `QODER_RETURN_REQUEST=${requestId}`);
    assert.equal(reopened.result.diagnostics[0].code, "duplicate_submission");
    const sf = await worker(done, "normal", "StopFailure");
    assert.equal(sf.result.notified, false); assert.equal(sf.hostStarts, 0);
    console.log("attribution: real handler contention, fresh-process rename/busy-fault recovery, and single-use request passed");
  } finally {
    for (const child of children) child.kill();
    // Exactly the verified, newly allocated fixture root; never a pre-existing path.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
