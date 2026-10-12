import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { storeOwnerId, managedStoreStatus } from "./store-budget.mjs";

const root = fs.mkdtempSync(join(tmpdir(), "yuan-codex-create-"));
assert(resolve(root).startsWith(resolve(tmpdir())));
const issuer = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ready = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", preparing = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const children = new Set(), serverScript = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const budgetCli = join(root, "budget-cli.mjs");
fs.writeFileSync(budgetCli, `import {readFileSync} from 'node:fs'; const a=process.argv.slice(2); console.log(JSON.stringify(JSON.parse(readFileSync(a[a.indexOf('--registry')+1],'utf8'))));`);

function fixture(name, allocation = 5000000) {
  const dir = join(root, name); fs.mkdirSync(dir);
  const ownerId = storeOwnerId(dir), registryPath = join(dir, "registry.json"), hostScript = join(dir, "host.mjs"), policy = join(dir, "read-policy.json");
  fs.writeFileSync(registryPath, JSON.stringify({ messageBudget: { schemaVersion: 1, totalBytes: 20000000,
    allocations: [{ ownerId, bytes: allocation }, { ownerId: "other", bytes: 20000000 - allocation }] } }));
  fs.writeFileSync(join(dir, "store-config.json"), JSON.stringify({ schemaVersion: 1, ownerId, coreCli: budgetCli, registryPath }));
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 2, mode: "persistent", threadIds: [issuer], workspaceRoots: [] }));
  fs.writeFileSync(hostScript, `import fs from 'node:fs'; import {join} from 'node:path'; import {createInterface} from 'node:readline';
    const dir=process.env.QODER_PLUGIN_DATA;
    createInterface({input:process.stdin}).on('line',line=>{
      const msg=JSON.parse(line); if(msg.id==null)return; let result;
      if(msg.method==='initialize') result={protocolVersion:'2025-06-18'};
      else {
        if(msg.params._meta.codexThreadId!==${JSON.stringify(issuer)}) throw Error('wrong issuer');
        const {name,arguments:args}=msg.params; let payload;
        if(name==='read_thread') payload={thread:{id:${JSON.stringify(issuer)},cwd:dir}};
        else if(name==='list_projects') payload={projects:[{projectId:'local-project',projectKind:'local',hostId:'local',path:dir,label:'Local fixture',isGitRepository:false},
          {projectId:'work-project',projectKind:'chatgpt',hostId:'local',path:dir},{projectId:'remote-project',projectKind:'local',hostId:'remote',path:dir}]};
        else if(name==='create_thread') {
          fs.appendFileSync(join(dir,'calls.jsonl'),JSON.stringify(args)+'\\n');
          if(fs.existsSync(join(dir,'unknown'))) process.exit(1);
          if(fs.existsSync(join(dir,'bad-ack')))payload={threadId:${JSON.stringify(ready)},hostId:'remote'};
          else if(fs.existsSync(join(dir,'preparing')))payload={clientThreadId:${JSON.stringify(preparing)}};
          else payload={threadId:${JSON.stringify(ready)},hostId:'local',privateToken:'PRIVATE_NATIVE_SENTINEL'};
        } else throw Error('unexpected native call');
        result={content:[{type:'text',text:JSON.stringify(payload)}]};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
    });`);
  fs.writeFileSync(join(dir, "host-config.json"), JSON.stringify({ script: hostScript, pipePath: "\\\\.\\pipe\\isolated-create-fixture", threadId: issuer, cwd: dir }));
  return { dir, policy, registryPath, calls: () => fs.existsSync(join(dir, "calls.jsonl"))
    ? fs.readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [] };
}

function server(f, chat = true) {
  const env = { ...process.env, QODER_PLUGIN_DATA: f.dir };
  delete env.CODEX_APP_TOOLS_PIPE_PATH; delete env.CODEX_CHAT_READ_CONFIG; delete env.CODEX_CHAT_EVENTS_PRIVATE_CONNECTION;
  if (chat) env.CODEX_CHAT_READ_CONFIG = f.policy;
  const child = spawn(process.execPath, [serverScript], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
  let seq = 0, diagnostics = ""; const pending = new Map(); child.stderr.on("data", value => { diagnostics += value; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), waiter = pending.get(message.id);
    if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message.result ?? message.error);
  });
  child.on("exit", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("fixture server exited")); } pending.clear(); });
  return { rpc(method, params = {}) { const id = ++seq; return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => reject(Error("fixture RPC timeout")), 20000); pending.set(id, { resolve: resolveCall, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }); }, async tool(name, args) { const response = await this.rpc("tools/call", { name, arguments: args }); return JSON.parse(response.content[0].text); },
  diagnostics: () => diagnostics, close() { child.kill(); children.delete(child); } };
}

