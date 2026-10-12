import { lookup as nativeLookup } from "node:dns/promises";
import { request as nativeRequest } from "node:https";
import { validateHeaderValue } from "node:http";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

const MAX_BODY_BYTES = 262144, MAX_RESPONSE_BYTES = 16384, MAX_HEADER_BYTES = 16384;
const error = code => Object.assign(Error(code), { code });
const denied = new BlockList(), globalV6 = new BlockList();
// Conservative IANA special-purpose policy; public exceptions inside these blocks are also rejected.
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) denied.addSubnet(address, prefix, "ipv4");
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]])
  denied.addSubnet(address, prefix, "ipv6");

function publicAddress(address, family) {
  if (typeof address !== "string" || address.includes("%") || ![4, 6].includes(family) || isIP(address) !== family) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  return (family === 4 || globalV6.check(address, type)) && !denied.check(address, type);
}

function snapshot(packet) {
  if (!packet || typeof packet !== "object" || packet.method !== "POST" || packet.redirect !== "error"
    || typeof packet.body !== "string" || typeof packet.url !== "string" || packet.url.length > 4096) throw error("webhook_packet_invalid");
  let url;
  try { url = new URL(packet.url); } catch { throw error("webhook_packet_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw error("webhook_packet_invalid");
  const names = ["Content-Type", "webhook-id", "webhook-timestamp", "webhook-signature", "X-MCP-Subscription-Id"];
  if (!packet.headers || typeof packet.headers !== "object" || Object.keys(packet.headers).length !== names.length
    || Object.keys(packet.headers).some(name => !names.includes(name))) throw error("webhook_packet_invalid");
  const headers = {};
  let headerBytes = 0;
  for (const name of names) {
    const value = packet.headers[name];
    if (typeof value !== "string" || !value) throw error("webhook_packet_invalid");
    try { validateHeaderValue(name, value); } catch { throw error("webhook_packet_invalid"); }
    headerBytes += Buffer.byteLength(name + value, "utf8") + 4;
    headers[name] = value;
  }
  if (headerBytes > MAX_HEADER_BYTES - 4096 || headers["Content-Type"] !== "application/json") throw error("webhook_packet_invalid");
  const body = Buffer.from(packet.body, "utf8");
  if (body.length > MAX_BODY_BYTES) throw error("webhook_request_too_large");
  return { url, headers, body };
}

// The only injected seam is trusted DNS/HTTPS I/O; never obtain these functions from an MCP caller.
export function createMcpEventsTransport({ lookup = nativeLookup, request = nativeRequest } = {}) {
  if (typeof lookup !== "function" || typeof request !== "function") throw error("webhook_io_invalid");
  return async (packet, { assertActive = () => true } = {}) => {
    const { url, headers, body } = snapshot(packet);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + 10_000;
      let settled = false, req, response;
      const finish = (failure, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) { response?.destroy(); req?.destroy(); reject(failure); }
        else resolve(result);
      };
      const timer = setTimeout(() => finish(error("webhook_timeout")), 10_000);
      (async () => {
        let answers;
        try { answers = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true }); }
        catch { throw error("webhook_dns_failed"); }
        if (settled) return;
        if (!Array.isArray(answers) || !answers.length || answers.some(answer => !publicAddress(answer?.address, answer?.family)))
          throw error("webhook_address_blocked");
        // Runtime binds a fresh grant/rotation check here; the one-argument helper has no authorization claim.
        try { if (typeof assertActive !== "function" || await assertActive() !== true) throw Error(); }
        catch { throw error("webhook_grant_inactive"); }
        if (settled) return;
        if (performance.now() >= deadline) throw error("webhook_timeout");
        // Connect directly to the checked literal IP. No second DNS lookup, proxy, reuse, or address fallback.
        const address = answers[0].address, family = answers[0].family;
        req = request({ protocol: "https:", hostname: address, family, port: url.port || 443, path: url.pathname + url.search,
          method: "POST", headers: { ...headers, Host: url.host, "Content-Length": String(body.length) },
          agent: false, autoSelectFamily: false, proxyEnv: {}, rejectUnauthorized: true,
          servername: literalFamily ? "" : hostname,
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert), maxHeaderSize: MAX_HEADER_BYTES
        }, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          res.on("error", () => finish(error("webhook_response_failed")));
          res.on("aborted", () => finish(error("webhook_response_failed")));
          if (!Number.isInteger(res.statusCode) || res.statusCode < 100 || res.statusCode > 599) return finish(error("webhook_response_failed"));
          if (res.statusCode >= 300 && res.statusCode < 400) return finish(error("webhook_redirect_blocked"));
          const chunks = [];
          let size = 0, ended = false;
          res.on("data", chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_RESPONSE_BYTES) finish(error("webhook_response_too_large"));
            else chunks.push(bytes);
          });
          res.on("end", () => {
            ended = true;
            if (res.complete !== true) return finish(error("webhook_response_failed"));
            finish(null, { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
              body: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("close", () => { if (!ended) finish(error("webhook_response_failed")); });
        });
        req.on("error", () => finish(error("webhook_connection_failed")));
        req.end(body);
      })().catch(failure => finish(failure?.code?.startsWith("webhook_") ? failure : error("webhook_connection_failed")));
    });
  };
}
