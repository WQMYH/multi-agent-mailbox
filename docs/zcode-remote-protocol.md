# ZCode Remote Protocol Evidence

Verified against the installed ZCode desktop bundle and a live Remote Control session on 2026-09-08.

- `workspace-list-response` returns the real desktop workspace and task inventory.
- `zcode-task/getTaskConfigOptions({ taskId })` returns model options independently of the conversation snapshot. Use it for discovery and switch verification because `getTaskSnapshot` can reject tasks whose saved model is no longer available.
- If the target's saved model prevents even that call, another unarchived task in the same workspace can supply the currently advertised options. The target model is reported as unavailable/unknown until `setConfigOption` succeeds and target-local verification passes.
- `setConfigOption` rejects inactive sessions. For that exact error, `resumeTask` can load the existing task with an explicitly selected advertised model and thought level; it does not send a prompt. ZCode Ops then requires target-local option verification before reporting success.
- `zcode-task/getTaskSnapshot` with `clientMode: "web-remote-replayable"` normally calls `resolveTaskIndexResumeHints` before reading, which can reapply an unavailable historical model even after a successful runtime switch. Passing `resumeModelPolicy: "ui-resolved-only"` skips that index-hint step. Live verification on 2026-09-08 recovered the requested task's user prompt and assistant progress through the remote API, without a model change or prompt side effect.
- The installed desktop `zcode-task` service implements `getTaskConfigOptions`, `setConfigOption`, and `setModel`. Its model branch accepts `{ taskId, traceId, configId, value }`, routes `configId: "model"` to the runtime model switch, and returns refreshed config options.
- Live model options observed: `GLM-5.3-Flash`, `GLM-5.3`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`, and `glm-5.3-flash` through the user's enabled providers.
- `setConfigOption` is allowed only after matching a freshly advertised option (target first, with the same-workspace recovery described above). ZCode Ops refuses model changes while the task reports `running`, then calls target-local `getTaskConfigOptions` to verify the new model.
- Older tasks can be slow enough for their direct `workspace-bridge-open` to be superseded. Because the bridge is workspace-scoped, ZCode Ops may attach another live task in the same workspace and still address the requested task id; it never substitutes the target task itself.
- `zcode-task/stopGeneration({ taskId, workspacePath, workspaceIdentity? })` sends a native V4 conversation `stop` command. It is task-scoped, not conditional on an expected run ID. ZCode Ops rechecks native running status immediately before this call; ACK is reported only as `cancel_requested`. Fake-transport and tool regressions cover targeting, ended turns and uncertain delivery; no live business task was stopped for validation.
- `zcode_remote_wait` polls native workspace-list status with a bounded 0–30 second wait window plus request latency. The cursor includes task/workspace/native status/archive state, excluding timestamps and text. Connections are released between polls. Live verification returned `running` with `timedOut: true`, without inferring interruption; deterministic tests cover transitions, attention, missing tasks and transport failure.
- The remote adapter allowlists `createTask`, `getTaskSnapshot`, `getTaskConfigOptions`, `resumeTask`, `sendPrompt`, `setConfigOption`, and `stopGeneration`; arbitrary service dispatch remains blocked. `createTask` is available only inside the durable first-message workspace flow, with fixed `deferPersistenceUntilFirstPrompt: true` and a validated native `sess_*` result. No empty-task public tool exists.
- Sharing links are stored without format probing. URL parsing and required authentication fields are checked only when a remote operation is attempted. A connection failure asks for a new link; no automatic send retry occurs.
- Codex startup performs no ZCode operation and shows no link prompt. OpenAI's optional plugin components currently run through the ChatGPT MCP Apps UI path, so this local Codex plugin uses the native conversation input instead of a separate imitation window: <https://developers.openai.com/plugins/build/chatgpt-ui>.

## First-message task creation (2026-09-26, source/offline only)

Installed ZCode 3.14.3 bundle inspection found `zcode-task/createTask` reachable through a workspace-only bridge. The Phase 2B wrapper sends only `workspacePath`, optional `workspaceIdentity`, and `deferPersistenceUntilFirstPrompt: true`; it requires a real `sess_*` ACK. The public `zcode_send` accepts either existing `taskIds` or one connected `workspace`. The latter persists a stable workspace target and create intent in the existing SQLite queue, binds the native ID before `sendPrompt`, and keeps the three persisted send IDs and message marker for reconciliation. A create call with unknown outcome becomes `create_unknown` and is never retried; an explicit RPC rejection becomes `create_failed`. A bound task whose first send has not started may resume; an uncertain send is observed read-only and never replayed. Fake bridge and queue tests verify these boundaries. No live workspace creation, provider call, install, or business acceptance is claimed here; older ZCode versions remain unverified.

## Failed-turn continuation (2026-09-10)

The installed desktop bundle `out/host/index.js` routes `sendPrompt` through
`sendPromptToAgent` to V4 `sendText` with `heldQueueDisposition: keepQueueAndSend`.
The installed `resources/glm/zcode.cjs` implements `sendText` / `startPromptTurn`
using native `app.sendInput`; it checks model readiness and input admission.
There is no facade requirement to rewrite a previous `error` to `idle` first.
The queue's old `idle/completed` allowlist prevented this native path from being
called. Queued authorized prompts now also admit `failed`, while rechecking the
target and retaining the existing pending-input, FIFO and uncertain-send guards.
`resumeTask` remains session loading/model recovery, not proof that a new turn ran.

## Large snapshot repair (2026-09-09)

`Invalid remote frame` on long conversations was a receiver-limit bug, not evidence
of an expired Sharing Link. A live response declared 2,395,800 bytes in four
fragments; its first base64 fragment was 1,048,236 characters (786,177 decoded
bytes). The receiver incorrectly treated our outgoing 512 KiB fragment size as
the peer's receive limit. Reading two messages succeeded with the same link.

The receiver now accepts base64 fragments up to 1 MiB (768 KiB decoded), while
the physical JSON envelope still must fit 1 MiB. The 16 MiB assembled-message
cap, fragment-count/in-flight limits, canonical base64, size and CRC32 checks
remain enforced. Outgoing fragmentation stays at 512 KiB. Synthetic regression
coverage reproduces the observed four-fragment shape through receive/decode,
including reversed arrival order, acknowledgment and oversize rejection.

Live default-limit reads subsequently recovered 100 messages from task 1 and
21 messages from task 3. Task 1's text output was capped at 24,000 characters;
successful transport does not imply complete history or review acceptance.

Operational lessons: match exact task IDs (titles `1` and `01` are distinct);
inspect all monitored tasks each pass; serialize only short remote calls, never
wait for one task's completion before checking others. Native `completed` means
a turn ended, not that the overall task or review passed. Check messages and
authoritative evidence before advancing. Never retry an uncertain send/stop;
inspect delivery first. Diagnose transport fields before requesting a new link,
and never record link secrets or conversation bodies in diagnostics.

The previous eight-task review monitor was retired at the user's request. Its
two-round review gate is no longer a prerequisite for the Bio-Harness handoff.

## Message continuation (2026-09-09)

Installed `out/host/index.js` implements `limitTaskSnapshotMessages` as a tail slice,
with `history.truncatedBefore` and `totalMessages`. No snapshot before/after-history
parameter was found in that implementation. Live snapshots include message `id`,
`role`, `content`, and `turnIndex`; some initial assistant records precede a user
record with the same turn index, so turn index alone is not enough for correlation.

`zcode_remote_read` now pages forward within the returned window, using an opaque,
stateless checkpoint containing a target digest, native message ID, consumed UTF-16
offset, content-prefix digest and native status/pending-count fingerprint. It has
no transcript cache or background process. A cursor continues across separate MCP
gateway processes. The last consumed message can grow or be replaced; an absent
anchor produces `historyGap` without advancing it. Edits before that anchor are
outside this tail-continuation contract. `hasMore` covers the plugin's output cap,
not unavailable native history; `tailCursor` is an explicit skip-to-current-end.

`zcode_remote_wait(mode: "messages")` requires a message cursor and returns new
content, state/pending-count changes, a history gap, or timeout. Unchanged old
`completed` state alone does not wake this mode as a new reply. Default status
mode remains available with its distinct status cursor. Both release connections
between polls, with the wait window plus native request latency determining total
duration. Missing tasks or transport failures propagate errors, not completion.

`zcode_remote_send` captures a baseline before sending; a failed baseline prevents
the send. ACK returns the baseline cursor and the existing trace/query/message IDs.
`requestMessageId` correlation requires the exact user ID and subsequent assistant
records with the same native turn index, before the next user message. If the
runtime rewrites that ID or the user record falls out of the window, correlation
stays unconfirmed. Correlation is snapshot evidence, not proof of final delivery
of all paginated text, task completion, or business acceptance. No injected receipt
prompt, model inspection, or automatic retry is needed for continuation.

Live MCP verification on 2026-09-09 read 46,481 characters across 12 pages from
`sess_66299dd9-bd22-49a4-8b0a-2e5f5d36be04`, spawning a separate gateway for each
call. At the end `hasMore=false`, another read returned zero messages, and message
wait returned timeout with unchanged native `completed` status. The cursor was
275 characters. No Sharing Link or conversation bodies were persisted for this check.

One no-tool/no-file-change prompt was sent to the existing plugin-review task
`sess_364f3d09-4b3d-4db4-811f-3624dde5a68f`. The first wait returned its native user
message and an empty assistant record while running; the next returned the growing
assistant body `ZCODE_RETURN_OK_20260909` with native `completed`. The native user
ID was newly generated, not the supplied send message ID. Therefore `correlation`
correctly remained `unconfirmed`; `assistantTextReturned` separately reports actual
assistant text returned in a page. Exact request-ID correlation is supported by the
adapter contract and deterministic checks, but NOT verified available in this
desktop path. This is a native limitation, not a reason to resend the prompt.

## Concurrency boundary (2026-09-09)

The relay authenticates a Sharing Link as one mobile terminal. Opening multiple
WebSockets with the same link causes the relay to return `KICKED`; removing the
old global lock and creating one connection per read is therefore invalid.
The adapter keeps at most one physical connection and exposes `zcode_remote_read_many`
and `zcode_remote_wait_many` for multi-task monitoring. It groups tasks by
workspace, opens one bridge per group, and runs that group's `getTaskSnapshot`
RPCs concurrently through independent request IDs. Groups for different
workspaces are switched sequentially because the installed desktop runtime
keeps one `currentBridge` per remote-control window. A second bridge open on
the same connection stalled a subsequent snapshot in live testing; resetting
the outgoing frame sequence did not resolve it and was reverted. Close and
reconnect between workspace groups. Two live tasks in different workspaces
returned in 4.9 seconds with no missing targets or errors.

Single-task calls remain serialized by the connection guard. The batch tools are
the supported concurrency boundary; they do not create a second terminal,
change task write ordering, or provide event push. Direct read/wait still
requires a caller. The explicit background queue worker now polls independently
without LLM turns; this is not a Codex wakeup channel. Queue details and limits
are in [message-queue.md](message-queue.md).

Batch calls accept at most 8 task IDs, run at most 4 snapshot RPCs concurrently
per workspace, and default to 3000 returned characters per task. Failed targets
have separate errors without discarding successful pages; all pending calls
settle before switching or closing a bridge.

The desktop bundle is implementation evidence, not a stable public contract. Re-run the live snapshot and switch verification after ZCode upgrades.

## Batch completion isolation (2026-09-10)

A reported queue head stayed `acknowledged` / native `running` after the desktop
turn completed. Its marker, native user ID and turn index were already matched;
only the first 64 characters of its eventual 953-character reply had been collected.
A single-target read from that same saved cursor returned the remaining 889
characters and `completionConfirmed: true`. This ruled out a missing model reply
or an incorrect team label for this incident.

The seven-target worker read reproduced a shared-bridge stall: several initial
snapshots arrived, then another snapshot and the healthy tasks' confirmation
snapshots timed out. Only one task returned a usable page. The precise desktop
condition that stalls the RPC remains unconfirmed; the integration bug was allowing
that shared failure to repeatedly prevent healthy task completion reconciliation.

`readMany` now retries failed batch snapshots once per task on fresh, isolated
connections, with the original cursor and unchanged completion guards. Successful
pages are not replayed. The fallback performs reads only, never prompt sends or
model changes, and a failed isolated read remains an explicit per-task error.

Live verification recovered six of the seven pages (one task still reported
`workspace_unavailable`) in about 106 seconds. The incident's original queue head
advanced to `completed` through `MessageQueue.observe`; no prompt was resent and
no queued follow-up was dispatched during verification. This validates the reported
head's recovery, not every native task's health or a maximum model concurrency.
The deterministic regression reproduces shared-connection poisoning and verifies
healthy completion, same-task follow-up admission, and no replay of old requests.

## Large-reply ACK identity (2026-09-14)

A single task also stalled after its first full snapshot: 47 messages, 3,191,323
encoded bytes in five fragments arrived successfully, but the completion-confirmation
snapshot on that connection timed out. Two tail-only reads succeeded with the same
Sharing Link and saved cursor. Reconnecting and repeating the full read did not help.

The installed desktop's `sameIdentity` in `out/main/chunk-WR3FEWGO.js` compares
`bridgeSessionId`, `bridgeGeneration`, and `recoveryId` exactly. Its
`AcknowledgedRelayProtocol` in `out/main/chunk-NHZHAM44.js` ignores mismatched ACKs
and retains the unacknowledged bytes, eventually saturating the bridge. ZCode Ops
omitted `bridgeGeneration` from `rpc-frame-ack`; its outgoing data frames already
included it. Small responses had hidden the missing ACK because they did not fill
the buffer immediately.

Echoing the accepted frame's generation in the ACK restored both full snapshots
on the same connection. The live read returned the remaining 1,073 characters
from the unchanged cursor with `completionConfirmed: true` and no history gap.
The regression checks the large-reply ACK identity and gates subsequent fake RPCs
on a matching ACK. Snapshot limits and completion checks remain unchanged.
