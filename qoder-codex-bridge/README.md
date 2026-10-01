# qoder-codex-bridge

Qoder CN desktop plugin that relays fixed-template task lifecycle events to a bound
Codex monitoring task and exposes separate, explicit tools for user-authored messages.
Lifecycle receipts record metadata only — never prompts, transcripts, tool I/O,
credentials, or model text. The explicit message path stores only a message hash.

Status: the fixed-template lifecycle round-trip and one explicit
`list -> select -> send` message were verified on Qoder CN 0.1.8. The coordinator
also verified the installed 0.3.4 single-binding lifecycle path and native Qoder return.
Subsequent isolated native tests covered Core-backed managed-store budgets,
multiple sessions and same-route native-turn bindings with different Codex targets.
See [tested scope](../docs/compatibility.md); successful no-tool completed turns
do not prove every terminal condition or automatic worker rebirth.
Installed, configured, current-version loaded, and currently usable remain separate
states; check the live host configuration before relying on the tools.

The initial candidate was authored by Qoder CN; subsequent attribution repairs,
handler process tests, and the multi-binding phase are maintained by Codex under
the user's takeover instruction.

## Layout

| File | Role |
|---|---|
| `.qoder-plugin/plugin.json` | Manifest; declares `./hooks/hooks.json` and `./mcp.json`. |
| `mcp.json` | Qoder plugin stdio MCP entry for explicit Codex task/message tools. |
| `commands/codex-message.md` | User-triggered `/codex-message` flow for listing, explicit selection, and exact user text. |
| `hooks/hooks.json` | Qoder `command`-type handlers for SessionStart / UserPromptSubmit / Stop / StopFailure. |
| `hooks/handler.mjs` | Per-event entry: validate → correlate → record → notify. |
| `scripts/event-recorder.mjs` | Binding load/validate, event build, path-safe receipt write, dedup, send-state marking. |
| `scripts/host-notifier.mjs` | Reused HostClient/loadHostConfig/hostRead pattern; fixed-template prompt; target verification. |
| `scripts/configure-binding.mjs` | Operator tool that creates a legacy binding or adds an exact keyed binding (offline; not run automatically). |
| `scripts/store-budget.mjs` | Shared capacity lock, current Core allocation check, bounded reservations, and managed atomic writes. |
| `scripts/native-turn-return.mjs` | Internal receiver for provider-verified exact native turns; no public MCP or Hook entry. |
| `scripts/validate-config.mjs` | Semantic linter for the shipped manifest + hooks (not just JSON.parse). |
| `scripts/self-test.mjs` | Offline checks with mocked transports; no host, model, or network. |
| `scripts/attribution-test.mjs` | Real handler processes: contention, rename faults, fresh-process recovery and single-use requests. |
| `scripts/mcp-server.mjs` | Explicit list/select/send MCP tools; never called by lifecycle Hooks. |
| `scripts/message-test.mjs` | Offline stdio MCP/host-adapter test with no real Codex send. |
| `scripts/native-turn-test.mjs` | Offline same-route, exact-result, recovery, and cross-process send-claim checks. |

## Offline verification

```
node --check <every .mjs>
node scripts/self-test.mjs      # exit 0 when green
node scripts/attribution-test.mjs
node scripts/message-test.mjs
node scripts/native-turn-test.mjs
```

Each test creates an exclusive `qoder-codex-bridge-*` directory under the system
temp dir via `mkdtempSync`, writes fixtures there, and removes only that same
directory in `finally`. Tests never touch a production host-config or real binding.

## Lifecycle bindings

`binding.json` schema 1 remains supported as one legacy binding. Schema 2 stores
`{ "schemaVersion": 2, "bindings": [...] }`; the handler never chooses the first,
latest, or nearest record. It selects exactly one record from the request marker or
existing submission anchor plus the hook `session_id` and canonical `cwd`. Missing,
expired, duplicate, conflicting, or unmatched records fail closed without starting
the host adapter.

