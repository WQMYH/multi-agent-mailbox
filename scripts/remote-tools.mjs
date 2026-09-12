import { withRemote } from "./remote-client.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { messagePage } from "./remote-messages.mjs";

const text = { type: "string", minLength: 1 };
const target = { taskId: text, workspace: text };
const messageArgs = { afterCursor: text, messageLimit: { type: "integer", minimum: 1, maximum: 500 },
  maxChars: { type: "integer", minimum: 256, maximum: 24000 }, requestMessageId: text };
const taskIds = { type: "array", items: text, minItems: 1, maxItems: 8, uniqueItems: true };
const afterCursors = { type: "object", additionalProperties: text };
const BATCH_CONCURRENCY = 4;
export const remoteTools = [
  ["zcode_remote_tasks", "List real desktop tasks and native run status. Excludes archived tasks by default. Each call is a fresh snapshot; no background monitor is started.", {
    workspace: text, includeArchived: { type: "boolean" }, status: text, limit: { type: "integer", minimum: 1, maximum: 500 }
  }, [], true],
  ["zcode_remote_read", "Read a page of an existing task's messages and native status. Pass cursor as afterCursor to continue without repeating consumed text; hasMore means another page. historyGap means continuity was lost. tailCursor explicitly skips to the current end. completed is not task acceptance.", {
    ...target, ...messageArgs
  }, ["taskId"], true],
  ["zcode_remote_wait", "Wait up to 30 seconds plus request latency. Default mode=status keeps status-only behavior. mode=messages requires a read/send cursor and returns new text or status/pending-input changes. Release connection between polls; timeout is not interruption. Status and message cursors are not interchangeable.", {
    ...target, ...messageArgs, mode: { type: "string", enum: ["status", "messages"] }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 }
  }, ["taskId"], true],
  ["zcode_remote_read_many", "Read up to 8 existing tasks, at most 4 same-workspace snapshots concurrently. One connection at a time; reconnect sequentially between workspaces. Per-task errors preserve successful pages. Pass afterCursors per task to continue; default body budget is 3000 characters per task.", {
    taskIds, afterCursors, messageLimit: { type: "integer", minimum: 1, maximum: 500 }, maxChars: { type: "integer", minimum: 256, maximum: 24000 }
  }, ["taskIds"], true],
  ["zcode_remote_wait_many", "Wait up to 30 seconds plus request latency for changes across up to 8 tasks. Requires afterCursors from read_many. Same-workspace snapshots run concurrently; workspace connections open sequentially, never simultaneously. Per-task errors preserve successes.", {
    taskIds, afterCursors, messageLimit: { type: "integer", minimum: 1, maximum: 500 }, maxChars: { type: "integer", minimum: 256, maximum: 24000 }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 }
  }, ["taskIds", "afterCursors"], true],
  ["zcode_remote_cancel", "Request stopping the current running turn of the user-specified existing desktop task. Uses ZCode stopGeneration; does not kill the application. Acknowledgment is not confirmed cancellation: use zcode_remote_wait/read. Never retry an uncertain stop automatically.", target, ["taskId"], false],
  ["zcode_remote_models", "Read an existing desktop task's current model, thought level, and model options.", target, ["taskId"], true],
  ["zcode_remote_set_model", "Switch an existing idle desktop task to one of its advertised model options. Use zcode_remote_models first; never switch a running turn.", {
    ...target, model: text
  }, ["taskId", "model"], false],
  ["zcode_remote_send", "Send a user-authorized message to an existing local desktop task using its current runtime and settings. Does not create tasks or change models/permissions. A failed or timed-out send may have been delivered: read the task before retrying.", {
    ...target, prompt: { type: "string", minLength: 1, maxLength: 32000 }
  }, ["taskId", "prompt"], false]
].map(([name, description, properties, required, readOnlyHint]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: true }
}));

