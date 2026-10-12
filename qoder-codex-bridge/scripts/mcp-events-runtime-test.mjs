import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpEventsRuntime, privateConnectionFromEnv } from "./mcp-events-runtime.mjs";
import { createMcpEventsTransport } from "./mcp-events-transport.mjs";
import { managedStoreStatus, storeOwnerId } from "./store-budget.mjs";
import { chatTunnelCommand } from "../../modules/agent-core/src/chat-tunnel.mjs";

const root = fs.mkdtempSync(join(tmpdir(), "mcp-events-runtime-"));
const threadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", requestId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const sessionId = randomUUID(), policyPath = join(root, "read.json"), budgetCli = join(root, "budget.mjs");
const connection = { schemaVersion: 1, kind: "privateConnection", principalId: "user-delegated-private-tunnel", readSessionId: sessionId };
const env = { ...process.env, CODEX_CHAT_READ_SESSION: sessionId };
const secret = "whsec_" + Buffer.alloc(32, 1).toString("base64"), rotated = "whsec_" + Buffer.alloc(32, 2).toString("base64");
const params = { name: "codex.message.accepted", arguments: { requestId, threadId }, delivery: { mode: "webhook", url: "https://callback.example/event", secret }, ttlMs: null };
const unsub = { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } };
let active = true, clock = Date.now(), receiptState = "accepted";
const acceptedAt = new Date(clock).toISOString();
let beforeSessionResponse;
const owner = createServer(async (_request, response) => {
  const observed = { sessionId, supervisorPid: process.pid, stopping: !active };
  const change = beforeSessionResponse; beforeSessionResponse = undefined;
  await change?.(); // The old supervisor response remains valid while the actual policy writer revokes it.
  response.end(JSON.stringify(observed));
});
await new Promise(done => owner.listen(0, "127.0.0.1", done));
const policy = { schemaVersion: 2, mode: "temporary", threadIds: [threadId], workspaceRoots: [root], sessionId,
  ownerPid: process.pid, ownerUrl: `http://127.0.0.1:${owner.address().port}` };
fs.writeFileSync(policyPath, JSON.stringify(policy));
fs.writeFileSync(budgetCli, `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify({messageBudget:{schemaVersion:1,totalBytes:c.bytes,defaultOwnerBytes:c.bytes,allocations:[{ownerId:c.ownerId,bytes:c.bytes}]}}));`);
const children = new Set();
function store(label, bytes = 100000) {
  const dir = join(root, label); fs.mkdirSync(dir);
  const registryPath = join(dir, "registry.json"), ownerId = storeOwnerId(dir);
  fs.writeFileSync(registryPath, JSON.stringify({ ownerId, bytes }));
  fs.writeFileSync(join(dir, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId, coreCli: budgetCli, registryPath }));
  return dir;
}
const receipt = id => ({ requestId: id, threadId, deliveryId: `codex:${id}`, state: receiptState,
  acceptedAt, acceptance: { provider: { state: "accepted", evidence: "persisted_native_host_ack" } },
  consumer: { state: "unknown" }, businessAcceptance: { state: "unknown" } });
function io({ statuses = [], challenge = true, lookup } = {}) {
  let requests = 0;
  const packets = [], transport = createMcpEventsTransport({ lookup: lookup ?? (async () => [{ address: "8.8.8.8", family: 4 }]),
    request(options, respond) {
      requests++;
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = bytes => { const body = bytes.toString("utf8"), value = JSON.parse(body); packets.push({ body, value, headers: options.headers });
        queueMicrotask(() => { const res = new EventEmitter(); res.destroy = () => {}; res.complete = true;
          res.statusCode = value.type === "verification" ? 200 : statuses.shift() ?? 204;
          respond(res); res.emit("data", JSON.stringify(value.type === "verification" ? { challenge: challenge ? value.challenge : "wrong" } : {})); res.emit("end"); }); };
      return req;
    } });
  return { transport, packets, get requests() { return requests; } };
}
const runtime = (dataDir, transport) => createMcpEventsRuntime({ dataDir, readPolicyPath: policyPath, connection, env, transport,
  now: () => clock, pause: async ms => { clock += ms; }, readReceipt: receipt });
