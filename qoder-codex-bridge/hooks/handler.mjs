import { existsSync, realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvent, loadBinding, recordEvent, validateHookInput, signalForHook,
  parseMarker, readSubmission, createSubmission, updateSubmission, withSubmissionLock
} from "../scripts/event-recorder.mjs";
import { sendNotification } from "../scripts/host-notifier.mjs";

const canonical = value => {
  const path = resolve(value);
  return normalize(existsSync(path) ? realpathSync.native(path) : path).toLowerCase();
};

export async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 65536) throw Error("Hook input too large");
  }
  return JSON.parse(raw);
}

// Layer 1 — trusted session mapping (plan §4): a hook event may be attributed to the
// fixed request only when BOTH its runtime session_id and its cwd match the verified
// binding. Never infer attribution from recency.
function correlateSession(input, binding) {
  const reasons = [];
  if (typeof input.cwd !== "string" || !input.cwd) reasons.push("hook_input_cwd_missing");
  else { try { if (canonical(input.cwd) !== canonical(binding.cwd)) reasons.push("cwd_mismatch"); } catch { reasons.push("cwd_unresolvable"); } }
  if (input.session_id !== binding.hookSessionId) reasons.push("session_mismatch");
  return reasons;
}

// Layer 2 — request attribution (plan §4). The prompt marker is only a correlation tag.
// Every attribution decision that authorizes a notification is a DURABLE, read-after-write
// verified transition: a submission is opened by an exclusive create (the cross-process
// arbitration primitive), a second submission while one is in flight is durably marked
// ambiguous, and a terminal event may only relay after it has durably consumed the anchor.
// The complete decision runs under withSubmissionLock. Failure of all persistence
// remains an explicit contract boundary pending a trusted native observation source.
function correlateRequest(input, binding, dir) {
  const hookSession = input.session_id;
  const anchor = readSubmission(dir, hookSession);
  if (anchor && anchor.invalid) return { ok: false, reason: "submission_record_invalid" };

  if (input.hook_event_name === "UserPromptSubmit") {
    if (anchor) {
      // A submission already owns this session. If it is the matching one and still in flight,
      // ANY further input is extra/overlap and must be durably marked ambiguous before a later
      // terminal event can be relayed. A foreign or completed-terminal anchor is decided by marker.
      if (anchor.requestId !== binding.requestId)
        return { ok: false, reason: anchor.terminal ? "submission_foreign_terminal" : "submission_foreign" };
      if (!anchor.terminal) {
        const marked = updateSubmission(dir, hookSession, a => { a.ambiguous = true; });
        return marked ? { ok: false, reason: "submission_overlap" } : { ok: false, unpersistable: true, reason: "submission_overlap" };
      }
      // A fixed request is single-use. Reopening it could attribute another turn's
      // Stop to the old request, whose input receipt is already deduplicated.
      return { ok: false, reason: "duplicate_submission" };
    }
    // No anchor yet: a single clean marker matching the binding opens the one in-flight submission.
    const marker = parseMarker(input.prompt);
    if (marker.status === "ambiguous") return { ok: false, reason: "request_marker_ambiguous" };
    if (marker.status !== "ok") return { ok: false, reason: "request_marker_missing" };
    if (marker.requestId !== binding.requestId) return { ok: false, reason: "request_marker_mismatch" };
    const created = createSubmission(dir, { requestId: binding.requestId, hookSessionId: hookSession, cwd: input.cwd });
    if (created.conflict) {
      const marked = updateSubmission(dir, hookSession, a => { a.ambiguous = true; });
      return marked ? { ok: false, reason: "submission_race" } : { ok: false, unpersistable: true, reason: "submission_race" };
    }
    if (!created.created) return { ok: false, unpersistable: true, reason: "attribution_unpersistable",
      ...(created.diagnosticCode ? { diagnosticCode: created.diagnosticCode } : {}),
      ...(Number.isSafeInteger(created.deltaBytes) ? { deltaBytes: created.deltaBytes } : {}) };
    return { ok: true };
  }

  // Stop / StopFailure
  if (!anchor) return { ok: false, reason: "no_matched_submission" };
  if (anchor.ambiguous) return { ok: false, reason: "submission_ambiguous" };
  if (anchor.terminal) return { ok: false, reason: "duplicate_terminal" };
  if (anchor.requestId !== binding.requestId) return { ok: false, reason: "submission_foreign" };
  try { if (canonical(anchor.cwd) !== canonical(binding.cwd)) return { ok: false, reason: "submission_cwd_mismatch" }; }
  catch { return { ok: false, reason: "submission_cwd_unresolvable" }; }
  // A terminal notification may only be announced after the anchor is durably consumed.
  const consumed = updateSubmission(dir, hookSession, a => { a.terminal = true; });
  if (!consumed) return { ok: false, unpersistable: true, reason: "attribution_unpersistable" };
  return { ok: true };
}

