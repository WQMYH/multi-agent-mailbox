import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

let moduleUrl = new URL("./mcp-events-transport.mjs", import.meta.url);
if (process.env.MCP_EVENTS_TRANSPORT_TEST_MUTATION === "allow_private") {
  const source = readFileSync(moduleUrl, "utf8");
  const broken = source.replace('return (family === 4 || globalV6.check(address, type)) && !denied.check(address, type);', 'return true;');
  assert.notEqual(broken, source, "negative control must mutate the disposable module");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(broken).toString("base64")}`;
}
const { createMcpEventsTransport } = await import(moduleUrl);
const packet = { url: "https://receiver.example:8443/callback?q=1", method: "POST", redirect: "error", body: '{"text":"原字节 ✅"}',
  headers: { "Content-Type": "application/json", "webhook-id": "event-id", "webhook-timestamp": "1791590400",
    "webhook-signature": "v1,test-signature", "X-MCP-Subscription-Id": "subscription-id" } };
const code = expected => failure => failure.code === expected;
const publicAnswers = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }];

function fixture({ answers = publicAnswers, resolver, status = 200, chunks = [Buffer.from('{"challenge":"test"}')], complete = true, hold = false } = {}) {
  const state = { lookups: 0, requests: [], responses: [] };
  const send = createMcpEventsTransport({
    lookup: async (hostname, options) => {
      assert.equal(hostname, "receiver.example");
      assert.deepEqual(options, { all: true, verbatim: true });
      state.lookups++;
      return resolver ? resolver() : answers;
    },
    request: (options, onResponse) => {
      const req = new EventEmitter();
      const created = { options, req };
      state.requests.push(created);
      req.destroy = () => { req.destroyed = true; };
      req.end = bytes => {
        created.bytes = bytes;
        queueMicrotask(() => {
          if (req.destroyed) return;
          const res = new EventEmitter();
          Object.assign(res, { statusCode: status, complete, destroy() { this.destroyed = true; } });
          state.responses.push(res);
          onResponse(res);
          if (hold || res.destroyed) return;
          for (const chunk of chunks) res.emit("data", chunk);
          res.emit("end");
          res.emit("close");
        });
      };
      return req;
    }
  });
  return { send, state };
}

const success = fixture();
const reply = await success.send(packet);
assert.deepEqual(reply, { status: 200, ok: true, body: '{"challenge":"test"}' });
const { options, bytes } = success.state.requests[0];
assert.equal(bytes.toString("utf8"), packet.body, "signed body bytes must not be parsed or reserialized");
assert.equal(options.hostname, publicAnswers[0].address);
assert.equal(options.family, 4);
assert.equal(options.servername, "receiver.example");
assert.equal(options.headers.Host, "receiver.example:8443");
assert.equal(options.headers["Content-Length"], String(Buffer.byteLength(packet.body)));
assert.equal(options.headers["webhook-signature"], packet.headers["webhook-signature"]);
assert.equal(options.path, "/callback?q=1");
assert.equal(options.agent, false);
assert.equal(options.autoSelectFamily, false);
assert.deepEqual(options.proxyEnv, {});
assert.equal(options.rejectUnauthorized, true);
assert.equal(options.maxHeaderSize, 16384);
assert.equal(options.checkServerIdentity("ignored-pin", { subjectaltname: "DNS:receiver.example" }), undefined);
assert(options.checkServerIdentity("receiver.example", { subjectaltname: "DNS:8.8.8.8" }) instanceof Error);
await success.send(packet);
assert.equal(success.state.lookups, 2, "each fresh request must resolve again");

const v6 = fixture({ answers: [{ address: "2606:4700::1111", family: 6 }] });
await v6.send(packet);
assert.equal(v6.state.requests[0].options.hostname, "2606:4700::1111");
const direct = fixture();
await direct.send({ ...packet, url: "https://8.8.8.8/callback" });
assert.equal(direct.state.lookups, 0);
assert.equal(direct.state.requests[0].options.servername, "");
assert.equal(direct.state.requests[0].options.checkServerIdentity("ignored", { subjectaltname: "IP Address:8.8.8.8" }), undefined);

for (const address of ["0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.8",
  "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"]) {
  const blocked = fixture({ answers: [{ address, family: 4 }] });
  await assert.rejects(blocked.send(packet), code("webhook_address_blocked"));
  assert.equal(blocked.state.requests.length, 0, `no connection may reach ${address}`);
}
for (const address of ["::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::7f00:1", "100::1", "2001::1", "2001:2::1",
  "2001:db8::1", "2002:7f00:1::", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "fe80::1%eth0", "ff02::1"]) {
  const blocked = fixture({ answers: [{ address, family: 6 }] });
  await assert.rejects(blocked.send(packet), code("webhook_address_blocked"));
  assert.equal(blocked.state.requests.length, 0);
}
for (const answers of [[], [null], [{ address: "8.8.8.8", family: 6 }], [...publicAnswers, { address: "127.0.0.1", family: 4 }]]) {
  const blocked = fixture({ answers });
  await assert.rejects(blocked.send(packet), code("webhook_address_blocked"));
  assert.equal(blocked.state.requests.length, 0, "a public first answer must not conceal a private later answer");
}
let dnsCalls = 0;
const rebind = fixture({ resolver: () => ++dnsCalls === 1 ? publicAnswers : [{ address: "127.0.0.1", family: 4 }] });
await rebind.send(packet);
await assert.rejects(rebind.send(packet), code("webhook_address_blocked"));
assert.equal(rebind.state.requests.length, 1, "second request must not reuse the previous public result");

for (const url of ["http://receiver.example/", "https://user:pass@receiver.example/", "https://receiver.example/#fragment", "https://127.1/", "https://[::ffff:8.8.8.8]/"]) {
  const bad = fixture();
  await assert.rejects(bad.send({ ...packet, url }), failure => ["webhook_packet_invalid", "webhook_address_blocked"].includes(failure.code));
  assert.equal(bad.state.requests.length, 0);
}
const oversize = fixture();
await assert.rejects(oversize.send({ ...packet, body: "x".repeat(262145) }), code("webhook_request_too_large"));
assert.equal(oversize.state.requests.length, 0);
await assert.rejects(oversize.send({ ...packet, headers: { ...packet.headers, Host: "127.0.0.1" } }), code("webhook_packet_invalid"));
await assert.rejects(oversize.send({ ...packet, headers: { ...packet.headers, "webhook-id": "x\r\nHost: 127.0.0.1" } }), code("webhook_packet_invalid"));
const redirected = fixture({ status: 302 });
await assert.rejects(redirected.send(packet), code("webhook_redirect_blocked"));
assert.equal(redirected.state.requests.length, 1, "redirect must not create a second request");
assert(redirected.state.responses[0].destroyed);
const oversizedResponse = fixture({ chunks: [Buffer.alloc(16384), Buffer.alloc(1)] });
await assert.rejects(oversizedResponse.send(packet), code("webhook_response_too_large"));
assert(oversizedResponse.state.requests[0].req.destroyed && oversizedResponse.state.responses[0].destroyed);
await assert.rejects(fixture({ complete: false }).send(packet), code("webhook_response_failed"));
for (const status of [410, 413, 503]) {
  const failure = fixture({ status });
  assert.equal((await failure.send(packet)).status, status, "caller must retain status for no-retry/backoff policy");
  assert.equal(failure.state.requests.length, 1, "transport itself never retries");
}

let resolvePendingDns, active = true, guardCalls = 0;
const revoked = fixture({ resolver: () => new Promise(resolve => { resolvePendingDns = resolve; }) });
const pending = revoked.send(packet, { assertActive: async () => { guardCalls++; return active; } });
active = false;
resolvePendingDns(publicAnswers);
await assert.rejects(pending, code("webhook_grant_inactive"));
assert.equal(guardCalls, 1, "recheck the grant after DNS completes");
assert.equal(revoked.state.requests.length, 0, "revocation while DNS is pending must block connection creation");
for (const assertActive of [() => false, () => "true", null, () => { throw Error("private grant secret"); }]) {
  const blocked = fixture();
  await assert.rejects(blocked.send(packet, { assertActive }), failure => failure.code === "webhook_grant_inactive" && failure.message === "webhook_grant_inactive");
  assert.equal(blocked.state.requests.length, 0, "invalid or throwing guard cannot create a request");
}
const granted = fixture();
assert.equal((await granted.send(packet, { assertActive: async () => true })).status, 200);
const literalRevoked = fixture();
await assert.rejects(literalRevoked.send({ ...packet, url: "https://8.8.8.8/callback" }, { assertActive: () => false }), code("webhook_grant_inactive"));
assert.equal(literalRevoked.state.requests.length, 0);

const expiredGuard = fixture(), originalNow = performance.now;
let clockOffset = 0;
try {
  performance.now = () => originalNow.call(performance) + clockOffset;
  await assert.rejects(expiredGuard.send(packet, { assertActive: () => { clockOffset = 10001; return true; } }), code("webhook_timeout"));
  assert.equal(expiredGuard.state.requests.length, 0, "expired monotonic deadline blocks request even before the timer callback runs");
} finally { performance.now = originalNow; }

let resolveLate;
const slowDns = fixture({ resolver: () => new Promise(resolve => { resolveLate = resolve; }) });
const slowResponse = fixture({ hold: true });
let resolveLateGuard;
const slowGuard = fixture();
await Promise.all([
  assert.rejects(slowDns.send(packet), code("webhook_timeout")),
  assert.rejects(slowResponse.send(packet), code("webhook_timeout")),
  assert.rejects(slowGuard.send(packet, { assertActive: () => new Promise(resolve => { resolveLateGuard = resolve; }) }), code("webhook_timeout"))
]);
resolveLate(publicAnswers);
resolveLateGuard(true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(slowDns.state.requests.length, 0, "late DNS completion cannot send after deadline");
assert.equal(slowGuard.state.requests.length, 0, "late grant approval cannot send after deadline");
assert(slowResponse.state.requests[0].req.destroyed && slowResponse.state.responses[0].destroyed);
console.log("mcp-events transport SOURCE_OFFLINE checks passed; all DNS and HTTPS I/O used fixtures, no network calls");
