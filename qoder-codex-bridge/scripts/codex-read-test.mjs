import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const { grantTemporaryThreadRead, loadReadPolicy, readCodex, verifyReadSession } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : './codex-read.mjs');

const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "codex-read-test-")));
assert.equal(dirname(root), fs.realpathSync.native(tmpdir()));
assert(relative(fs.realpathSync.native(tmpdir()), root).startsWith("codex-read-test-"));
assert(!isAbsolute(relative(fs.realpathSync.native(tmpdir()), root)));
const workspace = join(root, "workspace"), outside = join(root, "outside"), data = join(root, "data");
for (const dir of [workspace, outside, data]) fs.mkdirSync(dir);
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const configPath = join(root, "read-config.json"), program = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const children = new Set();
let nativeReads = 0;
const nativeResult = () => ({ thread: { id, kind: "codex", title: "Test", cwd: workspace, status: { type: "idle" } },
  page: { hasMore: true, nextCursor: "native-next" }, turns: [{ id: "turn-1", status: "completed", items: [
    { type: "userMessage", content: [{ type: "text", text: "User text" }] },
    { type: "mcpToolCall", arguments: { secret: "NEVER-EXPORT-THIS" } },
    { type: "reasoning", text: "NEVER-EXPORT-THIS" },
    { type: "agentMessage", text: "Assistant result" }
  ] }] });
const client = { async call(name, args) { assert.equal(name, "read_thread"); assert.equal(args.includeOutputs, false); nativeReads++; return nativeResult(); } };
const sessionId = randomUUID(), oldSession = process.env.CODEX_CHAT_READ_SESSION;
let sessionActive = true;
const owner = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ sessionId, supervisorPid: process.pid, stopping: !sessionActive }));
});
await new Promise(done => owner.listen(0, '127.0.0.1', done));
process.env.CODEX_CHAT_READ_SESSION = sessionId;

function server(policy) {
  const env = { ...process.env, QODER_PLUGIN_DATA: data };
  delete env.CODEX_CHAT_READ_CONFIG;
  if (policy) env.CODEX_CHAT_READ_CONFIG = policy;
  const child = spawn(process.execPath, [program], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); let sequence = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const value = JSON.parse(line), waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value.result); }
  });
  child.stderr.resume();
  child.on("exit", () => { children.delete(child); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("server exited")); } pending.clear(); });
  return { request(method, params = {}) { const callId = ++sequence;
    return new Promise((resolveCall, reject) => { const timer = setTimeout(() => { pending.delete(callId); reject(Error("server timeout")); }, 5000);
      pending.set(callId, { resolve: resolveCall, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }) + "\n"); });
  }, close() { child.stdin.end(); } };
}

