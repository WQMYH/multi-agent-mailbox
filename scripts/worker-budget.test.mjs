import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleRegistry } from "../modules/agent-core/src/registry.mjs";
import * as sourceQueue from "./message-queue.mjs";
import { openWorkerQueue } from "./queue-worker.mjs";
import { callPublicTool } from "./tools.mjs";
import { readMany } from "./remote-tools.mjs";

const self = fileURLToPath(import.meta.url), packageRoot = resolve(dirname(self), "..");
const nativeClient = (messageId, startingCharacters = 0) => {
  let snapshots = 0, sends = 0, creates = 0;
  const task = { taskId: "sess_stream", workspacePath: "offline", workspaceKind: "local", displayStatus: "running" };
  return {
    open: async () => {}, list: async () => ({ tasks: [task] }),
    snapshot: async () => ({ messages: [
      { id: "native-input", role: "user", turnIndex: 0, content: sourceQueue.marker(messageId) + "\none request" },
      { id: "native-assistant", role: "assistant", turnIndex: 0, content: "x".repeat(startingCharacters + ++snapshots * 3000) }
    ] }),
    send: async () => { sends++; throw Error("No offline native sends authorized"); },
    createTask: async () => { creates++; throw Error("No offline native creates authorized"); },
    counts: () => ({ snapshots, sends, creates })
  };
};

function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return {
    version: db.prepare("PRAGMA user_version").get().user_version,
    owner: db.prepare("SELECT * FROM queue_owner").get(), worker: db.prepare("SELECT * FROM worker").get(),
    messages: db.prepare("SELECT * FROM messages ORDER BY seq").all(), events: db.prepare("SELECT * FROM events ORDER BY seq").all()
  }; } finally { db.close(); }
}

async function child() {
  const [workerUrl, mode, messageId, startingCharacters] = process.argv.slice(3);
  const queueUrl = new URL("./message-queue.mjs", workerUrl);
  const { MessageQueue } = await import(queueUrl.href);
  const { runWorker } = await import(workerUrl);
  const client = nativeClient(messageId, Number(startingCharacters));
  if (mode === "change") {
    const snapshot = client.snapshot; let first = true;
    client.snapshot = async (...args) => {
      if (first) { first = false; process.send({ stage: "waiting", waits: 0 }); await once(process, "message"); }
      return snapshot(...args);
    };
  }
  const allocations = new Set(); let checks = 0, key;
  const transaction = MessageQueue.prototype.transaction, traced = new WeakSet();
  MessageQueue.prototype.transaction = function (...args) {
    const context = this.coreContext;
    if (context && !traced.has(context)) {
      traced.add(context); key = context.registrationKey;
      const check = context.messageBudget.check;
      context.messageBudget.check = input => {
        checks++; const result = check(input); allocations.add(result.allocatedBytes); return result;
      };
    }
    return transaction.apply(this, args);
  };
  await once(process, "message"); // Parent finishes the real startup reservation first.
  let waits = 0;
  try {
    await runWorker({ connect: action => action(client), wait: async () => {
      waits++;
      if (mode === "change" && waits === 20 || mode === "pause" && waits === 1) {
        process.send({ stage: "waiting", waits }); await once(process, "message");
      }
    } });
    process.send({ stage: "result", status: "idle", checks, key, allocations: [...allocations], ...client.counts() });
  } catch (error) {
    process.send({ stage: "result", status: "blocked", code: error.code, reason: error.budget?.reason,
      checks, key, allocations: [...allocations], ...client.counts() });
  } finally { process.disconnect(); }
}

