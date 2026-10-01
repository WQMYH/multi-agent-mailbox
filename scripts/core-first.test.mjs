import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMessageBudget, validateMessageReceipt } from "../modules/agent-core/src/contracts.mjs";
import { callQueueTool, managedQueueBytes, MessageQueue, queueOwnerId, LIMITS } from "./message-queue.mjs";

const totalBytes = 20_000_000;
const budget = (ownerId, bytes) => ({ schemaVersion: 1, totalBytes, allocations: bytes === totalBytes
  ? [{ ownerId, bytes }] : [{ ownerId, bytes }, { ownerId: "other-owner", bytes: totalBytes - bytes }] });
const budgetContext = (config, trace = []) => ({ messageBudget: { status: () => config, check: input => {
    const result = checkMessageBudget(config, input); trace.push(result); return result;
  } } });
const context = (ownerId, bytes, trace = []) => budgetContext(budget(ownerId, bytes), trace);

async function childWriter(path, allocation, requestId) {
  const ownerId = queueOwnerId(path), core = context(ownerId, allocation);
  let queue;
  try {
    queue = new MessageQueue(path, core);
    const result = queue.enqueue({ requestId, taskIds: [`sess_${requestId.replaceAll("_", "-")}`], prompt: "x".repeat(20_000) });
    process.stdout.write(JSON.stringify({ ok: true, messageId: result.messages[0].messageId }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code, budget: error.budget, message: error.message }));
  } finally { queue?.close(); }
}

