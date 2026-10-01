# Agent Core

This is the small Codex plugin and local MCP server for independently registered agent modules. It owns registration, lifecycle, lazy loading, and the three base tools only:

- `agent_discover({moduleId?})` lists metadata without importing modules; passing one enabled module id returns that module's operation descriptions.
- `agent_read({moduleId,operation,args})` accepts only operations declared with `annotations.readOnlyHint: true`.
- `agent_act({moduleId,operation,args})` accepts only mutating operations.

## Module lifecycle

An explicit local CLI install registers a module; the core never installs a path received from model output. The registry defaults to `%USERPROFILE%/.codex-agent-core/registry.json` and can be overridden with `AGENT_CORE_REGISTRY` or `--registry`.

```powershell
node modules/agent-core/src/cli.mjs install E:\path\to\agent-module --registry E:\path\to\registry.json
node modules/agent-core/src/cli.mjs list --registry E:\path\to\registry.json
node modules/agent-core/src/cli.mjs disable agent-qoder --registry E:\path\to\registry.json
node modules/agent-core/src/cli.mjs enable agent-qoder --registry E:\path\to\registry.json
node modules/agent-core/src/cli.mjs uninstall agent-qoder --registry E:\path\to\registry.json
```

The same registry operations exposed by MCP are available to shell-capable agents. These commands read one JSON value from stdin, write one JSON value to stdout, and reserve stderr for diagnostics:

```powershell
'{"moduleId":"agent-qoder"}' | node modules/agent-core/src/cli.mjs discover --registry E:\path\to\registry.json
'{"moduleId":"agent-qoder","operation":"list_tasks","args":{"limit":20}}' | node modules/agent-core/src/cli.mjs read --registry E:\path\to\registry.json
'{"moduleId":"agent-qoder","operation":"send","args":{"requestId":"..."}}' | node modules/agent-core/src/cli.mjs act --registry E:\path\to\registry.json
```

`discover`, `read`, and `act` call the same `ModuleRegistry.agentDiscover`, `agentRead`, and `agentAct` methods as MCP. The exported synchronous `execute()` function remains the management-command interface used by existing callers.
The direct CLI is a one-shot invocation: after writing its JSON result or diagnostic it exits, even if an imported adapter left a timer or socket open. That exit proves only that this call returned. Durable queue recovery, observation, and provider completion remain the adapter's responsibility.

`uninstall` removes only the registration. It does not delete the module source or provider data. Every call re-reads the registry, so a disabled or uninstalled module cannot be reached through an already-loaded cache.

Set the same absolute `AGENT_CORE_REGISTRY` path in the MCP process environment as the CLI's `--registry` path. Relative example commands above run from the Multi-Agent Mailbox repository root. No registration is created at server startup. Use `install` again after an intentional module replacement; registration snapshots the metadata, canonical root and entry path. In-place source edits require an MCP process restart to refresh imported dependency modules.

Registry updates take a fail-fast exclusive `.lock` file before reading and atomically replace the JSON file. A competing CLI exits nonzero without writing; retry after the other writer completes. A crashed writer can leave a lock: inspect its PID/timestamp, stop all registry writers, and remove only that registry's `.lock` after confirming no writer remains. The core never guesses that a live lock is stale. Readers see the previous or next complete registry. Keep one registry path per installation on a local filesystem.

Disable/uninstall prevents subsequent dispatch, including loads/descriptions that were still pending when registration changed. It does not cancel provider work already dispatched or terminate provider workers. Provider-specific cancellation remains in its adapter. Node's imported code remains in memory until the MCP process exits, but that cache grants no access to disabled or removed registrations.

The native Codex plugin lifecycle is separate: enabling, disabling, or uninstalling `agent-core` is performed by Codex's plugin management. It is not automatically linked to the internal module registry. Verify both sides independently: Codex should advertise the three base tools; the CLI `list` should show the module state; selected `agent_discover` should return operation descriptions; after `disable` or `uninstall`, calls should fail while the source directory remains.

## Module manifest

Each module root contains `agent-module.json` with schema version 1, an entry path confined to that root, and one or more target identities. The entry exports:

```js
export async function describe() { /* MCP-shaped operation definitions */ }
export async function call(operation, args, context) { /* provider response */ }
```

The third argument is a frozen host context. `context.registrationKey` identifies this registry path,
registrationId and revision; `context.assertCurrent()` synchronously rereads the existing registry and
checks that the same registration is enabled and its entry still matches. A module that retains
asynchronous callbacks must retain this context, check it after waits and immediately before sending
external operations, and stop that callback when the check throws. Disable/enable changes revision;
reinstall changes registrationId. Thus old callbacks stay invalid even after re-enable or replacement,
including when another process performed the registry update. Existing two-argument adapters may
ignore the extra argument; the core cannot police background work in adapters that ignore the context.
This check does not hold a lock over an external call and cannot retract an operation already issued.
Qoder's last check occurs before sending its CDP evaluation; a registry change after that boundary can
coexist with that in-flight evaluation completing. No new registry or lifecycle service is introduced.

The core does not expose a generic shell/eval operation, start a worker, or interpret provider output as instructions. It also does not replace provider-specific queues or storage.

## Message receipt contract

Core exports `validateMessageReceipt()` and also supplies it to revision-isolated adapters as `context.validateMessageReceipt`. Existing provider return values remain unchanged. A future adapter may add a `messageReceipt` field; Core validates that field when present but never manufactures one from a returned call, transport ACK, or provider text. If post-call validation fails, Core preserves the provider result and adds `messageReceiptContract` with `status: contract_error` and `acceptance: unknown`. Mutating calls report `actionMayHaveOccurred: true` and `retrySafe: false`; Core never resends them. Read-only calls report the inverse flags.

