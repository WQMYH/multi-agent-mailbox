import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ModuleRegistry, defaultRegistryPath } from "./registry.mjs";

export const usage = "Usage: node src/cli.mjs [--registry PATH] <install ROOT|list|enable ID|disable ID|uninstall ID|budget-init OWNER...|budget-status|budget status|budget check|budget sync|discover|read|act>";
const calls = new Map([
  ["discover", "agentDiscover"],
  ["read", "agentRead"],
  ["act", "agentAct"]
]);

export function parseArguments(argv) {
  const positional = [];
  let registryPath;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--registry") {
      if (registryPath !== undefined || !argv[++index] || argv[index].startsWith("--"))
        throw Error("--registry requires one path");
      registryPath = argv[index];
    } else if (argv[index].startsWith("--")) throw Error(`Unknown option: ${argv[index]}`);
    else positional.push(argv[index]);
  }
  return { registryPath, positional };
}

export function execute(argv, { env = process.env, input } = {}) {
  const { registryPath, positional } = parseArguments(argv);
  const command = positional[0];
  if (!command || command === "help") return { usage };
  const registry = new ModuleRegistry({ registryPath: registryPath ?? defaultRegistryPath(env) });
  if (command === "install" && positional.length === 2) return registry.install(resolve(positional[1]));
  if (command === "list" && positional.length === 1) return { modules: registry.list() };
  if (["enable", "disable", "uninstall"].includes(command) && positional.length === 2)
    return registry[command](positional[1]);
  if (command === "budget-init" && positional.length >= 2) return registry.initializeMessageBudget(positional.slice(1));
  if (command === "budget-status" && positional.length === 1) return { messageBudget: registry.messageBudget() };
  if (command === "budget" && positional.length === 2) {
    if (positional[1] === "status") return { messageBudget: registry.messageBudget() };
    if (positional[1] === "check") return registry.checkMessageBudget(input);
    if (positional[1] === "sync") return registry.configureMessageBudget(input);
  }
  throw Error(usage);
}

export async function invoke(argv, input, { env = process.env } = {}) {
  const { registryPath, positional } = parseArguments(argv);
  const command = positional[0];
  if (!calls.has(command) || positional.length !== 1) throw Error(usage);
  const registry = new ModuleRegistry({ registryPath: registryPath ?? defaultRegistryPath(env) });
  return registry[calls.get(command)](input);
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) throw Error("CLI input exceeds 1000000 bytes");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8").trim();
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); }
  catch { throw Error("CLI stdin must be one JSON value"); }
  return value;
}

const flushAndExit = (stream, text, code) => new Promise(resolveWrite => {
  stream.write(text, () => { resolveWrite(); process.exit(code); });
});

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const command = parseArguments(argv).positional[0];
    const budgetInput = command === "budget" && ["check", "sync"].includes(parseArguments(argv).positional[1]);
    const result = calls.has(command) ? await invoke(argv, await readInput()) :
      execute(argv, budgetInput ? { input: await readInput() } : {});
    await flushAndExit(process.stdout, `${JSON.stringify(result)}\n`, 0);
  } catch (error) {
    await flushAndExit(process.stderr, `${error.message}\n`, 1);
  }
}
