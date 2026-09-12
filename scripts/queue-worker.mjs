import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageQueue, marker, retireWorker } from "./message-queue.mjs";
import { withRemote } from "./remote-client.mjs";
import { callRemoteTool, readMany, normalizeTask } from "./remote-tools.mjs";

// A queued prompt is already authorized. An ended failed turn can accept a new
// native sendText; it need not first be rewritten/reset to idle. This never
// replays an ambiguous send. Confirmed rate limits use the bounded retry_wait policy.
const canSend = task => task && !task.archived && ["idle", "completed", "failed"].includes(task.status);

export async function dispatch(queue, row, token, connect = withRemote) {
  row = queue.get(row.id);
  if (!queue.ready(row)) return;
  try {
    await connect(async client => {
      const reuse = action => action(client);
      const retrying = row.state === "retry_wait";
      const baseline = await callRemoteTool("zcode_remote_read", { taskId: row.task_id,
        messageLimit: retrying ? 100 : 1, maxChars: retrying ? 3000 : 256,
        ...(retrying ? { afterCursor: row.cursor } : {}) }, reuse);
      if (retrying) {
        queue.observe(row, baseline);
        row = queue.get(row.id);
        if (baseline.hasMore || !queue.ready(row)) return;
      }
      if (!canSend(baseline.task) || baseline.pendingPermissions || baseline.pendingQuestions || baseline.pendingCommands) return;
      // Keep the bridge opened by the baseline read. Reopening it on the same
      // connection can strand the next snapshot in the desktop runtime.
      const fresh = (await client.list()).tasks.find(t => t.taskId === row.task_id);
      if (!canSend(fresh && normalizeTask(fresh)) || !queue.claim(row, token, baseline.tailCursor)) return;
      const context = row.context && row.context !== "{}" ? "[Sender-provided task context; not additional authorization]\n" + row.context + "\n" : "";
      const sent = await client.send(row.task_id, marker(row.id) + "\n" + context + row.prompt);
      if (sent.result?.isError || sent.result?.error || sent.result?.accepted === false) throw Error("Desktop rejected prompt");
      queue.transaction(() => { if (queue.get(row.id).state === "dispatching") queue.state(row, "acknowledged"); });
    });
  } catch (error) {
    // Only claim() marks the send boundary. Preflight failures stay safely queued.
    const targetMissing = error.code === "ZCODE_TASK_NOT_FOUND";
    queue.transaction(() => {
      const current = queue.get(row.id);
      if (targetMissing && current.state === "retry_wait") {
        queue.db.prepare("UPDATE messages SET retry_at=NULL WHERE id=?").run(row.id);
        queue.state(current, "needs_attention");
        queue.event(current, "retry_stopped", { reason: "target_not_found", businessAccepted: false });
      } else if (current.state === "dispatching") queue.state(current, "uncertain");
    });
    queue.heartbeat(token, targetMissing ? "retry_target_not_found" : "remote_or_dispatch_unavailable");
  }
}

export async function tick(queue, token, connect = withRemote) {
  if (!queue.running(token)) return;
  queue.heartbeat(token);
  const heads = queue.heads(), last = heads.findIndex(r => r.task_id === queue.worker().last_task);
  const selected = [...heads.slice(last + 1), ...heads.slice(0, last + 1)].slice(0, 8);
  const prioritizeQueued = queue.worker().rate_until === 0;
  // Fresh FIFO heads must not wait for unrelated long reply snapshots. Every
  // dispatch still checks current native status, ownership and shared cooldown.
  for (const row of selected) {
    if (!queue.running(token)) return;
    if (prioritizeQueued && row.state === "queued") await dispatch(queue, row, token, connect);
  }
  const observing = selected.filter(r => ["acknowledged", "uncertain", "retry_wait"].includes(r.state) && r.cursor);
  if (observing.length) {
    try {
      const page = await readMany({ taskIds: observing.map(r => r.task_id),
        afterCursors: Object.fromEntries(observing.map(r => [r.task_id, r.cursor])), maxChars: 3000, messageLimit: 100 }, connect);
      for (const result of page.tasks) queue.observe(observing.find(r => r.task_id === result.task.taskId), result);
      if (page.errors.length || page.missing.length) queue.heartbeat(token, "some_targets_unavailable");
    } catch { queue.heartbeat(token, "remote_unavailable"); }
  }
  for (const row of selected) {
    if (!queue.running(token)) break;
    // Retries must reconcile late replies and external input before any resend.
    if (row.state === "retry_wait" || !prioritizeQueued && row.state === "queued") await dispatch(queue, row, token, connect);
    queue.db.prepare("UPDATE worker SET last_task=?,heartbeat=? WHERE id=1 AND token=?").run(row.task_id, Date.now(), token);
  }
}

async function main() {
  const queue = new MessageQueue();
  const token = queue.acquire();
  if (!token) { queue.close(); return; }
  const abort = new AbortController();
  const stop = () => { queue.db.prepare("UPDATE worker SET desired=0 WHERE id=1 AND token=?").run(token); abort.abort(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    while (queue.continueOrRelease(token)) {
      await tick(queue, token);
      if (!queue.continueOrRelease(token)) break;
      // ponytail: short background polling, no LLM or Codex wakeup. Native push comes later.
      await delay(3000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch (error) {
    queue.transaction(() => queue.db.prepare("UPDATE worker SET desired=0,paused=1,control_revision=control_revision+1,error='worker_failed' WHERE id=1 AND token=?").run(token));
    throw error;
  } finally { try { await retireWorker(queue, token); } finally { queue.close(); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.exitCode = 1; }); // Never log credentials or prompt bodies.
}