Schema version 1 keeps durable queue ownership separate from source identity and provider acceptance:

```json
{
  "schemaVersion": 1,
  "requestId": "stable-logical-request",
  "deliveryId": "owner-local-delivery",
  "ownerId": "persistent-queue-owner",
  "target": { "moduleId": "agent-example", "address": "session-123" },
  "correlation": "work-item-456",
  "replyTo": {
    "ownerId": "reply-queue-owner",
    "target": { "moduleId": "agent-example", "address": "session-789" }
  },
  "acceptance": {
    "owner": { "state": "accepted", "evidence": "durable-owner-record" },
    "provider": { "state": "unknown" }
  }
}
```

At least one of `correlation` or `replyTo` is required. `ownerId` names the stable owner of the persistent delivery record; it is not `sourceAgent`, a worker PID, or a caller-selected label. `accepted` and `rejected` facts require explicit evidence. Provider acceptance remains `unknown` until the provider adapter records its own evidence; none of these states imply business completion.

## Shared message-data budget

The existing registry JSON holds allocations by stable persistent queue owner. An explicit operator sync grants each new owner 50,000,000 bytes by default. Four owners total 200,000,000 bytes; a fifth brings the total to 250,000,000 bytes. Repeating an owner does not add another allocation. Queue sends and reads never register owners or increase limits:

```powershell
node modules/agent-core/src/cli.mjs budget-init zcode-queue qoder-queue --registry E:\path\to\registry.json
node modules/agent-core/src/cli.mjs budget-status --registry E:\path\to\registry.json
'{"ownerIds":["mail-queue"]}' | node modules/agent-core/src/cli.mjs budget sync --registry E:\path\to\registry.json
'{"ownerId":"mail-queue","usedBytes":1024,"additionalBytes":2048}' | node modules/agent-core/src/cli.mjs budget check --registry E:\path\to\registry.json
```

`budget sync` reads one JSON object from stdin. It accepts `ownerIds` (stable persistent owners to add), `defaultOwnerBytes` (used only for future owners), `ownerOverrides` (owner ID to byte limit), and optional `globalLimitBytes`. Existing allocations stay as they are unless explicitly overridden. `totalBytes` remains the sum of allocations; when omitted, the global cap is that sum and grows only through trusted sync. A configured global cap blocks a sync that would exceed it, returning the byte shortfall without writing. Send `"globalLimitBytes":null` to remove that cap. `budget status` and `budget check` only read; `budget-init` and `budget-status` remain available to old CLI callers. Adapters still receive read-only `context.messageBudget.status()` and `context.messageBudget.check({ownerId,usedBytes,additionalBytes})`.

Existing fixed 20,000,000-byte and 200,000,000-byte records remain readable and unchanged. To convert one, explicitly run `budget sync` with `{"migrateLegacy":true,"ownerIds":[...]}`. Conversion preserves every existing owner quota and adds new owners at the configured default. Reducing an existing quota returns `owner_quota_reduction_requires_usage` with the requested byte difference because Core has no trustworthy shared usage snapshot. A managed provider deployment must update Core, the copied Qoder worker, and the Qoder return-store budget reader together before syncing beyond 200,000,000 bytes; their previous readers reject the new total.

Modules and the registry are trusted local code/configuration, writable only by their owner. Canonical entry/manifest containment protects registration paths and detects retargeted links; it is not a sandbox for a module's transitive imports, filesystem access, or malicious source replacement. Review a module before installing it. Module import and `describe()` must be side-effect-free with respect to provider actions and workers. The core relies on the trusted adapter's `readOnlyHint`, and the adapter owns domain-argument validation. The core validates the three public envelopes and routes only advertised operation names. Discovery returns copies so callers cannot change cached read/write classification.

## Packaging and stdio

`modules/agent-core/` is the complete standalone plugin source: `.codex-plugin/plugin.json`, `.mcp.json`, `package.json`, `src/`, README and the manifest example. It requires Node 24 or newer and no npm dependencies; copying this directory preserves its relative entry paths. Provider modules are separately copied/packaged and explicitly registered at their destination paths. Do not include a registry or provider data in a portable package. The repository marketplace exposes `agent-core`; CLI/MCP clients can use the same source without a Codex plugin installation. See the [root quick start](../../README.md).

For a direct transport check, set `AGENT_CORE_REGISTRY` and launch `node modules/agent-core/src/mcp-server.mjs`. The stream is newline-delimited JSON-RPC on stdin/stdout; only the three public tool names are advertised. It negotiates MCP `2025-06-18`, ignores notifications without dispatching actions, reports tool failures as `result.isError`, and drains accepted requests on stdin EOF before flushing stdout and exiting. An already-dispatched provider call that never settles can delay EOF exit; the core does not replay or automatically cancel it. Adapters must reserve stdout for this protocol and send diagnostics to stderr.

## Local checks

```powershell
node modules/agent-core/test/agent-core.test.mjs
node modules/agent-mail/adapter.test.mjs
```

The self-test uses temporary registries, two fake adapters, a real competing CLI process and a real MCP child. It covers lazy metadata discovery, one selected schema, shared concurrent load, defensive description copies, cross-instance disable/uninstall, changed registration during `describe()`, traversal/junction escape, malformed arguments, domain error propagation, read/action routing, a writer-lock conflict and successful later retry, notification non-execution, malformed JSON, and EOF draining/exit. Fake adapter success does not establish real Qoder/ZCode capability or native Codex activation.

See [tested integration scope](../../docs/compatibility.md) for native evidence. Passing this offline suite alone does not establish provider installation or business completion.