function nativeExecutionFailure(error) {
  const scalar = value => {
    const result = typeof value === "string" ? value.trim() : Number.isSafeInteger(value) ? String(value) : "";
    return result && result.length <= 128 ? result : null;
  };
  const object = error && typeof error === "object" && !Array.isArray(error) ? error : {};
  const attribution = object.attribution && typeof object.attribution === "object" && !Array.isArray(object.attribution) ? object.attribution : {};
  const integer = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  const outerCode = scalar(typeof error === "string" ? error : object.code), providerCode = scalar(attribution.providerErrorCode);
  const outerReason = scalar(object.reason), providerReason = scalar(attribution.reason);
  const outerStatus = integer(object.statusCode), providerStatus = integer(attribution.statusCode);
  const rateLimited = [outerCode, providerCode].includes("1308") || [outerReason, providerReason].includes("rate_limited") || [outerStatus, providerStatus].includes(429);
  if (rateLimited) {
    const code = providerCode ?? outerCode, statusCode = providerStatus ?? outerStatus;
    const retryable = typeof attribution.retryable === "boolean" ? attribution.retryable : typeof object.retryable === "boolean" ? object.retryable : null;
    const providerId = scalar(attribution.providerId) ?? scalar(object.providerId), modelId = scalar(attribution.modelId) ?? scalar(object.modelId);
    return { stage: "native_execution", source: "provider", reason: "rate_limited", ...(code ? { code } : {}),
      ...(statusCode ? { statusCode } : {}), ...(retryable !== null ? { retryable } : {}),
      ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) };
  }
  if ([outerCode, providerCode].includes("DEVICE_OFFLINE") || [outerReason, providerReason].includes("device_offline")) {
    return { stage: "native_execution", source: "zcode_native", reason: "device_offline", code: "DEVICE_OFFLINE" };
  }
  return { stage: "native_execution", source: "zcode_native", reason: "unknown" };
}

const readFailure = (error, fallback = "snapshot_or_cursor_unavailable") =>
  /\bDEVICE_OFFLINE\b/.test(String(error?.code ?? error?.message ?? error))
    ? { error: "device_offline", code: "DEVICE_OFFLINE" } : { error: fallback };
const taskNotFound = message => Object.assign(Error(message), { code: "ZCODE_TASK_NOT_FOUND" });

export function normalizeTask(t) {
  const rawStatus = t.displayStatus ?? null;
  const statuses = { running: "running", completed: "completed", error: "failed", idle: "idle",
    interrupted: "interrupted", cancelled: "cancelled", compacting: "compacting",
    waiting_permission: "waiting_permission", waiting_input: "waiting_input" };
  const status = Object.hasOwn(statuses, rawStatus) ? statuses[rawStatus] : "unknown";
  return { taskId: t.taskId, title: t.title, workspace: t.workspacePath, workspaceKind: t.workspaceKind,
    rawStatus, status, archived: t.archived === true, pinned: t.pinned === true, updatedAt: t.updatedAt,
    turnEnded: ["completed", "failed", "cancelled", "interrupted"].includes(status),
    ...(status === "failed" ? { nativeExecutionFailure: nativeExecutionFailure(t.lastError ?? t.error) } : {}) };
}
export function validateRemoteArgs(name, args) {
  const tool = remoteTools.find(t => t.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid remote tool arguments");
  const schema = tool.inputSchema;
  for (const key of schema.required) if (!(key in args)) throw Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw Error(`Unexpected argument ${key}`);
    if (rule.type === "string" && (typeof value !== "string" || !value.trim() || value.length > (rule.maxLength || 4096))) throw Error(`Invalid ${key}`);
    if (rule.type === "boolean" && typeof value !== "boolean") throw Error(`Invalid ${key}`);
    if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw Error(`Invalid ${key}`);
    if (rule.enum && !rule.enum.includes(value)) throw Error(`Invalid ${key}`);
    if (rule.type === "array" && (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems ||
        value.some(item => typeof item !== "string" || !item.trim() || item.length > 4096))) throw Error(`Invalid ${key}`);
    if (rule.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).length > 8 || Object.values(value).some(item => typeof item !== "string" || !item.trim() || item.length > 4096))) throw Error(`Invalid ${key}`);
  }
  if (args.taskId && !/^sess_[a-zA-Z0-9-]+$/.test(args.taskId)) throw Error("Expected a native sess_ task ID");
  if (Array.isArray(args.taskIds) && args.taskIds.some(id => !/^sess_[a-zA-Z0-9-]+$/.test(id))) throw Error("Expected native sess_ task IDs");
  if (args.taskIds && new Set(args.taskIds).size !== args.taskIds.length) throw Error("Duplicate task IDs");
  if (name === "zcode_remote_wait" && args.mode === "messages" && !args.afterCursor) throw Error("Message waiting requires afterCursor from read/send");
  if (name === "zcode_remote_wait" && args.mode !== "messages" &&
      ["messageLimit", "maxChars", "requestMessageId"].some(key => key in args)) throw Error("Message options require mode=messages");
  if (name === "zcode_remote_wait" && args.mode !== "messages" && args.afterCursor) {
    let cursor;
    try { cursor = JSON.parse(args.afterCursor); } catch {}
    if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== args.taskId ||
        (args.workspace && cursor[1] !== args.workspace)) throw Error("Invalid status cursor; message cursors require mode=messages");
  }
}

