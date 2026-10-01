import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MessageQueue, LIMITS, marker, startWorker, retireWorker } from "./message-queue.mjs";
import { withRemote } from "./remote-client.mjs";
import { readMany } from "./remote-tools.mjs";
import { callConfigTool } from "./config.mjs";

const fakeClient = () => ({ connect: async () => {}, close: async () => {}, sanitized: e => e });
const mode = process.argv[2];
if (mode?.startsWith("--queue-child-")) {
  process.send({ phase: "ready" });
  process.once("message", async () => {
    const path = process.argv[3];
    try {
      if (mode === "--queue-child-writer") {
        const errors = [];
        for (let i = 0; i < 20; i++) {
          let q;
          try {
            q = new MessageQueue(path);
            q.enqueue({ requestId: "shared", taskIds: ["sess_shared"], prompt: "same" });
            q.enqueue({ requestId: `${process.pid}-${i}`, taskIds: [`sess_${process.pid}`], prompt: "unique" });
            q.read();
          } catch (e) { errors.push(e.message); }
          finally { q?.close(); }
          await delay(1);
        }
        process.send({ phase: "done", errors });
      } else if (mode === "--queue-child-assignment") {
        const q = new MessageQueue(path);
        try {
          q.enqueue({ requestId: `instance-${process.pid}`, taskIds: [`sess_${process.pid}`], prompt: "assignment",
            context: { instanceId: "shared-instance", writeRoot: "E:/assignment/shared" } });
          process.send({ phase: "done", accepted: true });
        } catch (error) {
          if (!error.message.startsWith("DUPLICATE_ASSIGNMENT:")) throw error;
          process.send({ phase: "done", accepted: false });
        } finally { q.close(); }
      } else if (mode === "--queue-child-remote") {
        for (let i = 0; i < 3; i++) await withRemote(async () => {
          const q = new MessageQueue(path);
          try {
            q.transaction(() => q.db.prepare("INSERT INTO probe(pid,phase) VALUES(?,'enter')").run(process.pid));
            await delay(20);
            q.transaction(() => q.db.prepare("INSERT INTO probe(pid,phase) VALUES(?,'exit')").run(process.pid));
          } finally { q.close(); }
        }, { path, createClient: fakeClient });
        process.send({ phase: "done" });
      } else {
        await withRemote(async () => {
          process.send({ phase: "held" });
          await new Promise(() => {}); // The parent kills this process, bypassing finally.
        }, { path, createClient: fakeClient });
      }
    } catch (e) { process.send({ phase: "done", error: e.message }); }
    process.disconnect();
  });
} else {
  const dir = mkdtempSync(join(tmpdir(), "zcode-concurrency-test-"));
  const original = process.env.ZCODE_OPS_CONFIG;
  const children = [];
  let q;
  function child(kind, path) {
    const proc = fork(fileURLToPath(import.meta.url), [`--queue-child-${kind}`, path], {
      execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    children.push(proc);
    const ready = once(proc, "message"), exit = once(proc, "exit");
    const messages = [];
    proc.on("message", message => messages.push(message));
    let stderr = ""; proc.stderr.on("data", chunk => { stderr += chunk; });
    const done = exit.then(([code]) => {
      assert.equal(code, 0, stderr);
      const result = messages.find(m => m.phase === "done");
      assert(result, "Child returned no result"); assert(!result.error, result.error);
      return result;
    });
    done.catch(() => {}); // A deliberately killed owner is checked through exit instead.
    return { proc, ready, exit, done };
  }
  async function group(kind, path) {
    const peers = Array.from({ length: 4 }, () => child(kind, path));
    await Promise.all(peers.map(p => p.ready));
    peers.forEach(p => p.proc.send("go"));
    return Promise.all(peers.map(p => p.done));
  }
  const timeout = setTimeout(() => { for (const proc of children) if (proc.exitCode === null) proc.kill(); }, 45000);
  try {
    process.env.ZCODE_OPS_CONFIG = join(dir, "config.json");
    await callConfigTool("zcode_config_set", { sharingLink: "https://zcode.z.ai/remote/v4?sid=test-device&hash=test-password&mid=test-mid" });

    // Four REAL processes cold-open, write and read the same SQLite file.
    const path = join(dir, "parallel.sqlite");
    const writers = await group("writer", path);
    assert.deepEqual(writers.flatMap(r => r.errors), []);
    q = new MessageQueue(path);
    assert.equal(q.db.prepare("SELECT count(*) AS n FROM messages").get().n, 81);
    assert.equal(q.db.prepare("SELECT count(*) AS n FROM messages WHERE request_id='shared'").get().n, 1);
    const assignments = await group("assignment", join(dir, "assignments.sqlite"));
    assert.equal(assignments.filter(r => r.accepted).length, 1, "Only one competing process admits a shared instance/writeRoot");
    q.db.exec("CREATE TABLE probe(seq INTEGER PRIMARY KEY,pid INTEGER,phase TEXT)");
    await group("remote", path);
    const visits = q.db.prepare("SELECT * FROM probe ORDER BY seq").all();
    assert.equal(visits.length, 24);
    for (let i = 0; i < visits.length; i += 2) {
      assert.equal(visits[i].phase, "enter"); assert.equal(visits[i + 1].phase, "exit");
      assert.equal(visits[i].pid, visits[i + 1].pid, "Only one cross-process remote owner");
    }
    const tickets = [q.remoteTicket(), q.remoteTicket(), q.remoteTicket()];
    assert(!q.remoteTurn(tickets[1])); assert(!q.remoteTurn(tickets[2]));
    let actions = 0;
    await assert.rejects(withRemote(async () => { actions++; }, { path, waitMs: 20, createClient: fakeClient }), /no remote action started/);
    assert.equal(actions, 0);
    for (const ticket of tickets) { assert(q.remoteTurn(ticket)); q.remoteDone(ticket); }

    const crashed = child("crash", path);
    await crashed.ready;
    const held = once(crashed.proc, "message"); crashed.proc.send("go");
    assert.equal((await held)[0].phase, "held");
    crashed.proc.kill(); await crashed.exit;
    await withRemote(async () => { actions++; }, { path, createClient: fakeClient });
    assert.equal(actions, 1); assert.equal(q.db.prepare("SELECT count(*) AS n FROM remote_requests").get().n, 0);
    // Known dead legacy owners are recoverable; unknown owners fail closed.
    writeFileSync(join(dir, "remote.lock"), String(crashed.proc.pid));
    await withRemote(async () => {}, { path, createClient: fakeClient });
    writeFileSync(join(dir, "remote.lock"), "");
    await assert.rejects(withRemote(async () => { actions++; }, { path, createClient: fakeClient }), /unknown owner/);
    assert.equal(actions, 1);
    q.close();

    q = new MessageQueue(join(dir, "receipts.sqlite"));
    const id = q.enqueue({ requestId: "long", taskIds: ["sess_long"], prompt: "request" }).messages[0].messageId;
    q.transaction(() => {
      for (let i = 0; i < 4; i++) q.event(q.get(id), "message", { role: "assistant", content: "x".repeat(23000) });
      q.state(q.get(id), "completed");
    });
    const first = q.read({ consumerId: "a", limit: 100 });
    assert(first.hasMore); assert(!first.envelopes[0].receipt.complete);
    assert.throws(() => q.consume(id, first.envelopes[0].lastEvent, "a"), /not read the complete/);
    const other = q.read({ consumerId: "b", limit: 100 });
    const skipped = q.read({ consumerId: "c", after: first.envelopes[0].lastEvent - 1 });
    assert(!skipped.envelopes[0].receipt.complete, "A guessed tail cursor cannot prove delivery");
    const finishRead = (consumerId, page) => {
      while (page.hasMore) page = q.read({ consumerId, after: page.cursor, limit: 100 });
      assert(page.envelopes[0].receipt.complete);
      return q.consume(id, page.envelopes[0].receipt.throughEvent, consumerId);
    };
    assert(!finishRead("a", first).eligibleForPruning);
    assert.equal(q.maintain(LIMITS.records), 0); assert(!q.get(id).pruned_at);
    assert(!finishRead("b", other).eligibleForPruning);
    assert(finishRead("c", q.read({ consumerId: "c", limit: 100 })).eligibleForPruning);
    assert.equal(q.maintain(LIMITS.records), 1); assert(q.get(id).pruned_at);
    q.close();

    q = new MessageQueue(join(dir, "lifecycle.sqlite"));
    q.enqueue({ requestId: "pending", taskIds: ["sess_pending"], prompt: "pending" });
    const launches = [], launch = async reservation => { launches.push(reservation); };
    await Promise.all(Array.from({ length: 12 }, () => startWorker(q, { launch })));
    assert.equal(launches.length, 1, "Reserve before spawning, not after child acquisition");
    const owner = q.acquire(launches[0]); assert(owner);
    q.db.exec("UPDATE worker SET desired=0,paused=1");
    assert(!q.running(owner)); // The old loop decided to exit.
    await startWorker(q, { resume: true, expectedRevision: q.worker().control_revision, launch });
    assert.equal(launches.length, 1);
    await retireWorker(q, owner, { launch });
    assert.equal(launches.length, 2, "Resume during exit gets one replacement");
    assert.equal(q.acquire(launches[0]), null, "An expired launch reservation cannot acquire");
    assert(q.acquire(launches[1]));
    await assert.rejects(startWorker(q, { resume: true, expectedRevision: 0, launch }), /control changed/);
    q.close();

    q = new MessageQueue(join(dir, "status.sqlite"));
    const message = q.enqueue({ requestId: "status", taskIds: ["sess_status"], prompt: "progress" }).messages[0].messageId;
    q.transaction(() => q.state(q.get(message), "acknowledged"));
    let status = "completed", content = "partial", snapshots = 0, scenario = "stale";
    const task = () => ({ taskId: "sess_status", workspacePath: "workspace", workspaceKind: "local", displayStatus: status });
    const connect = action => action({ open: async () => {}, list: async () => ({ tasks: [task()] }), snapshot: async () => {
      snapshots++;
      if (scenario === "stale") status = "running";
      if (scenario === "growing" && snapshots === 2) content += " final";
      return { messages: [{ id: "native-user", role: "user", turnIndex: 1, content: marker(message) + "\nprogress" },
        { id: "native-reply", role: "assistant", turnIndex: 1, content }] };
    } });
    const observe = async () => {
      const cursor = q.get(message).cursor;
      const result = await readMany({ taskIds: ["sess_status"], ...(cursor ? { afterCursors: { sess_status: cursor } } : {}) }, connect);
      q.observe(q.get(message), result.tasks[0]); return result.tasks[0];
    };
    assert.equal((await observe()).task.status, "running"); assert.equal(q.get(message).state, "acknowledged");
    scenario = "growing"; status = "completed"; snapshots = 0;
    assert.equal((await observe()).completionConfirmed, false); assert.equal(q.get(message).state, "acknowledged");
    scenario = "stable";
    assert.equal((await observe()).completionConfirmed, true); assert.equal(q.get(message).state, "completed");
    console.log("zcode-ops concurrency: 4 processes / 80 writes, 12 remote turns, crash recovery, FIFO admission, unread/multi-reader protection, startup/exit races and fresh completion OK");
  } finally {
    clearTimeout(timeout);
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc, "exit"); proc.kill(); await exited; }
    q?.close();
    if (original === undefined) delete process.env.ZCODE_OPS_CONFIG; else process.env.ZCODE_OPS_CONFIG = original;
    rmSync(dir, { recursive: true, force: true });
  }
}
