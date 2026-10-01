import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(moduleRoot, "../..", "scripts");
const runtimeRoot = join(moduleRoot, "runtime");
const runtimeFiles = [
  "config.mjs",
  "message-queue.mjs",
  "queue-budget.mjs",
  "queue-worker.mjs",
  "remote-client.mjs",
  "remote-codec.mjs",
  "remote-messages.mjs",
  "remote-tools.mjs",
  "tools.mjs"
];

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
for (const file of runtimeFiles) await cp(join(sourceRoot, file), join(runtimeRoot, file));
const sharedSources = { "core-contracts.mjs": "modules/agent-core/src/contracts.mjs" };
await cp(join(moduleRoot, "../agent-core/src/contracts.mjs"), join(runtimeRoot, "core-contracts.mjs"));

const manifest = JSON.parse(await readFile(join(moduleRoot, "agent-module.json"), "utf8"));
if (manifest.entry !== "./adapter.mjs" || manifest.id !== "agent-zcode") throw Error("Invalid generated module manifest");
await writeFile(join(moduleRoot, "build-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  moduleId: manifest.id,
  source: "scripts/",
  runtimeFiles: [...runtimeFiles, ...Object.keys(sharedSources)],
  sharedSources
}, null, 2)}\n`);
console.log(`built ${manifest.id} runtime -> ${runtimeRoot}`);
