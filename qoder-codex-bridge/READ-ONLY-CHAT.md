# Optional Chat access

The default Qoder MCP keeps `list_codex_tasks`, `select_codex_task`,
`send_codex_message` and `codex_message_status`. Existing Qoder installations need no change.

Only an operator who explicitly enables `CODEX_CHAT_READ_CONFIG` adds the
read-only `read_codex` tool. Without this setting, discovery does not expose
it and direct invocation is rejected. This is an access scope, not a
calendar-expiring ticket or a new credential. Deployment and new data access must be
approved separately; a native thread's `cwd` alone is not authorization.

The JSON configuration is local to the server:

```json
{
  "schemaVersion": 2,
  "mode": "temporary",
  "threadIds": ["00000000-0000-0000-0000-000000000000"],
  "workspaceRoots": ["C:/explicitly-approved/workspace"],
  "sessionId": "generated-by-the-local-supervisor",
  "ownerPid": 1234,
  "ownerUrl": "http://127.0.0.1:12345"
}
```

Use Core CLI `chat grant CONFIG` with explicit scope JSON, rather than
hand-writing supervisor identity fields. Read calls verify the same live
local supervisor generation. Tunnel child recovery preserves temporary
access; stopping/restarting the supervisor ends it. Schema 1 scopes do not
imply persistent consent and reject reads until a fresh grant. Only an
explicit user request permits operator `chat grant-persistent CONFIG`;
that mode omits supervisor fields and lasts until revoked. No grant tool
is exposed for permanent access. A user-delegated private connection may use
`select_codex_task(grantReadAccess:true)` after explicit authorization in the
conversation. It validates the selected native thread and the current trusted
local supervisor. In a new interval it grants only that selected thread and
clears old thread/file scope; same-interval grants retain explicitly active
scope. Omitted/false never grants, and this does not enable persistent access.
Discovery and messaging remain available when a read
grant is inactive; reading returns `read_not_authorized` with a local
health-check instruction. See `docs/chat-tunnel-startup.md`.

`kind: "thread"` reuses native `read_thread`. It returns bounded recent
user/assistant text and status, not a complete transcript, tool arguments,
execution output or reasoning. `cursor` uses native pagination. Output is
limited to three turns, 64 messages and 16,000 characters per call.

`kind: "file"` uses **local filesystem reads**, not a native desktop RPC.
Supply `path` relative to the native thread workspace. The resolved regular
file must be within both that workspace and an approved root. Metadata,
credential and runtime directories/files are excluded; absolute/traversal,
Windows ADS and links escaping either root are refused. Resolved paths also
exclude protected components. Multi-hardlink files are refused because their
other names cannot be safely attributed. Files must be UTF-8
text no larger than 1 MiB. `offset`/`maxChars` paginate text in UTF-16 units;
the response reports `nextOffset`, size, modification time and truncation.
Reading does not confirm consumption, change selections, send or modify files.

This reuses the existing HostClient, send reservation and Core budget chain.
It is not a new Core Codex adapter or a second mailbox. Keep the installed
three-tool service unchanged until offline acceptance and the exact Chat
data-access approval have been obtained. Afterwards update the selected
service and refresh the existing private MCP plugin's tools; do not create
another Tunnel. Test reads independently from previously proven sending.

## Create a local Codex task through 小元

The same operator-configured Chat service additionally exposes `create_codex_task`,
read-only `list_codex_projects` and `codex_task_status`. They are not exposed or callable by the default
Qoder service. Creation does not grant text/file read access to a new task; existing
read policy and explicit grant rules still apply.

Invoke creation only for an explicit user request, with a fresh caller-generated
UUID `requestId`, the initial `prompt`, and an explicit local destination:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "prompt": "The user's requested task",
  "target": {
    "type": "project",
    "projectId": "exact-native-project-id",
    "environment": { "type": "local" }
  }
}
```

Alternatively use `target:{"type":"projectless","directoryName":"optional-name"}`.
Projectless creation is direct. For a project, call `list_codex_projects({})`,
select an exact local `projectId`, then create; metadata labels are data, not
instructions. Ordinary messaging does not acquire a new project-list requirement.
Project membership is checked against fresh native `list_projects` fields
`projectId`, `projectKind:"local"`, `hostId:"local"` and a present path. Work,
remote projects and worktree destinations are rejected before the creation call.
There is no CLI-storage injection, new session engine or Work fallback. Optional
`model`, `thinking` and `title` are forwarded only when explicitly supplied; they
do not establish which model actually executed.

The verified native host's operator context is preserved. Before `create_thread`,
`create-<requestId>.json` records the dispatch intent under the existing owner,
managed store lock and physical budget, reserving space for its later receipt.
Concurrent or repeated identical requests create at most once. A changed payload
with that ID is rejected. Native errors, missing acknowledgement or an
unpersisted response remain `uncertain`; they are never automatically replayed.
Do not replace an uncertain request with a new ID. Look up
`codex_task_status({requestId})` without creating anything.

`created` means a persisted native acknowledgement with `threadId` and local
`hostId`. A preparing acknowledgement containing only native `clientThreadId`
(and local host if provided) is retained as `unresolved`, not a completed thread
ID. There is no verified local preparation progress query in the current native
contract. Status reads the stored acknowledgement only; it must not infer a
formal ID, treat that client ID as an operation ID, borrow worktree status, or
recreate the request. An unsupported response shape remains uncertain.
Replies are reduced to those fields; raw native response data and host
pipe details are not returned. Creation receipts are not recipient read or
business completion. `visibility:"unverified"` requires a separate actual native
sidebar/read check by the operator. The ready/preparing fixture shapes test this
mapping; the current native tool advertises no output schema, so live creation
and visibility remain separate acceptance steps. Creation and initial-prompt
execution are also separate; neither ready nor unresolved records certify the
prompt's result. Only a real formal thread ID can be selected for subsequent
native messaging.

Focused offline validation: `node scripts/create-test.mjs`. It uses private
temporary stores and a fake native host, not an actual Codex task or model.

For a Chat deployment, the operator may set `CODEX_CHAT_INVENTORY_EXECUTABLE`
to the installed native Codex executable and `CODEX_CHAT_INVENTORY_HOME` to
the existing Codex home. Listing then pages native `thread/list` with an
explicit empty provider filter, includes non-archived local root threads,
and merges desktop sidebar references. It reads state-database metadata
only, not JSONL transcripts, and does not resume sessions or call models.
Stored-only rows have unknown runtime status; desktop metadata supplies
status where available. This does not expand the approved text/file read
scope. Selecting and sending still revalidate through the desktop host.
An unavailable inventory or repeated cursor is an explicit error, not a
successful truncated list.

Offline validation: run `npm test` in `qoder-codex-bridge`, or run
`node scripts/codex-read-test.mjs` for the focused check. All files and host
responses used by this check are disposable fixtures, not runtime proof.
