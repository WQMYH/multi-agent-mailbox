import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStoredCodexThreads } from "./codex-inventory.mjs";

const root = mkdtempSync(join(tmpdir(), "post-codex-inventory-"));
try {
  const fixture = join(root, "native.mjs"), calls = join(root, "calls.jsonl"), mode = join(root, "mode");
  writeFileSync(fixture, `import {createInterface} from "node:readline";
import {appendFileSync, readFileSync} from "node:fs";
createInterface({input:process.stdin}).on("line", line => {
  const m=JSON.parse(line);
  if(m.id === undefined) return;
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(m)+"\\n");
  const current=readFileSync(${JSON.stringify(mode)},"utf8");
  const filtered=JSON.stringify(m.params?.modelProviders)!=="[]";
  const result=m.method==="initialize" ? {} : {
    data: filtered ? [{id:"custom", modelProvider:"custom"}] : m.params.cursor
      ? [{id:"custom", modelProvider:"custom"}] : [{id:"openai", modelProvider:"openai"}],
    nextCursor: filtered ? null : current==="repeat" || !m.params.cursor ? "page2" : null
  };
  process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");
});`);
  const spawnFixture = (executable, args, options) => {
    assert.deepEqual(args, ["-c", "features.code_mode_host=false", "app-server", "--listen", "stdio://"]);
    assert.equal(options.env.CODEX_HOME, root);
    return spawn(executable, [fixture], options);
  };
  writeFileSync(mode, "normal");
  const tasks = await listStoredCodexThreads(process.execPath, root, spawnFixture);
  assert.deepEqual(tasks.map(item => item.id), ["openai", "custom"]);
  const requests = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.map(item => item.method), ["initialize", "thread/list", "thread/list"]);
  for (const request of requests.slice(1)) {
    assert.deepEqual(request.params.modelProviders, []);
    assert.equal(request.params.archived, false);
    assert.equal(request.params.useStateDbOnly, true);
  }
  writeFileSync(mode, "repeat");
  await assert.rejects(listStoredCodexThreads(process.execPath, root, spawnFixture), { code: "host_inventory_unavailable" });
  console.log("Codex inventory: provider-independent pagination, metadata-only reads and repeated-cursor rejection passed");
} finally { rmSync(root, { recursive: true, force: true }); }