async function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "zcode-f2-budget-"));
  mkdirSync(root, { recursive: true });
  const configPath = join(root, "config.json"), path = join(root, "messages.sqlite");
  const registryPath = join(root, "registry.json"), results = [], children = [];
  const previousConfig = process.env.ZCODE_OPS_CONFIG;
  process.env.ZCODE_OPS_CONFIG = configPath;
  const { MessageQueue, queueOwnerId, launchWorker, startWorker, managedQueueBytes } = sourceQueue;
  let queue, unknownId, protectedId, messageId, before;
  const registry = new ModuleRegistry({ registryPath });
  const check = async (name, action) => { const evidence = await action(); results.push({ name, ...evidence }); console.log(`PASS ${name}`); };
  const preserved = current => {
    for (const id of [unknownId, protectedId]) {
      assert.deepEqual(current.messages.find(row => row.id === id), before.messages.find(row => row.id === id));
      assert.deepEqual(current.events.filter(row => row.message_id === id), before.events.filter(row => row.message_id === id));
    }
    const stream = current.messages.find(row => row.id === messageId);
    assert.equal(stream.state, "acknowledged"); assert.equal(stream.pruned_at, null);
    assert(!current.events.some(row => row.message_id === messageId && row.kind === "native_execution_failed"));
    assert.notEqual(current.worker.error, "worker_failed");
  };
  async function runChild(mode, workerUrl, handleWait = async () => {}) {
    const current = snapshot(path), characters = current.events.filter(row => row.kind === "message")
      .map(row => JSON.parse(row.payload)).filter(row => row.id === "native-assistant")
      .reduce((maximum, row) => Math.max(maximum, row.contentOffset + row.content.length), 0);
    let proc, result, forwarded;
    queue = new MessageQueue(path); // No manually supplied Core context on restart.
    try {
      await startWorker(queue, { resume: true, expectedRevision: queue.worker().control_revision,
        launch: (reservation, source) => launchWorker(reservation, source, (executable, args, options) => {
          forwarded = { worker: args[0], source, env: {
            queuePath: options.env.ZCODE_OPS_QUEUE_PATH, registrationKey: options.env.ZCODE_OPS_CORE_REGISTRATION,
            coreRequired: options.env.ZCODE_OPS_CORE_REQUIRED, reservation: options.env.ZCODE_OPS_WORKER_RESERVATION
          } };
          assert.equal(args[0], fileURLToPath(new URL("./queue-worker.mjs", import.meta.url)));
          proc = spawn(executable, [self, "--worker", workerUrl, mode, messageId, String(characters)], {
            ...options, detached: false, stdio: ["ignore", "pipe", "pipe", "ipc"]
          });
          children.push(proc); return proc;
        }) });
    } finally { queue.close(); queue = null; }
    let output = ""; proc.stdout.on("data", chunk => { output += chunk; }); proc.stderr.on("data", chunk => { output += chunk; });
    let waitFailure;
    proc.on("message", message => {
      if (message.stage === "result") result = message;
      else if (message.stage === "waiting") Promise.resolve(handleWait(message)).then(() => proc.send("continue"), error => { waitFailure = error; proc.kill(); });
    });
    const timer = setTimeout(() => proc.kill(), 15000);
    try {
      proc.send("go"); const [exitCode] = await once(proc, "exit");
      assert.equal(exitCode, 0, output); if (waitFailure) throw waitFailure;
      assert(result, output); assert.equal(result.sends, 0); assert.equal(result.creates, 0);
      assert(result.checks > 0); assert.equal(result.key, forwarded.env.registrationKey);
      assert.equal(forwarded.source.coreManaged, true); assert.equal(forwarded.env.coreRequired, "1");
      assert.equal(queueOwnerId(forwarded.env.queuePath), queueOwnerId(path));
      return { ...result, pid: proc.pid, forwarded, managedBytes: managedQueueBytes(path) };
    } finally { clearTimeout(timer); }
  }
  try {
    await check("standalone limits and fail-closed missing source", async () => {
      const standalonePath = join(root, "standalone.sqlite"), standalone = new MessageQueue(standalonePath);
      assert.equal(standalone.coreContext, null); standalone.enqueue({ requestId: "standalone", taskIds: ["sess_standalone"], prompt: "saved" }); standalone.close();
      assert.deepEqual([sourceQueue.LIMITS.diskBytes, sourceQueue.LIMITS.databaseBytes, sourceQueue.LIMITS.workingBytes], [20000000, 9000000, 7000000]);
      let spawns = 0;
      await assert.rejects(launchWorker("reservation", { path, coreManaged: true }, () => { spawns++; }), error => error.code === "ZCODE_BUDGET_BLOCKED");
      assert.equal(spawns, 0);
      assert.throws(() => openWorkerQueue({ ZCODE_OPS_QUEUE_PATH: path, ZCODE_OPS_CORE_REQUIRED: "1" }), error => error.code === "ZCODE_BUDGET_BLOCKED");
      return { spawns };
    });
    await check("Core source propagation and schema-8 protected migration", async () => {
      queue = new MessageQueue(path);
      unknownId = queue.enqueue({ requestId: "old-unknown", workspace: { path: "offline" }, prompt: "preserve unknown" }).messages[0].messageId;
      protectedId = queue.enqueue({ requestId: "old-unconsumed", taskIds: ["sess_protected"], prompt: "preserve unread" }).messages[0].messageId;
      queue.transaction(() => queue.db.exec("UPDATE worker SET desired=1 WHERE id=1")); const token = queue.acquire();
      assert(queue.claimCreate(queue.get(unknownId), token)); queue.failCreate(queue.get(unknownId));
      queue.transaction(() => queue.state(queue.get(protectedId), "completed")); queue.release(token);
      queue.transaction(() => queue.db.exec("UPDATE worker SET desired=0,paused=1 WHERE id=1"));
      queue.db.exec("ALTER TABLE queue_owner DROP COLUMN budget_registration_key; PRAGMA user_version=8");
      queue.close(); queue = null; before = snapshot(path);
      registry.install(join(packageRoot, "modules/agent-zcode"));
      registry.configureMessageBudget({ ownerIds: [queueOwnerId(path)], defaultOwnerBytes: 400000 });
      const receipt = await registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
        requestId: "stream", taskIds: ["sess_stream"], prompt: "one request"
      } });
      messageId = receipt.messages[0].messageId; assert.equal(receipt.messages[0].messageReceipt.ownerId, queueOwnerId(path));
      queue = new MessageQueue(path); assert(queue.coreContext?.registrationKey);
      assert.equal(queue.db.prepare("PRAGMA user_version").get().user_version, 9);
      queue.transaction(() => queue.db.exec("UPDATE worker SET desired=1,paused=0 WHERE id=1"));
      const worker = queue.acquire(); assert(queue.claim(queue.get(messageId), worker, "baseline"));
      queue.transaction(() => queue.state(queue.get(messageId), "acknowledged"));
      const baselineClient = nativeClient(messageId);
      const page = await readMany({ taskIds: ["sess_stream"], maxChars: 3000 }, action => action(baselineClient));
      queue.observe(queue.get(messageId), page.tasks[0]); queue.release(worker);
      queue.transaction(() => queue.db.exec("UPDATE worker SET desired=0,paused=1 WHERE id=1"));
      const context = queue.coreContext, calls = [], mockQueue = async (operation, args, source) => { calls.push({ operation, args, source }); return { events: [], cursor: 0 }; };
      for (const action of ["pause", "resume"]) await callPublicTool("zcode_control", { action, scope: "all", expectedRevision: 0 }, { ...context, queue: mockQueue });
      await callPublicTool("zcode_control", { action: "acknowledge_message", messageId, throughEvent: 1, consumerId: "reader" }, { ...context, queue: mockQueue });
      for (const action of ["release_message", "cancel_message"]) await callPublicTool("zcode_control", { action, messageId }, { ...context, queue: mockQueue });
      await callPublicTool("zcode_read", { view: "inbox" }, { ...context, queue: mockQueue });
      assert.equal(calls.length, 6); assert(calls.every(call => call.source.registrationKey === context.registrationKey && call.source.messageBudget === context.messageBudget));
      queue.close(); queue = null; preserved(snapshot(path));
      return { ownerId: queueOwnerId(path), registrationKey: context.registrationKey, publicPaths: calls.map(call => call.operation), schema: 9 };
    });
    await check("actual child loop: 400k backpressure preserves unknown and unread", async () => {
      const result = await runChild("fill", new URL("./queue-worker.mjs", import.meta.url).href);
      assert.equal(result.code, "ZCODE_BUDGET_BLOCKED"); assert.equal(result.reason, "owner_budget_exceeded");
      assert.deepEqual(result.allocations, [400000]); assert(result.snapshots > 0 && result.managedBytes < 400000);
      preserved(snapshot(path)); return result;
    });
    await check("live allocation change, lost source, packaged restart and explicit pause", async () => {
      let atLoss;
      const result = await runChild("change", new URL("../modules/agent-zcode/runtime/queue-worker.mjs", import.meta.url).href, async ({ waits }) => {
        if (waits === 0) registry.configureMessageBudget({ ownerIds: [queueOwnerId(path)], ownerOverrides: { [queueOwnerId(path)]: 800000 } });
        else { atLoss = snapshot(path); renameSync(registryPath, registryPath + ".held"); }
      });
      renameSync(registryPath + ".held", registryPath);
      assert.equal(result.reason, "budget_source_unavailable"); assert.deepEqual(result.allocations, [400000, 800000]);
      assert.deepEqual(snapshot(path), atLoss, "loss of the source grants no shutdown/maintenance/failure writes"); preserved(snapshot(path));
      const restarted = await runChild("pause", new URL("../modules/agent-zcode/runtime/queue-worker.mjs", import.meta.url).href, async () => {
        await registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_control", args: {
          action: "pause", scope: "all", expectedRevision: snapshot(path).worker.control_revision
        } });
      });
      assert.equal(restarted.status, "idle"); assert.deepEqual(restarted.allocations, [800000]);
      assert.notEqual(restarted.pid, result.pid); assert.equal(restarted.key, result.key); assert.equal(snapshot(path).worker.token, null);
      preserved(snapshot(path)); return { changed: result, restarted };
    });
    await check("missing/malformed/unallocated/stale sources reject all same-owner reopen writes", async () => {
      const saved = readFileSync(registryPath), database = readFileSync(path), state = JSON.parse(saved);
      for (const mode of ["missing_budget", "malformed", "unallocated", "stale"]) {
        const candidate = structuredClone(state);
        if (mode === "missing_budget") delete candidate.messageBudget;
        if (mode === "unallocated") candidate.messageBudget.allocations[0].ownerId = "unrelated-owner";
        if (mode === "stale") candidate.modules["agent-zcode"].revision = "changed-revision";
        writeFileSync(registryPath, mode === "malformed" ? "{" : JSON.stringify(candidate));
        assert.throws(() => new MessageQueue(path), error => error.code === "ZCODE_BUDGET_BLOCKED", mode);
        assert.deepEqual(readFileSync(path), database); writeFileSync(registryPath, saved);
      }
      queue = new MessageQueue(path); const key = queue.coreContext.registrationKey; queue.close(); queue = null;
      let proc;
      await launchWorker("unused", { path, registrationKey: key, coreManaged: true }, (executable, args, options) => {
        proc = spawn(executable, args, { ...options, detached: false, stdio: "pipe" }); children.push(proc); return proc;
      });
      proc.ref(); proc.stdout.resume(); proc.stderr.resume();
      const timer = setTimeout(() => proc.kill(), 15000);
      try { assert.equal((await once(proc, "exit"))[0], 0, "default main opens its Core-bound paused queue without network"); }
      finally { clearTimeout(timer); }
      preserved(snapshot(path)); return { rejected: 4, defaultMainExit: 0 };
    });
    writeFileSync(join(root, "evidence.json"), JSON.stringify({ node: process.version, checks: results.length, results,
      networkCalls: 0, nativeSends: 0, nativeCreates: 0, productProcessesStarted: 0 }, null, 2) + "\n");
    console.log(`F2 ${results.length}/5 checks passed; evidence=${join(root, "evidence.json")}`);
  } finally {
    queue?.close();
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc, "exit"); proc.kill(); await exited; }
    if (previousConfig === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = previousConfig;
  }
}

if (process.argv[2] === "--worker") await child(); else await main();