Create a legacy single binding with the original command form, or append a keyed
binding with `--add`:

```
node scripts/configure-binding.mjs <dataDir> <requestId> <workspaceId> <sessionId> <hookSessionId> <cwd> <targetTaskId> <targetCwd> <expiresAt>
node scripts/configure-binding.mjs --add <dataDir> <requestId> <workspaceId> <sessionId> <hookSessionId> <cwd> <targetTaskId> <targetCwd> <expiresAt> [{"deliveryId":"...","ownerId":"...","correlation":"..."}]
```

Both command forms use the same binding-registry lock around their entire
read/validate/write boundary. The legacy create form succeeds only when no registry
exists (`binding_registry_exists` otherwise); `--add` migrates a valid schema 1 file
to schema 2 and rejects a duplicate request. Legacy Hook bindings permanently
refuse another request on the same canonical hook-session/cwd route. That prevents
a late Hook event from an old request reaching a newer target.
The optional association object is accepted only as the complete
`deliveryId`/`ownerId`/`correlation` trio. It records the upstream delivery link;
it does not choose a route, and `sourceAgent` is never treated as the persistent
owner. The installed controller must supply those values only after its own receipt
contract is accepted.

For provider-verified native turns only, `--add` accepts the complete association
object with `"returnMode":"native_turn"`. This explicitly permits distinct
request bindings on one hook-session/canonical-cwd route, each with its own target.
It never mixes that route with a legacy Hook binding. The Hook handler cannot select
a native-turn binding or infer a result from `Stop`. The trusted provider calls
`reconcileVerifiedReturns({ dataDir, scope, observeTurn, assertActive })` after it
has checked native input and terminal assistant history. `scope` contains its
current `ownerId`, `workspaceId`, and canonical Qoder `cwd`; `observeTurn` returns
an exact fact for one `{requestId, deliveryId, sessionId}` or `null` while unverified.
The fact must agree on owner, delivery, request, workspace, session, and cwd and
contain native input, turn, assistant, terminal outcome, and evidence-source IDs.
The receiver writes only fixed metadata, rechecks the binding and provider lease,
then claims the recorded receipt under the managed-store lock before a Host send.
An accepted or uncertain receipt is never resent. One pass handles at most 64
active bindings in that scope; a larger scope is rejected for operator review.
This internal export adds no queue, poller, public MCP tool, or user-message send.

One live host configuration acts as the operator transport. Before dispatch, the
plugin re-reads the operator task and, when the selected binding names another target,
separately re-reads that exact target ID and directory. The lifecycle path therefore
supports multiple explicit targets without a global current-target pointer.

## Managed store budget

Before any binding, lifecycle receipt/anchor, or explicit-message intent is written,
the data directory must contain an operator-provisioned `store-config.json`:

```json
{
  "schemaVersion": 1,
  "ownerId": "qoder-return-store:<derived-from-canonical-dataDir>",
  "coreCli": "C:/absolute/path/to/accepted/core-cli.mjs",
  "registryPath": "C:/absolute/path/to/core-registry.json"
}
```

`ownerId` is derived by `storeOwnerId(dataDir)` and is independent of optional
upstream binding association fields. For every persistent write, the plugin runs the
trusted local Core CLI with `--registry <registryPath> budget-status` using exec-file
semantics, a two-second timeout, bounded output, and no shell. The returned allocation
must be schema 1 and provide valid legacy 20,000,000/200,000,000-byte or adaptive
allocations. Adaptive budgets validate the default owner size and optional global cap.
Allocations must sum exactly to the declared total and include this owner.
Existing explicit legacy budgets remain readable at their original allocation;
the plugin never rewrites or expands them. A missing,
invalid, mismatched, unallocated, unavailable, or over-capacity budget fails closed.
Over-capacity errors include the byte deficit when it is known. Existing managed data
is preserved and remains readable.

