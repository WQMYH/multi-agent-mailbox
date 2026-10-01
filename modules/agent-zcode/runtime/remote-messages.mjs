import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("base64url");
const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const contentOf = m => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m.parts ?? "");

function decodeCursor(value, target) {
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (c.v !== 1 || c.t !== target || !(c.i === null || typeof c.i === "string") ||
        !Number.isSafeInteger(c.n) || c.n < 0 || typeof c.h !== "string" || typeof c.s !== "string") throw Error();
    return c;
  } catch { throw Error("Invalid message cursor or cursor belongs to another task/workspace; use the cursor from read/send"); }
}

// ponytail: stateless tail continuation, not an audit of edits before the consumed anchor.
// Use native revision events if historical-edit tracking becomes a requirement.
export function messagePage(snapshot, task, { afterCursor, maxChars = 24000, requestMessageId } = {}) {
  if (!Array.isArray(snapshot?.messages)) throw Error("Unsupported ZCode conversation schema");
  const rows = snapshot.messages;
  const ids = new Set();
  for (const m of rows) {
    if (typeof m.id !== "string" || !m.id || m.id.length > 1024 || ids.has(m.id)) throw Error("ZCode returned missing or duplicate message IDs");
    ids.add(m.id);
  }
  const runtime = snapshot.runtime ?? {};
  const pending = { pendingPermissions: runtime.pendingPermissions?.length ?? 0,
    pendingQuestions: runtime.pendingElicitations?.length ?? 0, pendingCommands: runtime.pendingCommands?.length ?? 0 };
  const target = digest(JSON.stringify([task.taskId, task.workspacePath]));
  const state = JSON.stringify([task.displayStatus ?? null, task.archived === true, ...Object.values(pending)]);
  const checkpoint = (m, n = 0) => ({ v: 1, t: target, i: m?.id ?? null, n,
    h: digest(m ? contentOf(m).slice(0, n) : ""), s: state });
  const before = afterCursor ? decodeCursor(afterCursor, target) : null;
  const tail = rows.at(-1);
  const tailCursor = encodeCursor(checkpoint(tail, tail ? contentOf(tail).length : 0));
  const start = before?.i ? rows.findIndex(m => m.id === before.i) : 0;
  const historyGap = !!before && (start < 0 || (before.i === null && snapshot.history?.truncatedBefore === true));
  const messages = [];
  let cursor = before ? { ...before, s: state } : checkpoint(null), budget = maxChars, hasMore = false;
  if (!historyGap) for (let i = start; i < rows.length; i++) {
    const m = rows[i], full = contentOf(m);
    const anchor = before?.i === m.id;
    const replace = anchor && (before.n > full.length || digest(full.slice(0, before.n)) !== before.h);
    const offset = anchor && !replace ? before.n : 0;
    if (anchor && !replace && offset === full.length) continue;
    if (budget <= 0) { hasMore = true; break; }
    let end = Math.min(full.length, offset + budget);
    // UTF-16 offsets match JS strings; do not split a surrogate pair across pages.
    if (end < full.length && end > offset && /[\uD800-\uDBFF]/.test(full[end - 1]) && /[\uDC00-\uDFFF]/.test(full[end])) end--;
    if (end === offset && full.length > offset) { hasMore = true; break; }
    const content = full.slice(offset, end);
    messages.push({ id: m.id, role: m.role, timestamp: m.timestamp, turnIndex: m.turnIndex ?? null,
      content, contentOffset: offset, totalCharacters: full.length, replace: !!replace, truncated: end < full.length });
    budget -= content.length;
    cursor = checkpoint(m, end);
    if (end < full.length) { hasMore = true; break; }
  }
  let correlation = null;
  if (requestMessageId) {
    const userIndex = rows.findIndex(m => m.role === "user" && m.id === requestMessageId);
    const user = rows[userIndex];
    const turnIndex = Number.isInteger(user?.turnIndex) ? user.turnIndex : null;
    const nextUser = rows.findIndex((m, i) => i > userIndex && m.role === "user");
    const replies = turnIndex === null ? [] : rows.slice(userIndex + 1, nextUser < 0 ? undefined : nextUser)
      .filter(m => m.role === "assistant" && m.turnIndex === turnIndex);
    correlation = { requestMessageId, userMessageObserved: !!user, turnIndex,
      assistantMessageIds: replies.map(m => m.id),
      status: replies.some(m => contentOf(m).length > 0) ? "assistant_reply_observed" : user ? "user_message_observed" : "unconfirmed" };
  }
  return { ...pending, history: snapshot.history ?? null, snapshotMessageCount: rows.length,
    tailMessage: tail ? { id: tail.id, role: tail.role, turnIndex: tail.turnIndex ?? null, totalCharacters: contentOf(tail).length } : null,
    messageCount: messages.length, outputTruncated: hasMore, hasMore, historyGap,
    ...(historyGap ? { recovery: "Anchor is outside the current snapshot. Increase messageLimit (up to 500); if still missing, explicitly start a fresh read. History continuity is not confirmed." } : {}),
    cursor: historyGap ? afterCursor : encodeCursor(cursor), tailCursor,
    stateChanged: !!before && before.s !== state,
    assistantTextReturned: messages.some(m => m.role === "assistant" && m.content.length > 0), messages, correlation };
}
