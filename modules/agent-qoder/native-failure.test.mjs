import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeDiagnostics, nativeDiagnostics, nativeFailure, secondaryNativeFailure } from './native-failure.mjs';

test('stored diagnostics project only bounded adapter-owned codes', () => {
  const base = { schemaVersion: 1, outcome: 'unknown', retrySafe: false,
    primary: { phase: 'query', code: 'native_query_failed', secret: 'not-public' }, cause: 'not-public' };
  assert.deepEqual(readNativeDiagnostics(JSON.stringify(base)), {
    schemaVersion: 1, outcome: 'unknown', retrySafe: false, primary: { phase: 'query', code: 'native_query_failed' }
  });
  for (const bad of [null, '{', 'x'.repeat(1025), { ...base, retrySafe: true },
    { ...base, primary: { phase: ['query'], code: 'native_query_failed' } },
    { ...base, primary: { phase: 'query', code: 'raw-private-stderr' } }]) assert.equal(readNativeDiagnostics(bad), undefined);
  assert.equal(nativeDiagnostics(Object.assign(Error('foreign'), { diagnostics: base })), undefined);
});

test('secondary failure retains the original cause identity and stable primary code', () => {
  const primary = Error('private-startup'), cleanup = Error('private-close'), finalization = Error('private-db');
  const error = nativeFailure('startup', 'native_startup_failed', primary);
  assert.equal(secondaryNativeFailure(error, 'cleanup', cleanup), error);
  assert.equal(secondaryNativeFailure(error, 'finalization', finalization), error);
  assert.equal(error.cause, primary); assert.equal(error.cleanupCause, cleanup); assert.equal(error.finalizationCause, finalization);
  assert.deepEqual(error.diagnostics.primary, { phase: 'startup', code: 'native_startup_failed' });
  assert(!JSON.stringify(error).includes('private-'));
});
