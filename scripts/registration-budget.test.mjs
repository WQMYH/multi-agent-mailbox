import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleRegistry } from "../modules/agent-core/src/registry.mjs";

const root = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "zcode-registration-budget-"));
mkdirSync(root, { recursive: true });
const previousConfig = process.env.ZCODE_OPS_CONFIG, results = [];
const blocked = error => error.code === "ZCODE_BUDGET_BLOCKED" && error.budget?.reason === "budget_registration_changed";
const files = path => Object.fromEntries(["", "-journal", "-wal", "-shm"].map(suffix =>
  [suffix, existsSync(path + suffix) ? readFileSync(path + suffix) : null]));
try {
  for (const [name, url] of [["source", new URL("./", import.meta.url)],
    ["runtime", new URL("../modules/agent-zcode/runtime/", import.meta.url)]]) {
    const dir = join(root, name); assert(!existsSync(dir), "Use a fresh private fixture, do not overwrite"); mkdirSync(dir);
    const path = join(dir, "messages.sqlite"), registryPath = join(dir, "registry.json");
    process.env.ZCODE_OPS_CONFIG = join(dir, "config.json");
    const { MessageQueue, queueOwnerId } = await import(new URL("message-queue.mjs", url).href);
    const { queueBudgetContext } = await import(new URL("queue-budget.mjs", url).href);
    let queue = new MessageQueue(path);
    queue.transaction(() => queue.db.exec("UPDATE worker SET paused=1 WHERE id=1")); queue.close();
    const registry = new ModuleRegistry({ registryPath });
    registry.install(fileURLToPath(new URL("../modules/agent-zcode/", import.meta.url)));
    registry.configureMessageBudget({ ownerIds: [queueOwnerId(path)], defaultOwnerBytes: 800000 });
    await registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
      requestId: "valid-core", taskIds: ["sess_private"], prompt: "private registration fixture"
    } });
    const validState = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(validState.modules["agent-zcode"].enabled, true);
    queue = new MessageQueue(path);
    try {
      const key = queue.coreContext.registrationKey;
      queueBudgetContext(key).assertCurrent();
      queue.enqueue({ requestId: "normal-true", taskIds: ["sess_private"], prompt: "allowed" });
      assert.equal(queue.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
      results.push({ implementation: name, enabled: true, accepted: true });
      for (const enabled of ["false", false]) {
        const damaged = structuredClone(validState); damaged.modules["agent-zcode"].enabled = enabled;
        const before = files(path), count = queue.db.prepare("SELECT count(*) AS n FROM messages").get().n;
        writeFileSync(registryPath, JSON.stringify(damaged));
        let coreError;
        if (typeof enabled !== "boolean") {
          assert.throws(() => registry.messageBudget(), error => {
            coreError = error.message; return /Invalid module registry record/.test(coreError);
          });
        } else {
          await assert.rejects(registry.agentAct({ moduleId: "agent-zcode", operation: "zcode_send", args: {
            requestId: "disabled-core", taskIds: ["sess_private"], prompt: "must not write"
          } }), error => { coreError = error.message; return /Module disabled/.test(coreError); });
        }
        assert.throws(() => queueBudgetContext(key).assertCurrent(), blocked);
        assert.throws(() => new MessageQueue(path), blocked);
        assert.throws(() => queue.enqueue({ requestId: "after-malformed-registration", taskIds: ["sess_private"], prompt: "must not write" }), blocked);
        assert.equal(queue.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
        assert.equal(queue.db.prepare("SELECT 1 FROM messages WHERE request_id='after-malformed-registration'").get(), undefined);
        assert.deepEqual(files(path), before, "No DB/journal/WAL/SHM changes on refused registration");
        results.push({ implementation: name, enabled, coreError, helperRejected: true, reopenRejected: true,
          existingQueueWriteRejected: true, messageCount: count, managedFilesUnchanged: true });
        writeFileSync(registryPath, JSON.stringify(validState));
      }
      queueBudgetContext(key).assertCurrent(); // Restored true is still usable, not permanently quarantined.
    } finally { queue.close(); }
  }
  const evidence = { node: process.version, passed: results.length, total: 6, results,
    networkCalls: 0, nativeSends: 0, productProcessesStarted: 0 };
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`registration budget ${results.length}/6 checks passed; evidence=${join(root, "evidence.json")}`);
} finally {
  if (previousConfig === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = previousConfig;
}
