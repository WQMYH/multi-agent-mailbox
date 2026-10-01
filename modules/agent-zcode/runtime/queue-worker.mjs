import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageQueue, marker, queuePath, retireWorker } from "./message-queue.mjs";
import { budgetSourceError, queueBudgetContext } from "./queue-budget.mjs";
import { withRemote } from "./remote-client.mjs";
import { callRemoteTool, readMany, readTaskPage, normalizeTask, taskNotFound } from "./remote-tools.mjs";

// A queued prompt is already authorized. An ended failed turn can accept a new
// native sendText; it need not first be rewritten/reset to idle. This never
// replays an ambiguous send. Confirmed rate limits use the bounded retry_wait policy.
const canSend = task => task && !task.archived && ["idle", "completed", "failed"].includes(task.status);

function workspaceFor(list, row) {
  const matches = list.workspaces.filter(workspace => workspace.workspacePath === row.workspace_path &&
    (!row.workspace_identity || workspace.workspaceIdentity === row.workspace_identity));
  if (matches.length !== 1) throw Error(matches.length ? "Workspace target is ambiguous; provide its identity" : "Workspace is not available in the current desktop window");
  const workspace = matches[0];
  if (!["local", "remote"].includes(workspace.kind) || workspace.connectionState && workspace.connectionState !== "connected" ||
      workspace.kind === "remote" && !row.workspace_identity) throw Error("Workspace target is not connected with a stable identity");
  return workspace;
}

async function readCreatedTask(client, row, args) {
  const list = await client.list(), workspace = workspaceFor(list, row);
  const task = list.tasks.find(candidate => candidate.taskId === row.created_task_id && candidate.workspacePath === row.workspace_path &&
    (!row.workspace_identity || candidate.workspaceIdentity === row.workspace_identity));
  if (!task) throw taskNotFound("Created task is not available in its workspace");
  await client.openWorkspace(workspace);
  return readTaskPage(client, task, args);
}