export async function handle(input, { dataDir, now, transport } = {}) {
  const dir = dataDir ?? process.env.QODER_PLUGIN_DATA;
  if (!dir) return { state: "host_binding_missing", notified: false, diagnostics: [{ code: "data_path_missing", message: "QODER_PLUGIN_DATA not set" }] };

  try {
    validateHookInput(input);
  } catch (error) {
    return { state: "invalid_input", failClosed: true, notified: false, diagnostics: [{ code: "invalid_hook_input", message: error.message }] };
  }

  const signal = signalForHook(input.hook_event_name);
  if (signal === null)
    return { state: "observed_only", notified: false, recorded: false, failClosed: false, diagnostics: [{ code: "session_start_observe_only", message: "SessionStart is observe-only and is not a matched submission" }] };
  if (typeof input.cwd !== "string" || !input.cwd)
    return { state: "uncorrelated", failClosed: true, blockInput: false, notified: false, recorded: false, diagnostics: [{ code: "hook_input_cwd_missing", message: "Event not attributable without cwd" }] };

  const anchor = readSubmission(dir, input.session_id);
  if (anchor?.invalid) {
    const code = anchor.quarantined || anchor.conflicted ? "submission_concurrent" : "submission_record_invalid";
    return { state: "uncorrelated", failClosed: true, blockInput: false, notified: false, recorded: false, diagnostics: [{ code, message: "Request attribution record is not trustworthy" }] };
  }
  let requestId = anchor?.requestId;
  if (!requestId && input.hook_event_name === "UserPromptSubmit") {
    const marker = parseMarker(input.prompt);
    if (marker.status !== "ok")
      return { state: "uncorrelated", failClosed: true, blockInput: false, notified: false, recorded: false, diagnostics: [{ code: marker.status === "ambiguous" ? "request_marker_ambiguous" : "request_marker_missing", message: "Request marker does not select exactly one binding" }] };
    requestId = marker.requestId;
  }
  if (!requestId)
    return { state: "uncorrelated", failClosed: true, blockInput: false, notified: false, recorded: false, diagnostics: [{ code: "no_matched_submission", message: "No matched submission selects a binding" }] };

  let binding;
  try {
    binding = loadBinding(dir, { requestId, hookSessionId: input.session_id, cwd: input.cwd });
  } catch (error) {
    const code = error.code === "host_binding_unmatched" && !anchor && input.hook_event_name === "UserPromptSubmit"
      ? "request_marker_mismatch" : error.code;
    const uncorrelated = ["host_binding_unmatched", "host_binding_ambiguous", "host_binding_expired", "host_binding_selector_invalid"].includes(error.code);
    return { state: uncorrelated ? "uncorrelated" : "host_binding_missing", failClosed: uncorrelated, blockInput: false, notified: false, recorded: false,
      diagnostics: [{ code: code ?? "host_binding_error", message: error.message }] };
  }

  const sessionMismatch = correlateSession(input, binding);
  if (sessionMismatch.length)
    return { state: "uncorrelated", failClosed: true, notified: false, recorded: false, diagnostics: sessionMismatch.map(code => ({ code, message: "Event not attributable to the bound session/cwd" })) };

  // Keep the attribution lock until the matched event is durably recorded. A failed
  // receipt write must not leave an apparently active anchor for a later Stop.
  const request = withSubmissionLock(dir, input.session_id, () => {
    const attribution = correlateRequest(input, binding, dir);
    if (!attribution.ok) return attribution;
    const event = buildEvent(input, binding, { now });
    try {
      const result = recordEvent(dir, event, { now, binding });
      if (result.conflict) return { ok: false, unpersistable: true, conflict: true, reason: result.reason };
      return { ok: true, event, result };
    } catch (error) {
      return { ok: false, unpersistable: true, reason: "event_record_failed",
        ...(typeof error.code === "string" && error.code.startsWith("store_") ? { diagnosticCode: error.code } : {}),
        ...(Number.isSafeInteger(error.deltaBytes) ? { deltaBytes: error.deltaBytes } : {}) };
    }
  });
  if (!request.ok) {
    const state = request.conflict ? "uncorrelated" : request.reason === "event_record_failed" ? "record_unpersistable" : request.unpersistable ? "attribution_unpersistable" : "uncorrelated";
    return { state, failClosed: true, blockInput: input.hook_event_name === "UserPromptSubmit" && !!request.unpersistable,
      notified: false, recorded: false, conflict: !!request.conflict,
      diagnostics: [{ code: request.diagnosticCode ?? request.reason,
        message: "Request attribution or event receipt could not be durably recorded",
        ...(Number.isSafeInteger(request.deltaBytes) ? { deltaBytes: request.deltaBytes } : {}) }] };
  }
  const { event, result } = request;
  if (result.deduplicated)
    return { state: "recorded", deduplicated: true, notified: false, alreadyNotified: result.record?.sendState === "accepted", record: result.record };

  try {
    const options = transport ? { timeoutMs: 10000, ...transport } : { timeoutMs: 10000 };
    const receipt = await sendNotification(binding, dir, event, options);
    return { state: "notified", record: result.record, receipt };
  } catch (error) {
    if (error.dispatched === false) {
      const code = error.code ?? "host_config_invalid";
      return { state: "recorded_not_dispatched", notified: false, record: result.record, diagnostics: [{ code, message: error.message }] };
    }
    return { state: "recorded_send_uncertain", notified: false, record: result.record, error: error.message };
  }
}

async function main() {
  const input = await readStdin();
  const result = await handle(input);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.blockInput) process.exitCode = 2;
  else if (result.failClosed) process.exitCode = 1;
}

const isDirect = canonical(fileURLToPath(import.meta.url)) === canonical(process.argv[1] ?? "");
if (isDirect) main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