One data-directory lock serializes all dynamic managed writes: `binding.json` and its
lock/temp files, lifecycle receipts/anchors/transition markers, and explicit-message
intents. Static `host-config.json`, `store-config.json`, and the Core registry are not
charged. Capacity is based on managed file lengths plus reservations accepted with a
binding or message intent. Binding acceptance reserves bounded Hook/receipt growth and
atomic-replacement peak space; later writes consume that reservation. Message atomic
temp files are grouped with their selection token, so a process exit after temp write
but before rename consumes the original intent reservation. The primary record remains
`dispatch_intent`; an orphan temp is never treated as a provider ACK or replay signal.
A new allocation
is read before every write, so a reduced or removed Core allocation takes effect
immediately. Locks are never stolen: `configure-binding --add` waits at most five
seconds and returns `binding_registry_busy` with `retrySafe: true`; any unknown write
outcome is not retried automatically. A lock-release failure after a write is reported
as non-retryable unknown state instead of being hidden as success.

## Explicit user messages

When the plugin MCP server is installed and the operator has configured a live
Codex desktop host channel, invoke `/codex-message` or ask Qoder to use:

1. `list_codex_tasks` to show Codex task IDs, titles, directories, and status. It
   excludes ChatGPT conversations and never returns task history or summaries.
2. `select_codex_task` with one listed `threadId`. It re-reads that target and returns
   a selection token valid for five minutes in this MCP process.
3. `send_codex_message` with that token, the same `threadId`, and the user's exact
   message. It rechecks the target ID/directory, consumes the token, persists a
   send intent, then calls the desktop `send_message_to_thread` tool once. An
   uncertain result is not retried automatically; a successful result requires an
   accepted host receipt to be durably recorded. The message body is not persisted.

These MCP tools are separate from `UserPromptSubmit`/`Stop` Hooks and do not depend
on a lifecycle `binding.json`. They still require an unexpired `host-config.json`
whose task and directory are re-read from Codex before every operation. Refresh that
configuration after the Codex desktop host restarts or its expiry passes; the server
re-reads it on the next call. No Hook sends user-authored text, and the plugin does
not silently pick a target. Qoder's MCP tool permission settings still govern invocation.
The installed 0.1.8 test verified `${QODER_PLUGIN_ROOT}`, `QODER_PLUGIN_DATA`, MCP
startup, and cross-task host authorization for this path.

The existing `host-config.json` fields (`script`, `pipePath`, `threadId`, `cwd`,
`expiresAt`) remain the input contract. The operator supplies the adapter script path
and a verified current Codex operator task as `threadId`. HostClient starts that script
without `--interaction-client-id` and passes `params._meta.codexThreadId` on every
`tools/call`, including reads and sends. The 0.1.5 desktop adapter interprets the old
flag as a ChatGPT caller; using the configured Codex task in MCP metadata selects the
Codex caller path. This plugin does not infer a ChatGPT interaction identity from the
configured task ID. The fake-child tests check the RPC envelope and redacted errors;
the updated adapter path still needs installation and a live read before use.

## Contract the code enforces

- Manifest: `name`, semver `version`, `hooks === "./hooks/hooks.json"`, and
  `mcpServers === "./mcp.json"`.
- Hooks: `type: "command"` only; a `${QODER_PLUGIN_ROOT}`-resolved command; no legacy ZCode
  `process`/`timeoutMs`; all four lifecycle events wired; a `hooks` reference that escapes
  the plugin root is rejected. Qoder's exec-form `args` is a valid hook option but this
  plugin ships only the shell-string `command` form, so `args` is rejected as outside this
  plugin's supported subset (not because it is globally invalid).
