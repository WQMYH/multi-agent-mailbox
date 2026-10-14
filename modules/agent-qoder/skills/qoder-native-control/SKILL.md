---
name: qoder-native-control
description: Use Qoder CN through the native-first Core adapter for session discovery, governed message creation and managed-session continuation. Use when coordinating Qoder tasks and their receipts; not for Qwen, international Qoder, IDE automation or desktop UI control.
---

# Qoder CN native-first control

Discover `agent-qoder` with the existing Core `agent_discover` entry, then use its returned operation names through `agent_read` or `agent_act`. Do not invent another sender. The installed module supplies the official CN SDK and its operator config supplies `cliExecutable`; reuse native login. Missing native capability is a setup result, not permission to launch/restart a product, enable CDP or install dependencies.

## Governed Core task

- Read `list_tasks`/`search_task` in the operator root. A listed desktop ID can also be a CLI session; a list entry or history timestamp does not establish idle, ownership or attachment to its live process.
- Create with `send_new_session` only when the user asked for a new task. Allocate session/request UUIDs once for that new intent and keep the returned request/delivery/owner/correlation.
- Continue with `send` only for a Core-created target in the managed-writers scope. Confirm that no desktop, manual CLI or external actor is writing that session. The module verifies the last observed native command/result and current history tail; this is not an atomic lock or a perpetual idle grant.
- Read `queue_status`/`message_observe` for retained evidence. Unknown, `needs_attention`, reserved or crash-left requests are never resent, renamed or moved to another transport/delivery owner. `recover_queue` resumes only the existing provider mechanism; it does not authorize replay.
- Native `command_uuid` is the input/turn correlation key. Result UUID and assistant UUID can differ from it. Owner acceptance, native acceptance/terminal result, return delivery, consumer confirmation and business acceptance are different outcomes.
- The headless native connection denies new permission prompts rather than approving them automatically. Unavailable live desktop permission/interruption methods must not be replaced by controlling a newly started CLI.

The existing Core CLI is also the command entry, using the same registry and execution as MCP. Supply the verified installed Core CLI path; for example in PowerShell:

```powershell
'{"moduleId":"agent-qoder"}' | node '<installed-Core>/src/cli.mjs' discover
'{"moduleId":"agent-qoder","operation":"list_tasks","args":{"limit":20}}' | node '<installed-Core>/src/cli.mjs' read
```

Use `act` with the same JSON shape only for the separately authorized operation returned by discovery. Do not copy SDK logic or bypass Core's budget and protected reservation path.

## Independent idle native session

An explicitly selected existing session outside Core ownership can be manually resumed through the official CN CLI `--resume <exact-session-id>` when the user explicitly authorized continuation and confirmed there is no concurrent writer. Shared history proves ID reuse, not idle. This is an independent native task, not a retry or completion of an unresolved Core request. If idle cannot be established, stop that path and return the missing condition to the coordinator.

CDP is a residual option only when the operator already enabled it and current discovery proves the required method. Never change transports after a failed side effect. Do not infer desktop visibility, consumer confirmation or task completion from a list entry, ACK or native result alone.