export async function dispatch(queue, row, token, connect = withRemote) {
  row = queue.get(row.id);
  if (!queue.ready(row)) return;
  try {
    await connect(async client => {
      const reuse = action => action(client);
      const retrying = row.state === "retry_wait";
      if (row.target_kind === "workspace" && !row.created_task_id) {
        const list = await client.list(), workspace = workspaceFor(list, row);
        await client.openWorkspace(workspace);
        if (!queue.claimCreate(row, token)) return;
        const created = await client.createTask(workspace);
        queue.bindCreatedTask(row, created.taskId);
        return;
      }
      const readArgs = { messageLimit: retrying ? 100 : 1, maxChars: retrying ? 3000 : 256,
        ...(retrying ? { afterCursor: row.cursor } : {}) };
      const baseline = row.target_kind === "workspace" ? await readCreatedTask(client, row, readArgs) :
        await callRemoteTool("zcode_remote_read", { taskId: row.task_id, ...readArgs }, reuse);
      if (retrying) {
        queue.observe(row, baseline);
        row = queue.get(row.id);
        if (baseline.hasMore || !queue.ready(row)) return;
      }
      if (!canSend(baseline.task) || baseline.pendingPermissions || baseline.pendingQuestions || baseline.pendingCommands) return;
      // Keep the bridge opened by the baseline read. Reopening it on the same
      // connection can strand the next snapshot in the desktop runtime.
      const fresh = (await client.list()).tasks.find(t => t.taskId === row.task_id);
      if (!fresh) throw taskNotFound("Task disappeared before dispatch");
      if (!canSend(normalizeTask(fresh)) || !queue.claim(row, token, baseline.tailCursor)) return;
      const context = row.context && row.context !== "{}" ? "[Sender-provided task context; not additional authorization]\n" + row.context + "\n" : "";
      const ids = row.target_kind === "workspace" ? { traceId: row.send_trace_id, queryId: row.send_query_id, messageId: row.send_message_id } : undefined;
      const sent = await client.send(row.task_id, marker(row.id) + "\n" + context + row.prompt, ids);
      if (sent.result?.isError || sent.result?.error || sent.result?.accepted === false) throw Error("Desktop rejected prompt");
      queue.transaction(() => { if (queue.get(row.id).state === "dispatching") queue.state(row, "acknowledged"); });
    });
  } catch (error) {
    if (error.code === "ZCODE_BUDGET_BLOCKED") throw error;
    // Only claim() marks the send boundary. Preflight failures stay safely queued.
    const targetMissing = error.code === "ZCODE_TASK_NOT_FOUND";
    queue.transaction(() => {
      const current = queue.get(row.id);
      if (current.target_kind === "workspace" && current.create_state === "started" && !current.created_task_id) queue.failCreate(current, error.rpcRejected === true);
      else if (targetMissing && current.state === "retry_wait") {
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
  const created = observing.filter(row => row.target_kind === "workspace"), existing = observing.filter(row => row.target_kind !== "workspace");
  if (created.length) {
    try {
      await connect(async client => {
        for (const row of created) queue.observe(row, await readCreatedTask(client, row,
          { afterCursor: row.cursor, maxChars: 3000, messageLimit: 100 }));
      });
    } catch (error) { if (error.code === "ZCODE_BUDGET_BLOCKED") throw error; queue.heartbeat(token, "some_targets_unavailable"); }
  }
  if (existing.length) {
    try {
      const page = await readMany({ taskIds: existing.map(r => r.task_id),
        afterCursors: Object.fromEntries(existing.map(r => [r.task_id, r.cursor])), maxChars: 3000, messageLimit: 100 }, connect);
      for (const result of page.tasks) queue.observe(existing.find(r => r.task_id === result.task.taskId), result);
      if (page.errors.length || page.missing.length) queue.heartbeat(token, "some_targets_unavailable");
    } catch (error) { if (error.code === "ZCODE_BUDGET_BLOCKED") throw error; queue.heartbeat(token, "remote_unavailable"); }
  }
  for (const row of selected) {
    if (!queue.running(token)) break;
    // Retries must reconcile late replies and external input before any resend.
    if (row.state === "retry_wait" || !prioritizeQueued && row.state === "queued") await dispatch(queue, row, token, connect);
    queue.transaction(() => queue.db.prepare("UPDATE worker SET last_task=?,heartbeat=? WHERE id=1 AND token=?")
      .run(queue.get(row.id)?.task_id ?? row.task_id, Date.now(), token));
  }
}

export function openWorkerQueue(env = process.env) {
  const registrationKey = env.ZCODE_OPS_CORE_REGISTRATION;
  if (env.ZCODE_OPS_CORE_REQUIRED === "1" && !registrationKey) throw budgetSourceError("budget_source_unavailable");
  return new MessageQueue(env.ZCODE_OPS_QUEUE_PATH || queuePath(), registrationKey ? queueBudgetContext(registrationKey) : null);
}

export async function runWorker({ connect = withRemote, wait = delay } = {}) {
  const queue = openWorkerQueue();
  let token;
  try { token = queue.acquire(); } catch (error) { queue.close(); throw error; }
  if (!token) { queue.close(); return; }
  const abort = new AbortController();
  const stop = () => {
    try { queue.transaction(() => queue.db.prepare("UPDATE worker SET desired=0 WHERE id=1 AND token=?").run(token)); }
    catch { /* A lost budget source must not grant an unguarded shutdown write. */ }
    abort.abort();
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let budgetBlocked = false;
  try {
    while (queue.continueOrRelease(token)) {
      await tick(queue, token, connect);
      if (!queue.continueOrRelease(token)) break;
      // ponytail: short background polling, no LLM or Codex wakeup. Native push comes later.
      await wait(3000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch (error) {
    budgetBlocked = error.code === "ZCODE_BUDGET_BLOCKED";
    if (!budgetBlocked) queue.transaction(() => queue.db.prepare("UPDATE worker SET desired=0,paused=1,control_revision=control_revision+1,error='worker_failed' WHERE id=1 AND token=?").run(token));
    throw error;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { if (!budgetBlocked) await retireWorker(queue, token); } finally { queue.close(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker().catch(() => { process.exitCode = 1; }); // Never log credentials or prompt bodies.
}