function modelState(configOptions) {
  const options = Array.isArray(configOptions) ? configOptions : configOptions?.configOptions;
  const config = options?.find(option => option.id === "model" || option.category === "model");
  if (!config || !Array.isArray(config.options)) throw Error("ZCode did not return model options for this task");
  const thought = options.find(option => option.id === "thoughtLevel" || option.category === "thought_level");
  return {
    currentModel: config.currentValue ?? null,
    thoughtLevel: thought?.currentValue ?? null,
    configId: config.id,
    models: config.options.map(option => ({ value: option.value, name: option.name,
      providerName: option.modelProviderName ?? null, thoughtLevels: option.modelThoughtLevels ?? [],
      defaultThoughtLevel: option.modelDefaultThoughtLevel ?? null }))
  };
}

async function openWorkspace(client, task, tasks) {
  let failure;
  for (const anchor of [task, ...tasks.filter(candidate => candidate.taskId !== task.taskId && candidate.workspacePath === task.workspacePath && candidate.workspaceKind === task.workspaceKind && !candidate.archived)]) {
    try { await client.open(anchor); return; } catch (error) { failure = error; }
  }
  throw failure ?? Error("No task can attach this workspace bridge");
}

async function readTaskPage(client, task, args) {
  const initialTask = normalizeTask(task);
  const read = async () => {
    const snapshot = await client.snapshot(task.taskId, args.messageLimit ?? 100);
    // Inventory used to locate the workspace is not a current completion signal.
    const fresh = (await client.list()).tasks.find(t => t.taskId === task.taskId && t.workspacePath === task.workspacePath);
    if (!fresh) throw taskNotFound("Task disappeared or moved while reading");
    return { snapshot, fresh, page: { task: normalizeTask(fresh), ...messagePage(snapshot, fresh, args) } };
  };
  const { page } = await read();
  if (page.task.status !== "completed" || page.task.archived || page.hasMore) return { ...page, completionConfirmed: false };
  // Confirm the final tail after observing completion; a partial snapshot followed by
  // a terminal list response must not release the next queued message.
  const latest = await read(), confirmed = latest.page;
  const failedWithoutReply = initialTask.status === "failed" && confirmed.task.status === "completed" && !confirmed.assistantTextReturned;
  if (failedWithoutReply) return { ...confirmed,
    ...messagePage(latest.snapshot, { ...latest.fresh, displayStatus: task.displayStatus, archived: task.archived }, args),
    task: initialTask, observedLatestTask: confirmed.task, completionConfirmed: false };
  return { ...confirmed, completionConfirmed: confirmed.task.status === "completed" && !confirmed.task.archived &&
    !confirmed.hasMore && !confirmed.historyGap && !confirmed.pendingPermissions && !confirmed.pendingQuestions && !confirmed.pendingCommands &&
    page.tailCursor === confirmed.tailCursor && page.snapshotMessageCount === confirmed.snapshotMessageCount &&
    page.task.updatedAt === confirmed.task.updatedAt };
}