const saved = (dir, id) => JSON.parse(fs.readFileSync(join(dir, `events-subscription-${id.slice(4)}.json`), "utf8"));
const signal = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function childServer(dataDir, configured, preload) {
  const childEnv = { ...env, QODER_PLUGIN_DATA: dataDir, CODEX_CHAT_READ_CONFIG: policyPath };
  delete childEnv.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION;
  if (configured) childEnv.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION = JSON.stringify(connection);
  const program = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), program], { env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); let sequence = 0, stderr = "", stdout = ""; const pending = new Map();
  child.stderr.on("data", bytes => { stderr += bytes; }); child.stdout.on("data", bytes => { stdout += bytes; });
  createInterface({ input: child.stdout }).on("line", line => { const value = JSON.parse(line), call = pending.get(value.id);
    if (call) { clearTimeout(call.timer); pending.delete(value.id); call.resolve(value); } });
  child.on("exit", () => { children.delete(child); for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error("child exited")); } });
  return { async request(method, params = {}, extra = {}) { const id = ++sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("stdio timeout")), 10000); pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params, ...extra }) + "\n"); }); },
    close() { child.kill(); }, logs() { return stdout + stderr; } };
}

try {
  assert.equal(privateConnectionFromEnv({}), null);
  assert.throws(() => privateConnectionFromEnv({ CODEX_CHAT_EVENTS_PRIVATE_CONNECTION: '{}' }), /events_connection_invalid/);
  const legacy = childServer(store("legacy"), false);
  assert.equal((await legacy.request("server/discover", {}, { _meta: { principalId: connection.principalId } })).error.code, -32601);
  assert.equal((await legacy.request("initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18"); legacy.close();
  const endpoint = childServer(store("endpoint"), true);
  assert.deepEqual((await endpoint.request("server/discover")).result, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } });
  assert.equal((await endpoint.request("events/list")).result.events[0].name, params.name);
  const metadata = { progressToken: "transport-only-value", principalId: "forged-principal", readSessionId: randomUUID(),
    threadIds: [randomUUID()], workspaceRoots: ["forged-workspace"], ttlMs: null };
  const catalog = (await endpoint.request("events/list")).result;
  for (const listParams of [{ cursor: null }, { cursor: "" }, { _meta: metadata }, { cursor: null, _meta: metadata }])
    assert.deepEqual((await endpoint.request("events/list", listParams)).result, catalog);
  for (const listParams of [{ cursor: "not-issued" }, { cursor: 0 }, { _meta: null }, { _meta: [] },
    { principalId: connection.principalId }, { ttlMs: null }, { arguments: {} }])
    assert.equal((await endpoint.request("events/list", listParams)).error.code, -32602);
  const keyOnly = "unknown-business-key-" + "x".repeat(80);
  assert.equal((await endpoint.request("events/list", { cursor: null, _meta: metadata, [keyOnly]: "private-business-value" })).error.code, -32602);
  assert.equal((await endpoint.request("events/list", Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`unknown${i}`, "private-business-value"])))).error.code, -32602);
  const startTraces = endpoint.logs().split("\n").filter(Boolean).map(JSON.parse)
    .filter(trace => trace.method === "events/list" && trace.phase === "start");
  assert(startTraces.some(trace => trace.param_keys_types?.some(([key, type]) => key === "cursor" && type === "null")
    && trace.param_keys_types.some(([key, type]) => key === "_meta" && type === "object")));
  assert(startTraces.some(trace => trace.param_keys_types?.some(([key, type]) => key === keyOnly.slice(0, 64) && type === "string")));
  assert(startTraces.some(trace => trace.param_keys_types.length === 16));
  assert(startTraces.every(trace => trace.param_keys_types.length <= 16 && trace.param_keys_types.every(([key]) => key.length <= 64)));
  for (const value of ["transport-only-value", "forged-principal", "forged-workspace", "private-business-value"])
    assert(!endpoint.logs().includes(value));
  assert((await endpoint.request("tools/list")).result.tools.some(tool => tool.name === "read_codex" && tool.annotations.readOnlyHint === true));
  assert.equal((await endpoint.request("events/subscribe", { ...params, principalId: "forged" })).error.code, -32602); endpoint.close();

  const dir = store("delivery"), network = io({ statuses: [503, 204] }), events = runtime(dir, network.transport);
  const subscription = await events.subscribe(params);
  const beforeList = fs.readFileSync(join(dir, `events-subscription-${subscription.id.slice(4)}.json`), "utf8"), beforeNetwork = network.requests;
  assert.equal((await events.list({ cursor: null, _meta: metadata })).events[0].name, params.name);
  assert.equal(fs.readFileSync(join(dir, `events-subscription-${subscription.id.slice(4)}.json`), "utf8"), beforeList);
  assert.equal(network.requests, beforeNetwork);
  assert.equal(saved(dir, subscription.id).state, "active");
  assert.equal(Date.parse(subscription.refreshBefore) - clock, 300000); // null is finite, never persistent.
  assert.deepEqual(Object.keys(subscription).sort(), ["cursor", "id", "refreshBefore", "truncated"]);
  assert.equal(network.packets.length, 1); // Challenge is not application delivery.
  const usage = managedStoreStatus(dir), filename = `events-subscription-${subscription.id.slice(4)}.json`;
  assert.equal(usage.physicalBytes, fs.statSync(join(dir, filename)).size); assert.equal(usage.reservedBytes, 0);
  const orphan = `${filename}.123.${randomUUID()}.tmp`; fs.writeFileSync(join(dir, orphan), "orphan");
  assert.equal(managedStoreStatus(dir).physicalBytes, usage.physicalBytes + 6); fs.unlinkSync(join(dir, orphan));
  await events.notifyAccepted(requestId);
  const apps = network.packets.filter(packet => packet.value.name);
  assert.equal(apps.length, 2); assert.equal(apps[0].value.eventId, apps[1].value.eventId);
  assert.equal(apps[0].body, apps[1].body);
  assert.notEqual(apps[0].headers["webhook-timestamp"], apps[1].headers["webhook-timestamp"]);
  for (const packet of apps) {
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${packet.headers['webhook-id']}.${packet.headers['webhook-timestamp']}.${packet.body}`).digest('base64');
    assert.equal(packet.headers['webhook-signature'], `v1,${signature}`);
    assert.deepEqual(Object.keys(packet.value.data).sort(), ["deliveryId", "evidence", "requestId", "state", "threadId"]);
  }
  assert.equal(saved(dir, subscription.id).delivery.state, "received");
  await events.notifyAccepted(requestId); await runtime(dir, io().transport).resume(); assert.equal(network.packets.length, 3);

  const failedDir = store("failed"), failedIO = io({ challenge: false });
  await assert.rejects(runtime(failedDir, failedIO.transport).subscribe(params), error => error.code === -32015);
  assert.equal(JSON.parse(fs.readFileSync(join(failedDir, fs.readdirSync(failedDir).find(n => n.startsWith('events-subscription-'))))).state, "pending");
  const tiny = store("tiny", 1), noNetwork = io();
  await assert.rejects(runtime(tiny, noNetwork.transport).subscribe(params), error => error.code === 'store_budget_exceeded');
  assert.equal(noNetwork.packets.length, 0); assert(!fs.readdirSync(tiny).some(n => n.startsWith('events-subscription-')));
  await assert.rejects(events.subscribe({ ...params, arguments: { requestId, threadId: randomUUID() } }), /events_not_authorized/);

  const restartDir = store("restart"), firstIO = io(), first = runtime(restartDir, firstIO.transport);
  const existing = await first.subscribe({ ...params, ttlMs: 10000 }), originalExpiry = existing.refreshBefore;
  const secondIO = io(), second = runtime(restartDir, secondIO.transport); clock += 1000;
  await second.resume(); assert.equal(secondIO.packets[0].value.type, 'verification'); assert.equal(secondIO.packets[1].value.name, params.name);
  assert.equal(saved(restartDir, existing.id).refreshBefore, originalExpiry);
  const revokedDir = store("revoked"), revIO = io(), rev = runtime(revokedDir, revIO.transport); await rev.subscribe(params);
  active = false; const afterRestart = io(); await runtime(revokedDir, afterRestart.transport).resume(); assert.equal(afterRestart.packets.length, 0);
  assert.deepEqual((await rev.list()).events, []); active = true;
  active = false;
  assert.deepEqual((await rev.list({ cursor: "", _meta: { ...metadata, principalId: connection.principalId, readSessionId: sessionId } })).events, []);
  active = true;
  clock += 10001; const expired = io(); await runtime(restartDir, expired.transport).resume(); assert.equal(expired.packets.length, 0);
  const extraRoot = join(root, 'extra-workspace'); fs.mkdirSync(extraRoot);
  fs.writeFileSync(policyPath, JSON.stringify({ ...policy, workspaceRoots: [root, extraRoot] }));
  await assert.rejects(events.discover(), /events_not_authorized/); fs.writeFileSync(policyPath, JSON.stringify(policy));

  // Actual Core policy changes during the post-DNS supervisor await must deny the HTTPS constructor.
  const controlConfig = join(root, 'control-config.json'), controlState = join(root, 'control-state'), dummyProfile = join(root, 'dummy-profile.json');
  fs.mkdirSync(controlState); fs.writeFileSync(dummyProfile, '{}');
  fs.writeFileSync(join(controlState, 'status.json'), JSON.stringify({ sessionId, supervisorPid: process.pid, controlUrl: policy.ownerUrl }));
  fs.writeFileSync(controlConfig, JSON.stringify({ schemaVersion: 1, client: process.execPath, profile: dummyProfile, launcher: budgetCli,
    readPolicy: policyPath, stateDir: controlState, healthUrlFile: join(root, 'unused-health.url') }));
  for (const action of ['expire-ttl', 'revoke', 'remove-target', 'change-roots']) {
    const grantDir = store(`supervisor-await-${action}`); let lookups = 0, changed = false, expiry;
    const grantIO = io({ lookup: async () => {
      if (++lookups === 2) beforeSessionResponse = async () => {
        if (action === 'expire-ttl') clock = Date.parse(expiry);
        else if (action === 'revoke') await chatTunnelCommand('revoke', controlConfig);
        else await chatTunnelCommand('grant', controlConfig, { threadIds: action === 'remove-target' ? [randomUUID()] : [threadId],
          workspaceRoots: action === 'change-roots' ? [extraRoot] : policy.workspaceRoots });
        changed = true;
      };
      return [{ address: '8.8.8.8', family: 4 }];
    } });
    const grantRuntime = runtime(grantDir, grantIO.transport), sub = await grantRuntime.subscribe(params), baseline = grantIO.requests;
    expiry = sub.refreshBefore;
    const generation = saved(grantDir, sub.id).generation;
    await grantRuntime.notifyAccepted(requestId);
    assert(changed, `${action} must occur during the post-DNS supervisor await`);
    assert.equal(grantIO.requests - baseline, 0, `${action} during supervisor await must prevent the HTTPS constructor`);
    assert.equal(grantIO.packets.filter(packet => packet.value.name).length, 0);
    assert.equal(saved(grantDir, sub.id).generation, generation); // Subscription unchanged does not imply unchanged permission.
    fs.writeFileSync(policyPath, JSON.stringify(policy));
  }

  // Unsubscribe/revocation/rotation during DNS must prevent the old POST from starting.
  for (const action of ['unsubscribe', 'revoke', 'rotate']) {
    const raceDir = store(`race-${action}`), reached = signal(), release = signal(); let lookups = 0;
    const raceIO = io({ lookup: async () => { if (++lookups === 2) { reached.resolve(); await release.promise; } return [{ address: '8.8.8.8', family: 4 }]; } });
    const race = runtime(raceDir, raceIO.transport), sub = await race.subscribe(params), work = race.notifyAccepted(requestId);
    await reached.promise;
    if (action === 'unsubscribe') await race.unsubscribe(unsub);
    if (action === 'revoke') active = false;
    if (action === 'rotate') { const next = await race.subscribe({ ...params, delivery: { ...params.delivery, secret: rotated } }); assert.equal(next.id, sub.id); }
    release.resolve(); await work.catch(() => {}); assert.equal(raceIO.packets.filter(p => p.value.name).length, 0); active = true;
    if (action === 'unsubscribe') { assert.equal(saved(raceDir, sub.id).state, 'inactive'); await race.resume(); assert.equal(raceIO.packets.length, 1); }
    if (action === 'rotate') {
      await race.notifyAccepted(requestId);
      const rotatedPost = raceIO.packets.find(p => p.value.name);
      const material = `${rotatedPost.headers['webhook-id']}.${rotatedPost.headers['webhook-timestamp']}.${rotatedPost.body}`;
      for (const key of [secret, rotated]) assert(rotatedPost.headers['webhook-signature'].includes(`v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(material).digest('base64')}`));
    }
  }
  const pendingDir = store('pending-unsubscribe'), pendingReached = signal(), pendingRelease = signal();
  const pendingIO = io({ lookup: async () => { pendingReached.resolve(); await pendingRelease.promise; return [{ address: '8.8.8.8', family: 4 }]; } });
  const pendingRuntime = runtime(pendingDir, pendingIO.transport), preparing = pendingRuntime.subscribe(params);
  await pendingReached.promise; await pendingRuntime.unsubscribe(unsub); pendingRelease.resolve();
  await assert.rejects(preparing, error => error.code === -32015); assert.equal(pendingIO.packets.length, 0);
  const pendingFile = fs.readdirSync(pendingDir).find(name => /^events-subscription-.*\.json$/.test(name));
  assert.equal(JSON.parse(fs.readFileSync(join(pendingDir, pendingFile))).state, 'inactive');
  const uncertainDir = store('uncertain'), uncertainIO = io(), uncertain = runtime(uncertainDir, uncertainIO.transport);
  await uncertain.subscribe(params); receiptState = 'uncertain'; await uncertain.notifyAccepted(requestId); assert.equal(uncertainIO.packets.length, 1); receiptState = 'accepted';
  const exhaustedDir = store('exhausted'), retries = io({ statuses: [503, 503, 503, 204] }), exhausted = runtime(exhaustedDir, retries.transport);
  const retrySub = await exhausted.subscribe(params); await exhausted.notifyAccepted(requestId); await exhausted.resume();
  assert.equal(retries.packets.filter(p => p.value.name).length, 3); assert.equal(saved(exhaustedDir, retrySub.id).delivery.state, 'exhausted');

  // Real stdio handler + real durable accepted record + actual transport with only DNS/HTTPS I/O replaced.
  const stdioDir = store('stdio'), preload = join(root, 'offline-io.mjs'), received = join(root, 'callback.jsonl');
  fs.writeFileSync(join(stdioDir, `message-${requestId}.json`), JSON.stringify({ schemaVersion: 1, selectionToken: requestId, threadId, cwd: root,
    messageSha256: 'a'.repeat(64), state: 'accepted', createdAt: new Date(clock).toISOString(), acceptedAt: new Date(clock).toISOString() }));
  fs.writeFileSync(preload, `import dns from 'node:dns/promises';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';import fs from 'node:fs';