- Two-layer attribution (plan §4): the request marker or durable submission anchor selects
  one binding whose `requestId`, `hookSessionId`, and canonical `cwd` all match; then (1)
  trusted session mapping — `input.session_id === binding.hookSessionId` AND
  `canonical(input.cwd) === canonical(binding.cwd)`; (2) request
  attribution — `UserPromptSubmit` must carry a `QODER_RETURN_REQUEST=<binding.requestId>`
  marker that occupies a whole line on its own (only horizontal whitespace may surround it). An
  in-sentence occurrence (`do it QODER_… now`), a key prefixed into a larger identifier
  (`NOT_QODER_RETURN_REQUEST=…`), a garbled/trailing value, or two marker lines (agreeing or
  conflicting) are all refused. A valid marker opens this session's single in-flight submission
  anchor via an exclusive `wx` create. The entire read/decide/write sequence is protected by
  a per-session exclusive lock; a competing handler leaves a separate permanent conflict
  flag, which the first handler cannot clear. `Stop`/`StopFailure` relay only when exactly one non-ambiguous matched
  submission is in flight. `SessionStart` is observe-only (`observed_only`, never a submission).
  Every attribution-changing transition (mark-ambiguous on overlap, consume on terminal) first
  writes a durable per-session quarantine marker, then updates the anchor, and only clears the
  marker after a read-after-write confirms the new state. If a transition fails, including a
  failure to write the quarantine, the already-created lock remains in place. The handler returns
  `attribution_unpersistable`, and a later call or process
  distrusts the stale active anchor rather than re-notifying the old request. Extra input,
  overlap, a partial/forged/foreign/unreadable anchor, a wrong/absent marker, or a duplicate
  terminal returns `uncorrelated` with `failClosed: true` — nothing is recorded or notified.
  An abandoned lock is never automatically reclaimed. A completed request cannot reopen
  using the same marker; operator recovery must use a new request on a new hook-session/cwd
  route and explicitly retire old binding data.
  Attribution is never guessed from recency. See boundary 6 for failure before lock acquisition.
- Input rejection: for a bound, matching `UserPromptSubmit`, failure to persist attribution or
  the matched input receipt returns `blockInput: true`; the command Hook exits 2 so Qoder rejects
  that new input. The attribution lock covers receipt creation and remains on failure, so a
  subsequent Stop cannot use the rejected input's anchor. A durably recorded extra input, an unbound session, and notification failures
  do not use exit 2. `Stop`/`StopFailure` keep their existing behavior. The offline test checks
  actual child-process exit codes; installed Qoder behavior still requires a separate live check.
  A Hook that is not loaded, fails to start, or times out cannot enforce this rejection; whether
  same-turn steering invokes `UserPromptSubmit` remains unverified.
- Source separation: handler events are always `source: "runtime_hook"`; `signal` comes
  from the hook name (`Stop -> stop_observed`, never `completed`); the model cannot set
  these through parameters.
- Dedup identity: a receipt is keyed by `requestId`+`signal` only, so remapping the hook
  session cannot open a second receipt for the same stage. On an existing receipt the record's
  `schemaVersion` and stable binding identity (`workspaceId`/`sessionId`/`hookSessionId`/
  `targetTaskId`/`targetCwd`/`cwd`) are re-validated, and the record must be internally
  cross-consistent: its stored `event` agrees field-by-field with its `identity`, and its send
  markers agree with its `sendState` (e.g. `accepted` requires `sent=true`,
  `dispatchAttempted=true`, and a `hostReceipt.threadId` matching the identity `targetTaskId`).
  A record that fails shape/cross-consistency or conflicts on identity is a conflict
  (`uncorrelated`), never a dedup "already notified" success.
- Path safety: every receipt name is built from `signal`+`requestId` (validated `^[A-Za-z0-9_-]+$`)
  and the resolved path is confirmed inside `dataDir` before any write, so a crafted id cannot
  traverse out.
- Evidence: `buildEvent` sets `evidenceRef` on the event that is actually sent, so the
  host receives a real `Evidence:` reference, not `null`.