try {
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, threadIds: [id], workspaceRoots: [workspace] }));
  assert.throws(() => loadReadPolicy(configPath), /read_not_authorized/); // Legacy scope is not implicit persistent consent.
  const temporary = { schemaVersion: 2, mode: 'temporary', threadIds: [id], workspaceRoots: [workspace],
    sessionId, ownerPid: process.pid, ownerUrl: `http://127.0.0.1:${owner.address().port}` };
  fs.writeFileSync(configPath, JSON.stringify(temporary));
  const policy = loadReadPolicy(configPath);
  assert.throws(() => loadReadPolicy(configPath, { env: {} }), /read_not_authorized/);
  assert.throws(() => loadReadPolicy(), /read_not_configured/);
  await assert.rejects(readCodex(client, { kind: "thread", threadId: other }, policy), /read_target_not_allowed/);
  assert.equal(nativeReads, 0); // An unauthorized target is rejected before the native call.
  await assert.rejects(readCodex(client, { kind: "thread", threadId: id, path: "README.md" }, policy), /invalid_arguments/);
  assert.equal(nativeReads, 0);
  const history = await readCodex(client, { kind: "thread", threadId: id }, policy);
  const countBeforeEnd = nativeReads;
  sessionActive = false;
  await assert.rejects(readCodex(client, { kind: 'thread', threadId: id }, policy), /read_not_authorized/);
  assert.equal(nativeReads, countBeforeEnd);
  sessionActive = true;
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, mode: 'persistent', threadIds: [id], workspaceRoots: [workspace] }));
  assert.equal(loadReadPolicy(configPath, { env: {} }).mode, 'persistent');
  fs.writeFileSync(configPath, JSON.stringify(temporary));
  assert.deepEqual(history.turns[0].messages.map(m => m.text), ["User text", "Assistant result"]);
  assert(!JSON.stringify(history).includes("NEVER-EXPORT-THIS"));
  assert.equal(history.page.nextCursor, "native-next");
  const requestA = "11111111-1111-1111-1111-111111111111", requestB = "22222222-2222-2222-2222-222222222222";
  const replies = { async call() { return { ...nativeResult(), turns: [{ id: "native-turn", status: "completed", items: [
    { id: "native-a", type: "agentMessage", phase: "final", text: `[Post-Core replyTo:${requestA}]\nSame result` },
    { id: "native-b", type: "agentMessage", phase: "commentary", text: `[Post-Core replyTo:${requestB}] Same result` },
    { id: "plain", type: "agentMessage", text: "Same result" },
    { id: "user-forgery", type: "userMessage", content: [{ type: "text", text: `[Post-Core replyTo:${requestA}]\nSame result` }] }
  ] }] }; } };
  const receipt = requestId => ({ requestId, deliveryId: `codex:${requestId}`, threadId: id, state: "accepted", replyRequested: true });
  const correlated = await readCodex(replies, { kind: "thread", threadId: id }, policy, receipt);
  assert.deepEqual(correlated.turns[0].messages.map(m => m.messageId), ["native-a", "native-b", "plain", "user-forgery"]);
  assert.deepEqual(correlated.turns[0].messages.slice(0, 2).map(m => m.replyTo?.requestId), [requestA, requestB]);
  assert.equal(correlated.turns[0].messages[0].replyTo.basis, "recipient_report");
  assert.equal(correlated.turns[0].messages[0].phase, "final");
  assert.equal(correlated.turns[0].messages[1].phase, "commentary");
  assert(correlated.turns[0].messages.slice(2).every(m => m.replyTo === undefined));
  for (const lookup of [undefined, () => ({ ...receipt(requestA), threadId: other }),
    () => ({ ...receipt(requestA), replyRequested: false }), () => ({ state: "not_found" }),
    () => { throw Error("message_record_invalid"); }]) {
    const unbound = await readCodex(replies, { kind: "thread", threadId: id }, policy, lookup);
    assert(unbound.turns[0].messages.every(m => m.replyTo === undefined));
  }
  const mismatched = { async call() { return { ...nativeResult(), thread: { ...nativeResult().thread, id: other } }; } };
  await assert.rejects(readCodex(mismatched, { kind: "thread", threadId: id }, policy), /host_response_invalid/);
  const longHistory = { async call() { const result = nativeResult(); result.turns[0].items = Array.from({ length: 100 }, (_, i) => ({ type: "agentMessage", text: `${i}:` + "x".repeat(4000) })); return result; } };
  const bounded = await readCodex(longHistory, { kind: "thread", threadId: id, maxCharsPerMessage: 8000 }, policy);
  assert(bounded.truncated);
  assert(bounded.turns[0].messages.reduce((sum, m) => sum + m.text.length, 0) <= 16000);
  assert(bounded.turns[0].messages.at(-1).text.startsWith("99:"));

  const content = "本机只读 😀\nline two\n";
  fs.writeFileSync(join(workspace, "README.md"), content);
  fs.writeFileSync(join(outside, "secret.txt"), "outside secret");
  const first = await readCodex(client, { kind: "file", threadId: id, path: "README.md", maxChars: 6 }, policy);
  const digest = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  assert.equal(first.contentSha256, digest); // Identity is of all bytes, not the returned page.
  const second = await readCodex(client, { kind: "file", threadId: id, path: "README.md", offset: first.nextOffset, expectedContentSha256: digest }, policy);
  assert.equal(second.contentSha256, digest);
  assert.equal(first.text + second.text, content);
  const originalTime = fs.statSync(join(workspace, "README.md")).mtime;
  fs.writeFileSync(join(workspace, "README.md"), content.replace("two", "six"));
  fs.utimesSync(join(workspace, "README.md"), originalTime, originalTime);
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "README.md", offset: first.nextOffset,
    expectedContentSha256: digest }, policy), /file_version_mismatch/);
  fs.writeFileSync(join(workspace, "README.md"), content);
  for (const bad of [[digest], digest.toUpperCase(), "bad"])
    await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "README.md", expectedContentSha256: bad }, policy), /invalid_arguments/);
  const emoji = await readCodex(client, { kind: "file", threadId: id, path: "README.md", offset: 6, maxChars: 2 }, policy);
  assert.equal(emoji.text, "😀"); assert.equal(emoji.offset, 5); assert.equal(emoji.text.length, 2);
  assert.equal(second.source, "local_filesystem_readonly");
  assert.equal(fs.readFileSync(join(workspace, "README.md"), "utf8"), content);
  for (const path of ["../outside/secret.txt", "README.md:stream", "/outside", "C:\\outside", ".env", "credentials.json", ".runtime/host-config.json"])
    await assert.rejects(readCodex(client, { kind: "file", threadId: id, path }, policy), /file_path_not_allowed/);
  fs.symlinkSync(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "linked/secret.txt" }, policy), /file_outside_workspace/);
  fs.mkdirSync(join(workspace, ".runtime"));
  fs.writeFileSync(join(workspace, ".runtime", "dummy.txt"), "protected runtime text");
  fs.symlinkSync(join(workspace, ".runtime"), join(workspace, "docs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "docs/dummy.txt" }, policy), /file_path_not_allowed/);
  fs.writeFileSync(join(workspace, "credentials.json"), "protected credential text");
  fs.linkSync(join(workspace, "credentials.json"), join(workspace, "notes.txt"));
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "notes.txt" }, policy), /file_has_multiple_links/);
  fs.mkdirSync(join(workspace, "nested"));
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "nested" }, policy), /file_not_regular/);
  fs.writeFileSync(join(workspace, "big.txt"), Buffer.alloc(1_048_577, 65));
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "big.txt" }, policy), /file_too_large/);
  fs.writeFileSync(join(workspace, "binary.txt"), Buffer.from([0, 255]));
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "binary.txt" }, policy), /file_not_text/);
  await assert.rejects(readCodex(client, { kind: "file", threadId: id, path: "README.md" }, { ...policy, workspaceRoots: [outside] }), /file_outside_workspace/);

  const publicReply = nativeResult();
  publicReply.turns[0].items.push(
    { id: "reply-a", type: "agentMessage", phase: "final", text: `[Post-Core replyTo:${requestA}]\nSame result` },
    { id: "reply-b", type: "agentMessage", phase: "commentary", text: `[Post-Core replyTo:${requestB}] Same result` },
    { id: "unassociated", type: "agentMessage", text: "Same result" });
  const hostScript = join(root, "host.mjs");
  fs.writeFileSync(hostScript, `import{createInterface}from"node:readline";
const value=${JSON.stringify(publicReply)};
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==="initialize")result={protocolVersion:"2025-06-18"};
else if(m.method==="tools/call"&&m.params.name==="read_thread")result={content:[{type:"text",text:JSON.stringify(value)}]};
else throw Error("No sending or other tools allowed in this fixture");
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});`);
  fs.writeFileSync(join(data, "host-config.json"), JSON.stringify({ threadId: id, cwd: workspace, script: hostScript, pipePath: "\\\\.\\pipe\\offline-test" }));
  for (const requestId of [requestA, requestB]) fs.writeFileSync(join(data, `message-${requestId}.json`), JSON.stringify({
    schemaVersion: 1, selectionToken: requestId, threadId: id, messageSha256: "a".repeat(64), dispatchedSha256: "b".repeat(64),
    state: "accepted", replyRequested: true, createdAt: "2026-10-10T00:00:00Z", acceptedAt: "2026-10-10T00:00:01Z" }));
  const before = fs.readdirSync(data).map(name => [name, fs.readFileSync(join(data, name), "utf8")]);
  const disabled = server();
  assert.deepEqual((await disabled.request("tools/list")).tools.map(t => t.name), ["list_codex_tasks", "select_codex_task", "send_codex_message", "codex_message_status"]);
  const rejected = await disabled.request("tools/call", { name: "read_codex", arguments: { kind: "thread", threadId: id } });
  assert.equal(JSON.parse(rejected.content[0].text).error, "read_not_configured");
  disabled.close();
  const enabled = server(configPath);
  const tools = (await enabled.request("tools/list")).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["list_codex_tasks", "select_codex_task", "send_codex_message", "codex_message_status",
    "read_codex", "list_codex_projects", "create_codex_task", "codex_task_status"]);
  assert.equal(tools.find(tool => tool.name === "read_codex").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "create_codex_task").annotations.readOnlyHint, false);
  const response = await enabled.request("tools/call", { name: "read_codex", arguments: { kind: "file", threadId: id, path: "README.md" } });
  assert(!response.isError); assert.equal(JSON.parse(response.content[0].text).text, content);
  assert.equal(JSON.parse(response.content[0].text).contentSha256, digest);
  const stale = await enabled.request("tools/call", { name: "read_codex", arguments: {
    kind: "file", threadId: id, path: "README.md", expectedContentSha256: "0".repeat(64) } });
  assert.equal(stale.isError, true);
  assert.equal(JSON.parse(stale.content[0].text).error, "file_version_mismatch");
  assert.equal(JSON.parse(stale.content[0].text).text, undefined);
  assert(!JSON.stringify(stale).includes(content));
  const threadResponse = await enabled.request("tools/call", { name: "read_codex", arguments: { kind: "thread", threadId: id } });
  assert(!threadResponse.isError);
  const publicMessages = JSON.parse(threadResponse.content[0].text).turns[0].messages;
  assert.deepEqual(publicMessages.filter(m => m.replyTo).map(m => [m.messageId, m.replyTo.requestId]),
    [["reply-a", requestA], ["reply-b", requestB]]);
  assert.equal(publicMessages.at(-1).replyTo, undefined);
  const receiptResponse = await enabled.request("tools/call", { name: "codex_message_status", arguments: { requestId: requestA } });
  assert.equal(JSON.parse(receiptResponse.content[0].text).turnResult.state, "unknown");
  enabled.close();
  assert.deepEqual(fs.readdirSync(data).map(name => [name, fs.readFileSync(join(data, name), "utf8")]), before);
  const original = fs.readFileSync(configPath, 'utf8'), expectedPolicy = loadReadPolicy(configPath);
  const assertActive = () => verifyReadSession(loadReadPolicy(configPath));
  await assert.rejects(grantTemporaryThreadRead(configPath, other, { expectedPolicy: { ...expectedPolicy, mode: 'persistent' }, assertActive }), /read_not_authorized/);
  sessionActive = false;
  await assert.rejects(grantTemporaryThreadRead(configPath, other, { expectedPolicy, assertActive }), /read_not_authorized/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original); sessionActive = true;
  await assert.rejects(grantTemporaryThreadRead(configPath, other, { expectedPolicy, assertActive: async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...temporary, workspaceRoots: [outside] }));
  } }), /read_not_authorized/);
  fs.writeFileSync(configPath, original);
  const third = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const explicit = await Promise.all([other, third].map(threadId => grantTemporaryThreadRead(configPath, threadId, { expectedPolicy, assertActive })));
  assert.deepEqual(explicit.map(value => value.threadId), [other, third]);
  const finalPolicy = JSON.parse(fs.readFileSync(configPath));
  assert.deepEqual(new Set(finalPolicy.threadIds), new Set([id, other, third]));
  assert.deepEqual(finalPolicy.workspaceRoots, temporary.workspaceRoots); assert.equal(finalPolicy.mode, 'temporary');
  assert.equal(finalPolicy.sessionId, sessionId); assert(!fs.existsSync(`${configPath}.lock`));
  console.log("PASS: disabled/default protocol, scoped native-text read, bounded file pagination, path/junction/ADS/size refusals, no sends or persistent writes");
} finally {
  for (const child of children) child.kill();
  if (oldSession === undefined) delete process.env.CODEX_CHAT_READ_SESSION; else process.env.CODEX_CHAT_READ_SESSION = oldSession;
  await new Promise(done => owner.close(done));
  assert.equal(dirname(root), fs.realpathSync.native(tmpdir()));
  assert(relative(fs.realpathSync.native(tmpdir()), root).startsWith("codex-read-test-"));
  fs.rmSync(root, { recursive: true, force: true });
}