const input = (requestId = randomUUID()) => ({ requestId, prompt: "Explicit user-requested local fixture task", target: { type: "projectless", directoryName: "fixture-task" } });
try {
  const f = fixture("normal"), chat = server(f), qoder = server(f, false);
  const chatTools = (await chat.rpc("tools/list")).tools;
  assert(chatTools.some(tool => tool.name === "create_codex_task")); assert(chatTools.some(tool => tool.name === "codex_task_status"));
  assert(chatTools.find(tool => tool.name === "list_codex_projects").annotations.readOnlyHint);
  assert.deepEqual((await chat.tool("list_codex_projects", {})).projects,
    [{ projectId: "local-project", projectKind: "local", hostId: "local", path: f.dir, label: "Local fixture", isGitRepository: false }]);
  assert.equal(f.calls().length, 0);
  assert.equal((await qoder.rpc("tools/list")).tools.some(tool => tool.name === "create_codex_task"), false);
  assert.equal((await qoder.tool("list_codex_projects", {})).error, "create_not_enabled");
  assert.equal((await qoder.tool("create_codex_task", input())).error, "create_not_enabled");
  const args = input(), created = await chat.tool("create_codex_task", args);
  assert.equal(created.state, "created"); assert.equal(created.threadId, ready); assert.equal(created.hostId, "local"); assert.equal(created.clientThreadId, undefined);
  assert.deepEqual(await chat.tool("create_codex_task", args), created); assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0], { prompt: args.prompt, target: args.target });
  assert.equal(JSON.stringify(created).includes("PRIVATE_NATIVE_SENTINEL"), false);
  assert.equal((await chat.tool("create_codex_task", { ...args, prompt: "changed" })).error, "create_request_conflict");
  assert.equal(f.calls().length, 1);
  assert.deepEqual(await chat.tool("codex_task_status", { requestId: args.requestId }), created);
  const projectArgs = { requestId: randomUUID(), prompt: "local project", target: { type: "project", projectId: "local-project", environment: { type: "local" } }, model: "gpt-6.1-sol", thinking: "max", title: "Fixture" };
  assert.equal((await chat.tool("create_codex_task", projectArgs)).state, "created");
  assert.deepEqual(f.calls()[1], { prompt: projectArgs.prompt, target: projectArgs.target, model: projectArgs.model, thinking: "max", title: "Fixture" });
  for (const target of [{ type: "chatgptWorkCloud" }, { type: "project", projectId: "local-project", environment: { type: "worktree" } }])
    assert.equal((await chat.tool("create_codex_task", { ...input(), target })).error, "create_local_target_required");
  for (const projectId of ["work-project", "remote-project", "absent"]) assert.equal((await chat.tool("create_codex_task", {
    ...input(), target: { type: "project", projectId, environment: { type: "local" } } })).error, "create_project_unavailable");
  assert.equal(f.calls().length, 2);
  assert.equal((await chat.tool("codex_task_status", { requestId: randomUUID() })).state, "not_found");
  const receiptPath = join(f.dir, `create-${args.requestId}.json`), validReceipt = fs.readFileSync(receiptPath, "utf8");
  const invalidReceipt = JSON.parse(validReceipt); invalidReceipt.inputSha256 = ["a".repeat(64)];
  fs.writeFileSync(receiptPath, JSON.stringify(invalidReceipt));
  assert.equal((await chat.tool("codex_task_status", { requestId: args.requestId })).error, "create_record_invalid",
    "an array that coerces to a SHA256 string must not establish native acceptance");
  fs.writeFileSync(receiptPath, validReceipt);
  assert.deepEqual(await chat.tool("codex_task_status", { requestId: args.requestId }), created);
  assert.equal(chat.diagnostics().includes(args.prompt), false); assert.equal(chat.diagnostics().includes("PRIVATE_NATIVE_SENTINEL"), false);
  chat.close(); qoder.close();

  const concurrent = fixture("concurrent"), clients = Array.from({ length: 6 }, () => server(concurrent)), same = input();
  const outcomes = await Promise.all(clients.map(client => client.tool("create_codex_task", same)));
  assert(outcomes.every(value => ["created", "uncertain"].includes(value.state))); assert.equal(concurrent.calls().length, 1);
  assert.equal((await clients[0].tool("codex_task_status", { requestId: same.requestId })).state, "created");
  clients.forEach(client => client.close());

  const unknown = fixture("unknown"); fs.writeFileSync(join(unknown.dir, "unknown"), ""); let unknownServer = server(unknown); const uncertainArgs = input();
  assert.equal((await unknownServer.tool("create_codex_task", uncertainArgs)).state, "uncertain"); unknownServer.close(); fs.unlinkSync(join(unknown.dir, "unknown"));
  unknownServer = server(unknown); assert.equal((await unknownServer.tool("create_codex_task", uncertainArgs)).state, "uncertain");
  assert.equal(unknown.calls().length, 1); assert(managedStoreStatus(unknown.dir).reservedBytes > 0); unknownServer.close();

  const setup = fixture("setup"); fs.writeFileSync(join(setup.dir, "preparing"), ""); const setupServer = server(setup), setupArgs = input();
  const queued = await setupServer.tool("create_codex_task", setupArgs);
  assert.equal(queued.state, "unresolved"); assert.equal(queued.clientThreadId, preparing); assert.equal(queued.threadId, undefined);
  assert.equal(queued.reason, "native_preparation_lookup_unavailable"); assert.equal(queued.statusScope, "local_creation_record");
  assert.deepEqual(await setupServer.tool("create_codex_task", setupArgs), queued); assert.equal(setup.calls().length, 1); setupServer.close();

  const denied = fixture("budget", 1), deniedServer = server(denied);
  assert.equal((await deniedServer.tool("create_codex_task", input())).state, "not_created"); assert.equal(denied.calls().length, 0); deniedServer.close();
  const mismatch = fixture("bad-ack"); fs.writeFileSync(join(mismatch.dir, "bad-ack"), ""); const mismatchServer = server(mismatch), mismatchArgs = input();
  assert.equal((await mismatchServer.tool("create_codex_task", mismatchArgs)).state, "uncertain");
  assert.equal((await mismatchServer.tool("create_codex_task", mismatchArgs)).state, "uncertain"); assert.equal(mismatch.calls().length, 1); mismatchServer.close();
  console.log("local Codex creation: Chat-only scope, native project validation, ready/unresolved mapping, same-ID conflict/concurrency, unknown no-replay and physical budget passed; native outputs are fixtures, not live acceptance");
} finally { for (const child of children) child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