dns.lookup=async()=>[{address:'8.8.8.8',family:4}];https.request=(o,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=b=>{const p=JSON.parse(b);fs.appendFileSync(${JSON.stringify(received)},JSON.stringify(p)+'\\n');queueMicrotask(()=>{const r=new EventEmitter();r.complete=true;r.statusCode=200;r.destroy=()=>{};cb(r);r.emit('data',JSON.stringify(p.type==='verification'?{challenge:p.challenge}:{}));r.emit('end');});};return req;};syncBuiltinESMExports();`);
  const stdio = childServer(stdioDir, true, preload), stdioStarted = Date.now();
  const subscribed = await stdio.request('events/subscribe', { ...params, _meta: { ...metadata, ttlMs: 1 } });
  assert(subscribed.result.id);
  const stdioRecord = saved(stdioDir, subscribed.result.id);
  assert.equal(stdioRecord._meta, undefined);
  assert.equal(stdioRecord.principalId, connection.principalId);
  assert(Date.parse(subscribed.result.refreshBefore) >= stdioStarted + 300000, 'transport metadata cannot shorten the private TTL grant');
  for (let tries = 0; tries < 40 && (!fs.existsSync(received) || fs.readFileSync(received, 'utf8').trim().split('\n').length < 2); tries++) await new Promise(done => setTimeout(done, 50));
  const posts = fs.readFileSync(received, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(posts.length, 2); assert.equal(posts[1].data.evidence, 'persisted_native_host_ack');
  const status = JSON.parse((await stdio.request('tools/call', { name: 'codex_message_status', arguments: { requestId } })).result.content[0].text);
  assert.equal(status.consumer.state, 'unknown'); assert.equal(status.businessAcceptance.state, 'unknown');
  await stdio.request('events/unsubscribe', { ...unsub, _meta: metadata }); await stdio.request('events/unsubscribe', { ...unsub, _meta: metadata });
  for (const value of ['transport-only-value', 'forged-principal', 'forged-workspace']) assert(!stdio.logs().includes(value));
  assert(!stdio.logs().includes(secret)); assert(!stdio.logs().includes('verification_')); assert(!stdio.logs().includes('callback.example'));
  stdio.close(); console.log('mcp events runtime tests passed');
} finally {
  for (const child of children) child.kill();
  await new Promise(done => owner.close(done));
  fs.rmSync(root, { recursive: true, force: true });
}