function runChild(path, allocation, requestId) {
  return new Promise((resolveReply, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--writer", path, String(allocation), requestId],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolveReply(JSON.parse(stdout)) : reject(Error(`writer exited ${code}: ${stderr}`)));
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "zcode-core-first-"));
  const previous = process.env.ZCODE_OPS_CONFIG;
  try {
    const args = { requestId: "core-send", taskIds: ["sess_a", "sess_b"], prompt: "bounded" };
    const missing = join(root, "missing"); mkdirSync(missing);
    process.env.ZCODE_OPS_CONFIG = join(missing, "config.json");
    await assert.rejects(callQueueTool("zcode_queue_send", args, {
      messageBudget: { status: () => null, check: () => { throw Error("must not check missing budget"); } },
      validateMessageReceipt
    }), error => error.code === "ZCODE_BUDGET_BLOCKED" && error.budget.reason === "budget_not_configured" && error.budget.deltaBytes > 0);
    assert.equal(existsSync(join(missing, "messages.sqlite")), false, "missing budget creates no queue or message");

    for (const [name, allocation, reason] of [["unallocated", 0, "owner_unallocated"], ["over", 1, "owner_budget_exceeded"]]) {
      const directory = join(root, name); mkdirSync(directory);
      const path = join(directory, "messages.sqlite"), ownerId = queueOwnerId(path);
      process.env.ZCODE_OPS_CONFIG = join(directory, "config.json");
      const config = allocation ? budget(ownerId, allocation) : budget("different-owner", totalBytes);
      await assert.rejects(callQueueTool("zcode_queue_send", args, { validateMessageReceipt, messageBudget: {
        status: () => config, check: input => checkMessageBudget(config, input)
      } }), error => error.code === "ZCODE_BUDGET_BLOCKED" && error.budget.reason === reason && error.budget.deltaBytes > 0);
      assert.equal(existsSync(path), false, `${name} budget creates zero messages`);
    }

    const accepted = join(root, "accepted"); mkdirSync(accepted);
    const path = join(accepted, "messages.sqlite"), ownerId = queueOwnerId(path), trace = [], validated = [];
    process.env.ZCODE_OPS_CONFIG = join(accepted, "config.json");
    const core = context(ownerId, 10_000_000, trace);
    const sent = await callQueueTool("zcode_queue_send", args, { ...core, validateMessageReceipt: value => {
      validated.push(validateMessageReceipt(value));
    }, launch: async () => {} });
    assert.equal(sent.ownerId, ownerId); assert.equal(validated.length, 2);
    for (const message of sent.messages) {
      assert(message.messageId && message.taskId && message.state, "legacy queue result remains present");
      assert.equal(message.deliveryId, message.messageId); assert.equal(message.ownerId, ownerId);
      assert.equal(message.messageReceipt.acceptance.owner.state, "accepted");
      assert.equal(message.messageReceipt.acceptance.provider.state, "unknown");
      assert.equal(message.messageReceipt.target.address, message.taskId);
    }
    const firstProjection = Math.max(...trace.map(result => result.projectedBytes ?? 0)), repeatStart = trace.length;
    const repeated = await callQueueTool("zcode_queue_send", args, { ...core, validateMessageReceipt, launch: async () => {} });
    assert(repeated.deduplicated);
    assert.deepEqual(repeated.messages.map(message => message.deliveryId), sent.messages.map(message => message.deliveryId));
    assert(Math.max(...trace.slice(repeatStart).map(result => result.projectedBytes ?? 0)) <= firstProjection,
      "deduplicated retry does not reserve the batch payload or another future headroom commitment");
    await assert.rejects(callQueueTool("zcode_queue_send", { ...args, requestId: "spoof", ownerId: "caller-owner" }, {
      ...core, validateMessageReceipt
    }), /ownerId/);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT owner_id FROM queue_owner WHERE id=1").get().owner_id, ownerId);
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
    } finally { db.close(); }
    assert(trace.some(row => row.additionalBytes >= 2 * 16_000), "initial reservation includes durable status/receipt headroom");
    assert.ok(managedQueueBytes(path) <= Math.max(...trace.map(row => row.projectedBytes ?? 0)));

    const newTotal = 200_000_000, newDirectory = join(root, "new-core-total"); mkdirSync(newDirectory);
    const newPath = join(newDirectory, "messages.sqlite"), newOwner = queueOwnerId(newPath);
    const newConfig = { schemaVersion: 1, totalBytes: newTotal, allocations: [
      { ownerId: newOwner, bytes: 50_000_000 }, { ownerId: "owner-b", bytes: 50_000_000 },
      { ownerId: "owner-c", bytes: 50_000_000 }, { ownerId: "owner-d", bytes: 50_000_000 }
    ] };
    assert.equal(newConfig.allocations.reduce((sum, allocation) => sum + allocation.bytes, 0), newTotal);
    process.env.ZCODE_OPS_CONFIG = join(newDirectory, "config.json");
    const newResult = await callQueueTool("zcode_queue_send", { requestId: "new-core-positive",
      workspace: { path: "workspace" }, prompt: "First message" }, {
      ...budgetContext(newConfig), validateMessageReceipt, launch: async () => {}
    });
    assert.equal(newResult.messages[0].messageReceipt.target.address, newResult.messages[0].targetAddress);
    assert.equal(newResult.messages[0].messageReceipt.acceptance.provider.state, "unknown");
    const newDb = new DatabaseSync(newPath, { readOnly: true });
    try { assert.equal(newDb.prepare("SELECT count(*) AS n FROM messages").get().n, 1); }
    finally { newDb.close(); }
    assert.deepEqual([LIMITS.diskBytes, LIMITS.databaseBytes, LIMITS.workingBytes], [20_000_000, 9_000_000, 7_000_000]);
    process.env.ZCODE_OPS_CONFIG = join(accepted, "config.json");

    const sidecar = join(root, "sidecars.sqlite");
    for (const [suffix, size] of [["", 3], ["-wal", 5], ["-shm", 7], ["-journal", 11], [".manual-backup", 100]])
      writeFileSync(sidecar + suffix, Buffer.alloc(size));
    assert.equal(managedQueueBytes(sidecar), 26, "counts DB/WAL/SHM/journal and excludes manual backup");

    const reopen = join(root, "reopen.sqlite"), reopenOwner = queueOwnerId(reopen), reopenTrace = [];
    const reopenConfig = { schemaVersion: 1, totalBytes, allocations: [
      { ownerId: reopenOwner, bytes: 6_666_667 }, { ownerId: "owner-b", bytes: 6_666_667 },
      { ownerId: "owner-c", bytes: 6_666_666 }
    ] };
    assert.equal(reopenConfig.allocations.reduce((sum, allocation) => sum + allocation.bytes, 0), totalBytes);
    const reopenCore = budgetContext(reopenConfig, reopenTrace), prompt = "x".repeat(30_000);
    let blocked, blockedArgs, acceptedMessages = 0;
    for (let batch = 0; batch < 9 && !blocked; batch++) {
      const queue = new MessageQueue(reopen, reopenCore);
      blockedArgs = { requestId: `reopen-${batch}`,
        taskIds: Array.from({ length: 8 }, (_, index) => `sess_${batch}-${index}`), prompt };
      try { queue.enqueue(blockedArgs); acceptedMessages += 8; }
      catch (error) { blocked = error; }
      finally { queue.close(); }
    }
    const maximumProjection = reopenTrace.reduce((maximum, result) =>
      (result.projectedBytes ?? 0) > (maximum.projectedBytes ?? 0) ? result : maximum, {});
    assert(blocked && blocked.code === "ZCODE_BUDGET_BLOCKED" && blocked.budget.deltaBytes > 0,
      `reopened writers reject before cumulative future headroom exceeds the owner allocation: ${JSON.stringify({ acceptedMessages,
        blocked: blocked && { code: blocked.code, message: blocked.message },
        managedBytes: managedQueueBytes(reopen), maximumProjection })}`);
    const reopened = new DatabaseSync(reopen, { readOnly: true });
    try { assert.equal(reopened.prepare("SELECT count(*) AS n FROM messages").get().n, acceptedMessages); }
    finally { reopened.close(); }
    assert(acceptedMessages > 0 && acceptedMessages < 72, "rejection adds zero messages before all nine batches");
    let release = new MessageQueue(reopen, reopenCore);
    release.transaction(() => {
      for (const row of release.db.prepare(`SELECT * FROM messages WHERE state NOT IN ('completed','released','cancelled')`).all())
        release.state(row, "released");
    });
    release.close();
    release = new MessageQueue(reopen, reopenCore);
    release.enqueue(blockedArgs); release.close();
    const afterRelease = new DatabaseSync(reopen, { readOnly: true });
    try { assert.equal(afterRelease.prepare("SELECT count(*) AS n FROM messages").get().n, acceptedMessages + 8); }
    finally { afterRelease.close(); }

    const calibration = join(root, "calibration.sqlite");
    new MessageQueue(calibration).close();
    const calibrationOwner = queueOwnerId(calibration), firstTrace = [], calibrationCore = context(calibrationOwner, 10_000_000, firstTrace);
    let queue = new MessageQueue(calibration, calibrationCore);
    queue.enqueue({ requestId: "calibrate", taskIds: ["sess_calibrate"], prompt: "x".repeat(20_000) }); queue.close();
    const oneWriterAllocation = Math.max(...firstTrace.map(row => row.projectedBytes ?? 0));
    assert(oneWriterAllocation > managedQueueBytes(calibration) && oneWriterAllocation < totalBytes);

    const race = join(root, "race.sqlite");
    new MessageQueue(race).close();
    const results = await Promise.all([
      runChild(race, oneWriterAllocation, "race_a"),
      runChild(race, oneWriterAllocation, "race_b")
    ]);
    assert.equal(results.filter(result => result.ok).length, 1,
      `independent writers cannot both cross one-owner allocation: ${JSON.stringify({ oneWriterAllocation, results })}`);
    const loser = results.find(result => !result.ok);
    assert.equal(loser.code, "ZCODE_BUDGET_BLOCKED"); assert(loser.budget.deltaBytes > 0);
    const check = new DatabaseSync(race, { readOnly: true });
    try { assert.equal(check.prepare("SELECT count(*) AS n FROM messages").get().n, 1); }
    finally { check.close(); }
    assert(managedQueueBytes(race) <= oneWriterAllocation);

    console.log(`zcode Core-first owner/receipts/budget/concurrency OK ownerId=${ownerId} reopenAccepted=${acceptedMessages} reopenDelta=${blocked.budget.deltaBytes}`);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--writer") await childWriter(process.argv[3], Number(process.argv[4]), process.argv[5]);
else await main();
