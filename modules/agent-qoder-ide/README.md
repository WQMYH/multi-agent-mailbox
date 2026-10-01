# Qoder CN IDE module

This experimental module routes the existing Agent Core tools to an authenticated loopback bridge installed inside Qoder CN IDE. It does not launch the IDE, use the mouse/keyboard, or create another queue.

Create `%USERPROFILE%/.codex-agent-core/agent-qoder-ide.json` from `config.example.json`, using a random token of at least 32 characters and an absolute state directory. The VSIX and this module read the same file. Do not commit or package the real config.

Restrict the real config to the current Windows user. `instances` reads local rendezvous metadata and may include a crashed stale process; `identity` is the authenticated live check. The identity field `registeredCommands` means command IDs are present in the host catalog, not that their owning extension has already loaded. A real `executeCommand` return/error is recorded separately.

The no-model CLI uses the same path. Toolkit mutations reuse the sibling `agent-core` source in this repository layout and read its existing registry (`AGENT_CORE_REGISTRY` or its default path); they do not allocate or reconfigure a budget. Installed module operations obtain this same allocation through Core's supplied context:

```powershell
node modules/agent-qoder-ide/cli.mjs instances
node modules/agent-qoder-ide/cli.mjs identity INSTANCE_ID E:\absolute\workspace
node modules/agent-qoder-ide/cli.mjs toolkit INSTANCE_ID E:\absolute\workspace px.runTiger E:\absolute\workspace\fixture-mod
```

`px.runTiger` returns `accepted` with `completion: unobservable_after_command_return`: Toolkit starts Tiger but does not await or return its completion. `px.reloadScriptDocs` and `px.dumpIndexStats` report command-return completion only and require a single-folder IDE workspace. `px.tigerUnused` likewise has unobservable Tiger completion and requires a single-folder workspace.

`conversation_activate` invokes the known Qoder history action for one explicit session descriptor. `conversation_send_current` sends once to whichever page is current at dispatch with `isNewChat:false`; activation plus send is not atomic targeting, and manual page switching can redirect the message. The bridge serializes command writes within one IDE instance, but it cannot lock the current page.

Page sends append an `[agent-core-request:<requestId>]` correlation suffix, then persist one non-queue delivery reservation. The stable owner ID is derived from the canonical state-directory identity, so aliases share one owner and different stores require different Core allocations. Claims, messages and Hook updates share one store lock. Admission physically commits space for the bounded final record plus one same-sized atomic replacement, so missing capacity returns backpressure before command dispatch instead of failing a later legal Hook. Windows named-pipe ownership now provides the operation-scoped lock and releases automatically on process exit, with zero new disk lock helpers. Before any claim, Hook or read continues, the holder preserves the atomic old-or-new record, removes only validated dead-PID legacy lock files and orphan transaction helpers, and restores committed headroom. Active or unprovable legacy ownership remains backpressure; non-Windows stores return `LOCK_UNSUPPORTED`. The owner receipt proves only the durable reservation, not provider delivery.

`conversation_status` reads the same record without consuming or acknowledging it. A matching `UserPromptSubmit` Hook proves provider input acceptance. An exact duplicate is idempotent; conflicting session/transcript/request-set attribution is persisted as quarantine and withdraws provider acceptance. A reply preview is attributed only when a later Stop Hook has the same native `session_id`, `transcript_path`, and non-empty `request_set_id`; absent native request-set correlation is reported as unsupported. The marker, command return, or Stop alone never establishes delivery completion or business acceptance.

All mutating operations require the same store owner's real Core allocation and physically peak-check each persistent request-ID claim across command types and bridge restarts. A corrected attempt after any retained claim requires a fresh request ID; this does not claim dispatch. If `executeCommand` times out while its native promise remains pending, the HTTP result is unknown but the instance's mutating lane stays isolated until that promise actually settles. Status reads remain available; the bridge neither replays nor pretends to cancel the operation.

Native installation and live IDE testing are coordinator gates. Registering this module, installing the VSIX, configuring a token, and observing a useful Toolkit result remain separate states. The client requires `capabilities.mutationOwnerBudget:true` in both the selected instance record and its authenticated live identity before every mutation; vendor/bridge versions and local metadata alone are not enforcement signals. Previously loaded source5 windows do not gain this capability merely because a new VSIX is installed. Keep those windows untouched and select a paired upgraded isolated instance, checking its authenticated identity before an authorized action. Read-only identity/status remain available for unsupported instances.

After source acceptance, install the companion VSIX using the exact intended Qoder CN IDE executable, copy this directory as a complete module root, and register that root through Agent Core's CLI. Start validation with `instances` and authenticated `identity`; invoke `toolkit_check` only against an isolated explicit workspace/fixture. A new Codex task may be needed for the host to advertise a newly registered module.
