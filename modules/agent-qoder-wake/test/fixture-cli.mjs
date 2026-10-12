// Offline native-product double. This file never calls QoderWake or a model.
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const mode = process.env.WAKE_TEST_MODE;
const wakerId = 'abcdef123456', sessionId = '00000000-0000-4000-8000-000000000010';
const resident = ['resident', 'pending-resident', 'terminal-resident', 'unknown-resident', 'incomplete-resident'].includes(mode);
const released = mode?.startsWith('released-') && mode !== 'released-live';
const session = { sessionId, agentId: wakerId, status: mode === 'stopped' || resident ? 'stopped' : 'running',
  title: 'Offline fixture', cwd: process.env.WAKE_TEST_WORKSPACE, runtimeState: resident ? 'waiting_input' : 'running',
  ...(resident ? { runtimePresence: 'idle_resident' } : {}),
  ...(mode === 'terminal-resident' ? { runtimeState: 'terminal_stopped', runtimePresence: 'released' } : {}),
  ...(mode === 'unknown-resident' ? { runtimePresence: 'unknown' } : {}),
  ...(mode === 'incomplete-resident' ? { runtimeState: 'running' } : {}),
  ...(mode === 'released-live' ? { runtimePresence: 'released' } : {}),
  ...(released ? { status: 'stopped', runtimeState: 'waiting_input', runtimePresence: 'released', pid: null,
    sdkTranscriptState: 'ready', runtimeRestartRequired: false, runtimeRoute: 'sdk_local',
    lifecycleProfile: 'console_conversation', selectedRuntimeTransport: 'process' } : {}),
  ...(mode === 'released-not-ready' ? { sdkTranscriptState: 'unknown' } : {}),
  ...(mode === 'released-restart' ? { runtimeRestartRequired: true } : {}),
  ...(mode === 'released-active-pid' ? { pid: 1234 } : {}),
  ...(mode === 'released-no-pid' ? { pid: undefined } : {}),
  ...(mode === 'released-route' ? { runtimeRoute: 'other' } : {}),
  ...(mode === 'released-profile' ? { lifecycleProfile: 'other' } : {}),
  ...(mode === 'released-transport' ? { selectedRuntimeTransport: 'other' } : {}),
  ...(mode === 'released-terminal' ? { runtimeState: 'terminal_stopped' } : {}),
  apiKey: 'PRIVATE_SENTINEL', message: 'PRIVATE_SENTINEL' };
const value = name => args[args.indexOf(name) + 1];
const out = value => process.stdout.write(JSON.stringify(value));
appendFileSync(process.env.WAKE_TEST_CALL_LOG, JSON.stringify({ args, home: process.env.QODERWAKE_HOME, cwd: process.cwd(), daemonUrlPresent: process.env.QODERWAKE_DAEMON_URL !== undefined }) + '\n');
if (args[0] === '--version') process.stdout.write('1.1.7-cn\n');
else if (args[0] === 'status') out({ running: true, reachable: true, pid: 4242, port: 12345, token: 'PRIVATE_SENTINEL' });
else if (args[0] === 'local') out([{ agentId: wakerId, name: '资料与版本整理员', status: 'online', profile: 'PRIVATE_SENTINEL' },
  { agentId: 'other', name: 'Not allowed', status: 'online' }]);
else if (args[0] === 'waker') out({ agentId: mode === 'wrong-agent' ? 'other' : value('--waker-id'), name: '资料与版本整理员', status: 'online', credential: 'PRIVATE_SENTINEL' });
else if (args[0] === 'permission') out(['pending', 'pending-resident', 'released-pending'].includes(mode) ? [{ requestId: 'approval1', sessionId, body: 'PRIVATE_SENTINEL' }] : []);
else if (args[1] === 'list') out([{ ...session, ...(mode === 'outside-root' ? { cwd: process.env.WAKE_TEST_OTHER_ROOT } : {}) },
  ...(existsSync(process.env.WAKE_TEST_CREATED) ? [{ ...session, sessionId: 'native-created-session' }] : [])]);
