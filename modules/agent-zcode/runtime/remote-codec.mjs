// ZCode's remote channel value stream: header value followed by body value.
// Protocol references and licenses are recorded in THIRD_PARTY_NOTICES.md.
import { crc32 } from "node:zlib";

export const MAX_MESSAGE = 16 * 1024 * 1024;
// Incoming fragments may fill a 1 MiB physical envelope after base64 encoding.
// Outgoing 512 KiB fragments are a conservative sender choice, not a receive limit.
const MAX_FRAGMENT_BASE64 = 1024 * 1024;
const MAX_FRAGMENT_BYTES = MAX_FRAGMENT_BASE64 / 4 * 3;
export const checksum = bytes => crc32(bytes).toString(16).padStart(8, "0");

export function encode(value) {
  const parts = [];
  const number = n => {
    do { const byte = n & 127; n = Math.floor(n / 128); parts.push(Buffer.from([byte | (n ? 128 : 0)])); } while (n);
  };
  function write(v) {
    if (v === undefined) return parts.push(Buffer.from([0]));
    if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) { parts.push(Buffer.from([6])); number(v); return; }
    if (Array.isArray(v)) { parts.push(Buffer.from([4])); number(v.length); v.forEach(write); return; }
    const bytes = Buffer.isBuffer(v) ? v : Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
    parts.push(Buffer.from([Buffer.isBuffer(v) ? 2 : typeof v === "string" ? 1 : 5]));
    number(bytes.length); parts.push(bytes);
  }
  write(value);
  return Buffer.concat(parts);
}

export function decode(bytes) {
  if (bytes.length > MAX_MESSAGE) throw Error("Remote value stream exceeds limit");
  let offset = 0, items = 0;
  function take(n) {
    if (n < 0 || offset + n > bytes.length) throw Error("Truncated remote value stream");
    const result = bytes.subarray(offset, offset + n); offset += n; return result;
  }
  function number() {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = take(1)[0]; n += (b & 127) * 2 ** (7 * i);
      if (n > 0xffffffff) break;
      if (!(b & 128)) return n;
    }
    throw Error("Invalid remote varint");
  }
  function read(depth = 0) {
    if (depth > 64 || ++items > 100000) throw Error("Remote value nesting/items exceed limit");
    const tag = take(1)[0];
    if (tag === 0) return undefined;
    if (tag === 6) return number();
    if (tag === 4) {
      const n = number(); if (n > 100000) throw Error("Remote array exceeds limit");
      return Array.from({ length: n }, () => read(depth + 1));
    }
    if (![1, 2, 3, 5].includes(tag)) throw Error("Unknown remote value type");
    const b = take(number());
    return tag === 1 ? b.toString() : tag === 5 ? JSON.parse(b.toString()) : b;
  }
  const values = [];
  while (offset < bytes.length) values.push(read());
  return values;
}

export function frames(bytes, bridge, messageSeq) {
  if (!bytes.length || bytes.length > MAX_MESSAGE) throw Error("Remote message exceeds limit");
  const size = 512 * 1024, count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, i) => ({
    zcode_type: "rpc-frame", bridgeSessionId: bridge.bridgeSessionId, bridgeGeneration: bridge.bridgeGeneration,
    messageSeq, fragmentIndex: i, fragmentCount: count, messageBytes: bytes.length,
    checksum: { algorithm: "crc32", value: checksum(bytes) }, dataBase64: bytes.subarray(i * size, (i + 1) * size).toString("base64")
  }));
}

export class FrameReader {
  pending = new Map();
  accept(p) {
    if (!Number.isSafeInteger(p.messageSeq) || p.messageSeq < 0 ||
        !Number.isInteger(p.fragmentCount) || p.fragmentCount < 1 || p.fragmentCount > 64 ||
        !Number.isInteger(p.fragmentIndex) || p.fragmentIndex < 0 || p.fragmentIndex >= p.fragmentCount ||
        !Number.isInteger(p.messageBytes) || p.messageBytes < 1 || p.messageBytes > MAX_MESSAGE ||
        p.checksum?.algorithm !== "crc32" || !/^[0-9a-f]{8}$/.test(p.checksum.value) ||
        typeof p.dataBase64 !== "string" || p.dataBase64.length > MAX_FRAGMENT_BASE64) throw Error("Invalid remote frame");
    let a = this.pending.get(p.messageSeq);
    if (!a) {
      // ponytail: one short-lived RPC connection; bound in-flight assemblies instead of a background reaper.
      if (this.pending.size >= 8) throw Error("Too many remote frame assemblies");
      a = { count: p.fragmentCount, size: p.messageBytes, crc: p.checksum.value, chunks: new Map(), bytes: 0 };
      this.pending.set(p.messageSeq, a);
    }
    if (a.count !== p.fragmentCount || a.size !== p.messageBytes || a.crc !== p.checksum.value) throw Error("Conflicting remote fragments");
    const chunk = Buffer.from(p.dataBase64, "base64");
    if (chunk.length > MAX_FRAGMENT_BYTES || chunk.toString("base64") !== p.dataBase64) throw Error("Invalid remote fragment encoding");
    if (a.chunks.has(p.fragmentIndex)) {
      if (!a.chunks.get(p.fragmentIndex).equals(chunk)) throw Error("Conflicting duplicate fragment");
    } else { a.chunks.set(p.fragmentIndex, chunk); a.bytes += chunk.length; }
    if (a.bytes > a.size) throw Error("Remote assembly exceeds declared size");
    if (a.chunks.size !== a.count) return null;
    this.pending.delete(p.messageSeq);
    const bytes = Buffer.concat(Array.from({ length: a.count }, (_, i) => a.chunks.get(i)));
    if (bytes.length !== a.size || checksum(bytes) !== a.crc) throw Error("Remote frame integrity check failed");
    return bytes;
  }
}