export async function callRemoteTool(name, args = {}, connect = withRemote) {
  validateRemoteArgs(name, args);
  if (name === "zcode_remote_read_many") return readMany(args, connect);
  if (name === "zcode_remote_wait_many") return waitForMany(args, connect);
  if (name === "zcode_remote_wait") return args.mode === "messages" ? waitForMessages(args, connect) : waitForTask(args, connect);
  return connect(async client => {
    const list = await client.list();
    const base = { source: "zcode_desktop_remote", queriedAt: new Date().toISOString() };
    if (name === "zcode_remote_tasks") {
      const tasks = list.tasks.map(normalizeTask).filter(t => (args.includeArchived || !t.archived) &&
        (!args.workspace || t.workspace === args.workspace) && (!args.status || t.status === args.status));
      const summary = {};
      for (const t of tasks) summary[t.status] = (summary[t.status] || 0) + 1;
      const limit = args.limit ?? 100;
      return { ...base, total: tasks.length, summary, truncated: tasks.length > limit,
        workspaces: list.workspaces.map(w => ({ label: w.label, path: w.workspacePath, kind: w.kind })), tasks: tasks.slice(0, limit) };
    }
    const task = list.tasks.find(t => t.taskId === args.taskId && (!args.workspace || t.workspacePath === args.workspace));
    if (!task) throw taskNotFound("Task not found in the current desktop window/workspace");
    if (["zcode_remote_send", "zcode_remote_set_model", "zcode_remote_cancel"].includes(name) && task.archived) throw Error("Unarchive the task in ZCode before changing it");
    if (name === "zcode_remote_cancel" && task.displayStatus !== "running") return { ...base, task: normalizeTask(task), cancellation: "not_running", requested: false };
    if (name === "zcode_remote_set_model" && task.displayStatus === "running") throw Error("Wait for or stop the running turn before switching its model");
    await openWorkspace(client, task, list.tasks);
    if (name === "zcode_remote_cancel") {
      const fresh = (await client.list()).tasks.find(candidate => candidate.taskId === task.taskId && candidate.workspacePath === task.workspacePath);
      if (!fresh || fresh.archived || fresh.displayStatus !== "running") return { ...base, task: fresh ? normalizeTask(fresh) : null, cancellation: "not_running", requested: false };
      try {
        const result = await client.stop(fresh);
        if (result?.isError || result?.error || result?.accepted === false) throw Error("Desktop rejected stop");
        return { ...base, task: normalizeTask(fresh), cancellation: "cancel_requested", requested: true,
          note: "Stop acknowledged; task termination is not yet confirmed. Use zcode_remote_wait/read." };
      } catch {
        throw Error("Stop was not confirmed; delivery is unknown. Read the task before retrying. No automatic retry was made.");
      }
    }
    if (name === "zcode_remote_models" || name === "zcode_remote_set_model") {
      let before, optionsSourceTaskId = task.taskId, unavailableCurrentModel = false, failure;
      try { before = modelState(await client.configOptions(task.taskId)); }
      catch (error) {
        failure = error;
        for (const sibling of list.tasks.filter(candidate => candidate.taskId !== task.taskId && candidate.workspacePath === task.workspacePath && !candidate.archived)) {
          try {
            before = { ...modelState(await client.configOptions(sibling.taskId)), currentModel: null, thoughtLevel: null };
            optionsSourceTaskId = sibling.taskId; unavailableCurrentModel = true; break;
          } catch {}
        }
      }
      if (!before) throw failure;
      if (name === "zcode_remote_models") return { ...base, task: normalizeTask(task), ...before, optionsSourceTaskId, unavailableCurrentModel };
      const matches = before.models.filter(model => model.value === args.model || model.name === args.model);
      if (matches.length !== 1) throw Error(matches.length ? "Model name is ambiguous; use its full value" : "Model is not advertised for this task");
      const selected = matches[0];
      if (before.currentModel === selected.value) return { ...base, task: normalizeTask(task), changed: false, currentModel: selected.value };
      try { await client.setModel(task.taskId, before.configId, selected.value); }
      catch (error) {
        if (!/Session is not active/i.test(String(error?.message))) throw error;
        await client.resume(task, selected.value, selected.defaultThoughtLevel ?? selected.thoughtLevels.at(-1) ?? "max");
      }
      const after = modelState(await client.configOptions(task.taskId));
      if (after.currentModel !== selected.value) throw Error("ZCode did not confirm the requested model switch");
      return { ...base, task: normalizeTask(task), changed: true, previousModel: before.currentModel, currentModel: after.currentModel,
        optionsSourceTaskId, recoveredUnavailableModel: unavailableCurrentModel };
    }
    if (name === "zcode_remote_read") {
      return { ...base, ...await readTaskPage(client, task, args) };
    }
    // Capture before send, so even a very fast reply remains after this checkpoint.
    // Failure here occurs before any prompt is sent.
    const baseline = messagePage(await client.snapshot(task.taskId, 100), task);
    try {
      const sent = await client.send(task.taskId, args.prompt);
      if (sent.result?.isError || sent.result?.error || sent.result?.accepted === false) throw Error("Desktop rejected prompt");
      return { ...base, task: normalizeTask(task), delivery: "acknowledged", request: sent.request, cursor: baseline.tailCursor,
        note: "Send acknowledged, not completion. Use read or wait mode=messages with this cursor and requestMessageId=request.messageId. A new message is not necessarily a correlated reply." };
    } catch {
      throw Error("Send was not confirmed; delivery is unknown. Read this task before retrying. No automatic retry was made.");
    }
  });
}