else if (args[1] === 'stream') {
  if (mode === 'sse-raw') process.stdout.write('PRIVATE_SENTINEL');
  else {
  const run = { run_id: 'fixture-native-run', runtime_run_id: 'fixture-runtime-run', runtime_epoch: 1 };
  const event = (sequence, kind, payload) => ({ event_id: `fixture-event-${sequence}`, session_id: sessionId,
    sequence_num: sequence, source: 'fixture', event_type: kind, created_at: '2026-10-12T00:00:00Z', payload: { ...run, ...payload } });
  let events = [event(1000000001, 'runtime.state.changed', { state: 'starting', previous_state: null }),
    event(1000000002, 'user', { message: { role: 'user', content: [{ type: 'text', text: 'Current scoped input' }] } }),
    event(1000000004, 'system', { account: 'PRIVATE_SENTINEL', profile: 'PRIVATE_SENTINEL' }),
    event(1000000035, 'assistant', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_SENTINEL' }] } }),
    event(1000000042, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: mode === 'sse-long-text' ? '正文'.repeat(8000) : 'Bounded scoped reply' },
      { type: 'image', account: 'PRIVATE_SENTINEL' }] }, execution_metrics: { token: 'PRIVATE_SENTINEL' } }),
    event(1000000045, 'execution.metrics', { account: 'PRIVATE_SENTINEL' }),
    event(1000000047, 'result', { subtype: 'success', is_error: false, result: 'Bounded scoped reply', token: 'PRIVATE_SENTINEL' }),
    event(1000000048, 'runtime.state.changed', { state: 'waiting_input', previous_state: 'running', reason: 'turn_result' })];
  if (['sse-budget-tail', 'sse-budget-adjacent'].includes(mode)) events = [
    ...Array.from({ length: 4 }, (_, index) => event(1000000001 + index * (mode === 'sse-budget-adjacent' ? 1 : 10), 'assistant',
      { message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2048) }] } })),
    event(mode === 'sse-budget-adjacent' ? 1000000005 : 1000000041, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'FIFTH_SCOPED_REPLY' }] } }),
    event(mode === 'sse-budget-adjacent' ? 1000000006 : 1000000048, 'runtime.state.changed', { state: 'waiting_input', previous_state: 'running' }),
    event(mode === 'sse-budget-adjacent' ? 1000000007 : 1000000050, 'system', { profile: 'PRIVATE_SENTINEL' })
  ];
  if (['sse-adjacent', 'sse-gap'].includes(mode)) events = [
    event(1000000396, 'user', { message: { role: 'user', content: [{ type: 'text', text: 'SCOPED_INPUT_396' }] } }),
    event(mode === 'sse-gap' ? 1000000400 : 1000000397, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'SCOPED_REPLY' }] } }),
    event(mode === 'sse-gap' ? 1000000404 : 1000000398, 'runtime.state.changed', { state: 'waiting_input', previous_state: 'running' })
  ];
  if (mode === 'sse-boundary') events = [event(Number.MAX_SAFE_INTEGER, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'SAFE_BOUNDARY_REPLY' }] } })];
  if (mode === 'sse-many') for (let sequence = 1000000049; sequence < 1000000649; sequence++) events.push(event(sequence, 'system', { profile: 'PRIVATE_SENTINEL' }));
  events = events.filter(item => item.sequence_num > Number(value('--from-sequence-num')));
  if (mode === 'sse-wrong-session' && events.length) events[0].session_id = 'another-session';
  if (mode === 'sse-duplicate' && events.length) events.push(events[0]);
  if (mode !== 'sse-empty') for (const item of events) process.stdout.write(`data: ${JSON.stringify(item)}\r\n\r\n`);
  if (mode === 'sse-bad') process.stdout.write('data: PRIVATE_SENTINEL\n\n');
  if (mode === 'sse-partial') process.stdout.write('data: {"profile":"PRIVATE_SENTINEL');
  if (mode === 'sse-maxbuffer') process.stdout.write(': ' + 'PRIVATE_SENTINEL'.repeat(25000));
  else if (mode !== 'sse-partial') process.stdout.write(': heartbeat\n\n');
  if (mode === 'sse-timeout') setInterval(() => process.stdout.write(': heartbeat\n\n'), 1000);
  }
}
else if (['create', 'send', 'interrupt'].includes(args[1])) {
  if (process.env.WAKE_TEST_GATE) while (!existsSync(process.env.WAKE_TEST_GATE)) await delay(10);
  if (mode === 'error') { process.stderr.write('PRIVATE_SENTINEL'); process.exit(2); }
  if (mode === 'malformed') { process.stdout.write('PRIVATE_SENTINEL'); process.exit(0); }
  if (mode === 'wrong-result') out({ success: true, sessionId: 'other-session' });
  else if (args[1] === 'create') {
    appendFileSync(process.env.WAKE_TEST_CREATED, 'created');
    out({ sessionId: 'native-created-session', secret: 'PRIVATE_SENTINEL' });
  } else if (args[1] === 'send') {
    const ack = { event_id: 'fixture-user-event', sequence_num: 1000000051 };
    if (mode === 'ack-zero-success') out({ success: true });
    else if (mode === 'ack-empty') out({ results: [] });
    else if (mode === 'ack-multi') out({ results: [ack, { ...ack, event_id: 'another-event', sequence_num: 1000000052 }] });
    else if (mode === 'ack-bad-id') out({ results: [{ ...ack, event_id: 42 }] });
    else if (mode === 'ack-bad-sequence') out({ results: [{ ...ack, sequence_num: '1000000051' }] });
    else if (mode === 'ack-unsafe-sequence') out({ results: [{ ...ack, sequence_num: Number.MAX_SAFE_INTEGER + 1 }] });
    else if (mode === 'ack-negative-sequence') out({ results: [{ ...ack, sequence_num: -1 }] });
    else if (mode === 'ack-error') out({ results: [ack], error: 'PRIVATE_SENTINEL' });
    else if (mode === 'ack-entry-error') out({ results: [{ ...ack, error: 'PRIVATE_SENTINEL' }] });
    else out({ results: [ack] });
  } else if (args[1] === 'interrupt') {
    const ack = { event_id: 'console-interrupt:control-request:fixture-request', sequence_num: 1000000191 };
    if (mode === 'interrupt-ack-bool') out({ success: true });
    else if (mode === 'interrupt-ack-empty') out({ results: [], runtimeState: null });
    else if (mode === 'interrupt-ack-multi') out({ results: [ack, { ...ack, event_id: 'another-control' }], runtimeState: null });
    else if (mode === 'interrupt-ack-bad-type') out({ results: [ack], runtimeState: 42 });
    else if (mode === 'interrupt-ack-false') out({ results: [ack], runtimeState: false });
    else if (mode === 'interrupt-ack-error') out({ results: [ack], runtimeState: null, error: 'PRIVATE_SENTINEL' });
    else if (mode === 'interrupt-ack-denied') out({ results: [ack], runtimeState: null, accepted: false });
    else if (mode === 'interrupt-ack-bad-coordinate') out({ results: [{ ...ack, sequence_num: '1000000191' }], runtimeState: null });
    else out({ results: [ack], runtimeState: mode === 'interrupt-ack-null' ? null : 'SIMULATED_STATE' });
  } else out({ success: true, token: 'PRIVATE_SENTINEL' });
} else { process.stderr.write('PRIVATE_SENTINEL'); process.exit(2); }