- Persistence / send states (plan §4): the receipt is written durably before notifying; updates
  go through an atomic temp-write + rename so an overwrite can never destroy the unique event.
  `sendState` moves `recorded -> dispatch_intent -> accepted | uncertain`; the intent is persisted
  BEFORE the `send_message_to_thread` call, so a crash leaves a recognizable unknown, never a
  silent success. A host ACK that cannot be durably recorded is NOT reported as `notified`. Same
  request/stage re-fires dedup to the prior state and are never re-sent (no auto-resend).
- Not-dispatched vs unknown (R4): failures strictly *before* the `send_message_to_thread`
  call — missing/expired/invalid host config (including a pipe path with control characters,
  refused at load), init, hostRead, expiry, a failed intent-persist, or a synchronous failure to
  construct/spawn the host adapter (reported as `host_spawn_failed` with a redacted message) —
  are all `recorded_not_dispatched` and keep the receipt at `sendState: "recorded"`. This is kept
  distinct from a real transport `recorded_send_uncertain`, which is only reached once a
  `send_message_to_thread` attempt was actually made. Neither path auto-resends.
- Fixed template + target verification: the notification body is a fixed template, and
  `hostRead` re-checks the thread id/cwd against the binding before sending.

## Remaining runtime boundaries

1. Qoder CN 0.1.8 loaded the installed Hooks and MCP server, completed a bound
   fixed-template input/stop round-trip, and completed one explicit
   `list -> select -> send`. The coordinator later verified installed 0.3.4 direct
   Codex MCP return and native Qoder lifecycle return. This Phase 2 multi-binding
   source was subsequently installed and exercised with multiple live sessions/targets;
   the tested scope is recorded in the public compatibility guide.
2. The current host configuration must be recreated after its expiry or a Codex
   desktop host restart. Offline tests prove that the same MCP process re-reads a
   replacement config; they cannot prove the new desktop pipe is live.
3. The mapping between the desktop `sessionId` (UUID) and the hook `session_id` that is
   recorded as `binding.hookSessionId` — must be observed and bound by the operator.
4. One selected-task message was verified. Broader target availability still depends
   on what the current Codex desktop host exposes to the configured operator task.
5. Hook `Stop` is never a completion claim. The new native-turn mode requires an
   exact provider-verified terminal assistant fact; this plugin cannot produce that
   native evidence itself. Installed provider integration passed the isolated
   no-tool/completed scope; other conditions are not inferred from that pass.
6. If creation of the busy lock alone fails, the handler writes a separate permanent
   conflict marker before returning; a fresh process then rejects the old anchor. This is
   covered by a real busy-write EIO test. If the data directory rejects every write BEFORE
   either marker can persist, an unrecorded event cannot be recovered from an unchanged
   anchor. The current hook input has no verified terminal-to-input identity that closes
   this gap. This remains an unresolved request-attribution contract, not an accepted
   guarantee. Once the lock exists, failures writing either the anchor or quarantine leave
   persistent fail-closed evidence, verified with subsequent fresh handler processes.
7. Optional Core association fields are preserved and validated, but the controller
   revision that supplies them has passed independent review. The managed-store
   budget uses a separate owner derived from the canonical plugin data directory and
   queries the accepted Core CLI before each write; it does not create a second registry.
   This source has offline threshold, reservation, missing/allocation-change, and real
   two-process contention evidence, plus installed Core allocation and isolated
   live Qoder/Codex return evidence. This does not certify arbitrary future configurations.
8. Legacy Hook bindings still reject a second request on the same
   hook-session/canonical-cwd route, and a terminal submission anchor cannot be
   reopened. Explicit native-turn bindings allow that route reuse only with exact
   provider facts; this mode has offline and isolated installed multi-turn acceptance.

Downloading or running the offline tests does not install the plugin, refresh
binding/config files, restart either desktop app, or send a real message.
