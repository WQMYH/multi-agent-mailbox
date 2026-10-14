import { inspect } from 'node:util';

const codes = {
  sdk_load: ['sdk_load_failed'],
  preflight: ['native_preflight_failed'],
  startup: ['native_startup_failed'],
  query: ['native_query_failed'],
  frame_validation: ['frame_limit', 'session_mismatch', 'lifecycle_mismatch', 'assistant_invalid',
    'result_invalid', 'terminal_incomplete', 'terminal_invalid'],
  cleanup: ['native_close_failed'],
  dispatch_marker: ['dispatch_marker_failed'],
  queue_finalize: ['queue_finalize_failed']
};

// Only adapter-owned codes cross the tool/database boundary, never SDK text or frame contents.
export function readNativeDiagnostics(value) {
  try {
    if (typeof value === 'string' && value.length > 1024) return undefined;
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (data?.schemaVersion !== 1 || data.outcome !== 'unknown' || data.retrySafe !== false) return undefined;
    const result = { schemaVersion: 1, outcome: 'unknown', retrySafe: false };
    for (const key of ['primary', 'cleanup', 'finalization']) {
      const entry = data[key];
      if (entry && typeof entry.phase === 'string' && typeof entry.code === 'string' && codes[entry.phase]?.includes(entry.code))
        result[key] = { phase: entry.phase, code: entry.code };
    }
    return result.primary ? result : undefined;
  } catch { return undefined; }
}

class NativeFailure extends Error {
  constructor(phase, code, cause) {
    super(`Native Qoder operation failed [${phase}/${code}]; outcome unknown, never retry through another transport`, { cause });
    this.diagnostics = readNativeDiagnostics({ schemaVersion: 1, outcome: 'unknown', retrySafe: false,
      primary: { phase, code } });
  }
  [inspect.custom]() { return `${this.message} ${JSON.stringify(this.diagnostics)}`; }
}

export const nativeDiagnostics = error => error instanceof NativeFailure ? readNativeDiagnostics(error.diagnostics) : undefined;
export const nativeFailure = (phase, code, cause) => cause instanceof NativeFailure ? cause : new NativeFailure(phase, code, cause);

export function secondaryNativeFailure(error, kind, cause) {
  const phase = kind === 'cleanup' ? 'cleanup' : 'queue_finalize';
  const code = kind === 'cleanup' ? 'native_close_failed' : 'queue_finalize_failed';
  const result = error ? nativeFailure('preflight', 'native_preflight_failed', error) : nativeFailure(phase, code, cause);
  result.diagnostics[kind] = { phase, code };
  Object.defineProperty(result, `${kind}Cause`, { value: cause, configurable: true });
  if (cause?.code === 'QODER_BUDGET_BLOCKED') result.code = 'QODER_BUDGET_BLOCKED';
  result.message += `; ${phase}/${code}`;
  return result;
}