function batchTask(list, id) {
  return list.tasks.find(task => task.taskId === id);
}

async function parallelLimit(items, limit, action) {
  const results = new Array(items.length); let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await action(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function readMany(args, connect = withRemote) {
  const cursors = args.afterCursors ?? {};
  let list, missing, groups;
  const results = [], errors = [], isolatedReads = [];
  async function readGroup(client, group) {
    try { await openWorkspace(client, group[0], list.tasks); }
    catch (error) { errors.push(...group.map(task => ({ taskId: task.taskId, ...readFailure(error, "workspace_unavailable") }))); return; }
    const pages = await parallelLimit(group, BATCH_CONCURRENCY, async task => {
      try {
        return await readTaskPage(client, task, { ...args, afterCursor: cursors[task.taskId], maxChars: args.maxChars ?? 3000 });
      } catch (error) {
        if (group.length > 1) isolatedReads.push(task);
        else errors.push({ taskId: task.taskId, ...readFailure(error) });
        return null;
      }
    });
    results.push(...pages.filter(Boolean));
  }
  await connect(async client => {
    list = await client.list();
    const selected = args.taskIds.map(taskId => batchTask(list, taskId));
    missing = args.taskIds.filter((taskId, index) => !selected[index]);
    const grouped = new Map();
    for (const task of selected.filter(Boolean)) {
      const key = `${task.workspaceKind ?? "local"}:${task.workspacePath}`;
      const group = grouped.get(key) ?? []; group.push(task); grouped.set(key, group);
    }
    groups = [...grouped.values()];
    if (groups.length) await readGroup(client, groups.shift());
  });
  // Reopening a bridge on the same connection stalled in native testing.
  // Switch workspaces by closing first, then connecting; never two terminals at once.
  // A stalled RPC can poison its shared bridge, including another task's final
  // confirmation. Retry failed READS once on isolated connections, with the same
  // cursors and completion checks. Never replay sends or accept a partial result.
  while (groups.length || isolatedReads.length) {
    const group = groups.shift() ?? [isolatedReads.shift()];
    try { await connect(client => readGroup(client, group)); }
    catch (error) { errors.push(...group.map(task => ({ taskId: task.taskId, ...readFailure(error, "connection_unavailable") }))); }
  }
  return { source: "zcode_desktop_remote", queriedAt: new Date().toISOString(),
    requested: args.taskIds.length, missing, errors, tasks: results,
    cursors: Object.fromEntries(results.map(row => [row.task.taskId, row.cursor])) };
}

export async function waitForMany(args, connect = withRemote, { now = Date.now, delay = sleep } = {}) {
  for (const taskId of args.taskIds) if (typeof args.afterCursors[taskId] !== "string") {
    throw Error(`Missing afterCursor for ${taskId}; call zcode_remote_read_many first`);
  }
  const started = now(), deadline = started + (args.timeoutMs ?? 30000);
  const cursors = { ...args.afterCursors };
  for (;;) {
    const page = await readMany({ ...args, afterCursors: cursors }, connect);
    let changed = page.missing.length > 0 || page.errors.length > 0;
    for (const row of page.tasks) {
      if (row.messageCount > 0 || row.stateChanged || row.historyGap) changed = true;
      cursors[row.task.taskId] = row.cursor;
    }
    const timedOut = !changed && now() >= deadline;
    if (changed || timedOut) return { ...page, cursors, changed, timedOut,
      reason: page.missing.length ? "not_found" : page.errors.length ? "error" : changed ? "changed" : "timeout", elapsedMs: now() - started };
    await delay(Math.max(0, Math.min(2000, deadline - now())));
  }
}

export async function waitForMessages(args, connect, { now = Date.now, delay = sleep } = {}) {
  const started = now(), deadline = started + (args.timeoutMs ?? 30000);
  const { timeoutMs, mode, ...readArgs } = args;
  for (;;) {
    const page = await callRemoteTool("zcode_remote_read", readArgs, connect);
    const reason = page.historyGap ? "history_gap" : page.messageCount ? "messages" : page.stateChanged ? "state_changed" : "timeout";
    if (reason !== "timeout" || now() >= deadline) return { ...page, reason,
      changed: page.messageCount > 0 || page.stateChanged, timedOut: reason === "timeout", elapsedMs: now() - started };
    await delay(Math.max(0, Math.min(2000, deadline - now())));
  }
}

// ponytail: bounded list polling; use native event subscription if polling cost becomes material.
export async function waitForTask(args, connect, { now = Date.now, delay = sleep } = {}) {
  const started = now(), deadline = started + (args.timeoutMs ?? 30000);
  let baseline = args.afterCursor;
  for (;;) {
    const task = await connect(async client => {
      const list = await client.list();
      const row = list.tasks.find(t => t.taskId === args.taskId && (!args.workspace || t.workspacePath === args.workspace));
      return row ? normalizeTask(row) : null;
    });
    // Status cursor deliberately excludes updatedAt: streamed tokens should not wake a status wait.
    const cursor = JSON.stringify([args.taskId, task?.workspace ?? args.workspace ?? null, task?.rawStatus ?? null, task?.archived ?? null]);
    const changed = baseline !== undefined && cursor !== baseline;
    baseline ??= cursor;
    const settled = task && !["running", "compacting"].includes(task.status);
    const elapsedMs = now() - started;
    if (!task || changed || settled || now() >= deadline) return {
      source: "zcode_desktop_remote", queriedAt: new Date().toISOString(), task, cursor, changed, elapsedMs,
      reason: !task ? "not_found" : changed ? "status_changed" : task.status === "unknown" ? "status_unknown" : settled ? "not_running" : "timeout",
      timedOut: !!task && !changed && !settled && now() >= deadline
    };
    await delay(Math.min(2000, deadline - now()));
  }
}
