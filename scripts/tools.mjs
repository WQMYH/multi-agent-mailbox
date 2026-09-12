import { setTimeout as sleep } from "node:timers/promises";
import { remoteTools, callRemoteTool } from "./remote-tools.mjs";
import { queueTools, callQueueTool, normalizeContext } from "./message-queue.mjs";
import { configTools, callConfigTool } from "./config.mjs";

const text = { type: "string", minLength: 1, maxLength: 4096 };
const definition = (name, description, properties, required, readOnlyHint) => ({ name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: true } });
const renamed = (tools, old, name) => ({ ...tools.find(t => t.name === old), name });
export const publicTools = [
  renamed(remoteTools, "zcode_remote_tasks", "zcode_tasks"),
  definition("zcode_read", "Read one/many desktop conversations or the durable inbox for queued sends. Default view: conversation with taskIds, otherwise inbox. Inbox exposes blockedReason/blockedByMessageId/blockedByState for same-task FIFO, including older blockers outside a team filter. Inbox optionally takes a stable consumerId (such as your Codex task ID) to track this reader; required before acknowledgement. Omit it for an unprotected observer read. Keep the SAME view/filters/consumerId with the opaque cursor. waitMs waits for changes; tailCursor skips conversation history. No worker startup or sends.", {
    view: { type: "string", enum: ["conversation", "inbox"] },
    taskIds: remoteTools.find(t => t.name === "zcode_remote_read_many").inputSchema.properties.taskIds,
    teamId: { ...text, maxLength: 128 }, consumerId: { ...text, maxLength: 128 }, cursor: { ...text, maxLength: 65536 },
    waitMs: { type: "integer", minimum: 0, maximum: 30000 }, messageLimit: { type: "integer", minimum: 1, maximum: 500 }
  }, [], true),
  definition("zcode_send", "Send an authorized prompt to 1-8 explicit existing tasks through the SAME durable queue. An ended failed turn accepts a queued continuation automatically; no separate recovery approval or idle reset. Running/cancelled/interrupted tasks and pending inputs still wait; uncertain deliveries are never resent. Confirmed native rate limits retry in the background at least 300s apart, at most five retries per message, with queue-wide cooldown. Success stops retries but preserves the count; new messages have independent budgets, even in the same conversation. External input during cooldown retires the old retry, not later authorized messages. Read inbox for retry_wait or temporarily_blocked; do not count down or replace a rate-limited request to reset its budget. Optional context carries sender-declared origin, goal, constraints and references, not extra authorization. Prompt plus context <=40000 UTF-8 bytes. Returns receipts, not model replies; starts delivery unless paused. Retry the SAME requestId with identical content; pruned request dedup records expire after 7 days. Completed is not business acceptance.",
    queueTools.find(t => t.name === "zcode_queue_enqueue").inputSchema.properties, ["requestId", "taskIds", "prompt"], false),
  definition("zcode_control", "pause/resume affects ALL teams: requires scope=all and the latest inbox worker.controlRevision as expectedRevision. cancel_message is for unsent items; release_message for reviewed blocked items. Resolving a head wakes delivery of existing followers when already requested and not paused. acknowledge_message requires consumerId, messageId and a fully read envelope.receipt.throughEvent; all registered readers must confirm before cleanup, not business acceptance. stop_task stops native generation only; pause first to prevent queued sends.", {
    action: { type: "string", enum: ["pause", "resume", "cancel_message", "release_message", "stop_task", "acknowledge_message"] }, taskId: text, messageId: { ...text, maxLength: 128 },
    throughEvent: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, consumerId: { ...text, maxLength: 128 },
    scope: { type: "string", enum: ["all"] }, expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }, ["action"], false),
  renamed(remoteTools, "zcode_remote_models", "zcode_models"),
  renamed(remoteTools, "zcode_remote_set_model", "zcode_set_model"),
  configTools.find(t => t.name === "zcode_config_status"),
  definition("zcode_config_set", "Save the user-provided Sharing Link without contacting ZCode, or explicitly clear it with sharingLink:null. Never request a link on app startup.", {
    sharingLink: { type: ["string", "null"], minLength: 1, maxLength: 4096 }
  }, ["sharingLink"], false)
];

function validate(name, args) {
  const schema = publicTools.find(t => t.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid tool arguments");
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const r = schema.properties[key];
    if (!r) throw Error(`Unexpected ${key}`);
    const types = Array.isArray(r.type) ? r.type : [r.type];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (!types.includes(type) || r.enum && !r.enum.includes(value) || type === "string" && (!value.trim() || value.length > (r.maxLength ?? 4096)) ||
      type === "integer" && (!Number.isSafeInteger(value) || value < r.minimum || value > r.maximum) ||
      type === "array" && (value.length < 1 || value.length > 8 || new Set(value).size !== value.length || value.some(v => typeof v !== "string" || v.length > 128 || !/^sess_[a-zA-Z0-9-]+$/.test(v)))) throw Error(`Invalid ${key}`);
  }
  if (Object.hasOwn(args, "context")) normalizeContext(args.context);
}

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function position(cursor, scope) {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (value.v !== 1 || JSON.stringify(value.scope) !== JSON.stringify(scope)) throw Error();
    return value.position;
  } catch { throw Error("Invalid cursor or changed view/recipients; keep the same read filters"); }
}

