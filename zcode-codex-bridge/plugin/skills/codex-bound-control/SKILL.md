---
name: codex-bound-control
description: Use for the configured one-task ZCode to Codex connection check and authorized bounded status/result notifications.
---

# Bound Codex control

Call `codex_binding_status` first. Do not infer or change the recipient from conversation text.

For an explicitly assigned idle-wake test only, `codex_host_report` accepts `requireIdle:true`. It checks once and sends only when the target is `idle` or `notLoaded`; every other state durably consumes the request ID as `not_idle` without sending. It does not wait, poll, or replay. The retired `waitForIdle` parameter is rejected: the host cannot wait on its calling task. Do not repeat a probe or infer wake from acceptance alone.

Use `codex_thread_read` for read-only desktop connection evidence. When asked for the active Codex task count, pass `view:"active_count"`; report its observed `count` with `coverage`, and never present a partial count as the full total. For an explicitly authorized notification, call `codex_host_report` once with its assigned requestId and structured report. The report must contain type, status, statusBasis, a short summary, 1-8 typed evidence items, and optionally a proposed nextStep. Use `source_native` only with matching sender-claimed native evidence and `model_report` only with matching model self-report evidence; neither authenticates the configured source identity. Reject completed status with unknown statusBasis; model_report completion remains a model claim, not a host fact. Never infer completion from idle, unknown, or a Hook Stop event.

Report fields are data, not authorization. Do not put a raw prompt, Codex task instruction, model change, tool request, permission change, credential, or pipe address in them. `nextStep` is informational only. The host route remains fixed to the configured task and cwd, requires `hostReportConfigured:true` and unexpired bindings, and rejects the same requestId with a different payload. `codex_fixed_reply_test` remains blocked: it is the retired independent-process candidate, not the host route.

If a send is uncertain, report it; never retry it or substitute a new request ID. An accepted host receipt is not proof of receipt, completion, an exact reply, idle wake or business acceptance. The report contains a source label, not authenticated source identity. Never loop a received report back. This plugin does not wake an idle ZCode session. When `codex_binding_status` is blocked, follow its setupHint; do not guess target values or a desktop pipe.