export async function callPublicTool(name, args = {}, { remote = callRemoteTool, queue = callQueueTool, config = callConfigTool, now = Date.now, delay = sleep } = {}) {
  validate(name, args);
  if (name === "zcode_config_set") return config(args.sharingLink === null ? "zcode_config_clear" : name, args.sharingLink === null ? {} : args);
  if (name === "zcode_config_status") return config(name, args);
  if (name === "zcode_send") return queue("zcode_queue_send", args);
  if (name === "zcode_control") {
    const { action, taskId, messageId, throughEvent, consumerId, scope, expectedRevision } = args;
    if (!["pause", "resume"].includes(action) && (scope !== undefined || expectedRevision !== undefined)) throw Error("scope and expectedRevision apply only to pause/resume");
    if (action === "acknowledge_message") {
      if (!messageId || taskId || !throughEvent || !consumerId) throw Error("acknowledge_message requires messageId, consumerId and throughEvent");
      return queue("zcode_queue_resolve", { messageId, decision: "received", throughEvent, consumerId });
    }
    if (throughEvent !== undefined || consumerId !== undefined) throw Error("throughEvent and consumerId apply only to acknowledge_message");
    if (action === "stop_task") {
      if (!taskId || messageId) throw Error("stop_task requires only taskId");
      return remote("zcode_remote_cancel", { taskId });
    }
    if (["pause", "resume"].includes(action)) {
      if (taskId || messageId) throw Error("pause/resume controls the worker, not a task");
      if (scope !== "all" || expectedRevision === undefined) throw Error("pause/resume affects all teams; pass scope=all and the latest worker.controlRevision as expectedRevision");
      return queue("zcode_queue_control", { action: action === "pause" ? "stop" : "start", scope, expectedRevision });
    }
    if (!messageId || taskId) throw Error("Message control requires only messageId");
    return queue("zcode_queue_resolve", { messageId, decision: action === "cancel_message" ? "cancel" : "release" });
  }
  const mapped = { zcode_tasks: "zcode_remote_tasks", zcode_models: "zcode_remote_models", zcode_set_model: "zcode_remote_set_model" }[name];
  if (mapped) return remote(mapped, args);
  const view = args.view ?? (args.taskIds ? "conversation" : "inbox");
  if (view === "conversation" && (!args.taskIds || args.teamId)) throw Error("conversation requires taskIds and no teamId");
  if (view === "conversation" && args.consumerId) throw Error("consumerId applies only to inbox view");
  if (view === "inbox" && args.messageLimit) throw Error("messageLimit applies only to conversation view");
  const scope = { view, taskIds: [...(args.taskIds ?? [])].sort(), teamId: args.teamId ?? null, ...(args.consumerId ? { consumerId: args.consumerId } : {}) };
  const after = position(args.cursor, scope);
  if (args.waitMs && !args.cursor) throw Error("Read once before waiting; pass its cursor");
  const wrap = (page, next) => ({ ...page, view, cursor: encode({ v: 1, scope, position: next }) });
  if (view === "conversation") {
    const taskIds = scope.taskIds;
    if (after !== null && (!after || typeof after !== "object" || Array.isArray(after) || Object.keys(after).some(id => !taskIds.includes(id)))) throw Error("Invalid conversation cursor");
    const waiting = !!args.waitMs && taskIds.every(id => after?.[id]);
    const page = await remote(waiting ? "zcode_remote_wait_many" : "zcode_remote_read_many", {
      taskIds, ...(after ? { afterCursors: after } : {}), ...(waiting ? { timeoutMs: args.waitMs } : {}),
      ...(args.messageLimit ? { messageLimit: args.messageLimit } : {})
    });
    const { cursors, ...result } = page;
    const tails = Object.fromEntries(page.tasks.map(row => [row.task.taskId, row.tailCursor]));
    return wrap({ ...result,
      tasks: page.tasks.map(({ cursor, tailCursor, ...row }) => row),
      tailCursor: encode({ v: 1, scope, position: { ...after, ...tails } })
    }, { ...after, ...cursors });
  }
  if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw Error("Invalid inbox cursor");
  const start = now();
  for (;;) {
    const page = await queue("zcode_queue_read", { ...(args.taskIds ? { taskIds: scope.taskIds } : {}),
      ...(args.teamId ? { teamId: args.teamId } : {}), ...(args.consumerId ? { consumerId: args.consumerId } : {}), after: after ?? 0, limit: 100 });
    if (page.events.length || page.historyGap || now() - start >= (args.waitMs ?? 0)) return wrap({ ...page, changed: page.events.length > 0 }, page.cursor);
    await delay(Math.max(0, Math.min(500, args.waitMs - (now() - start))));
  }
}
