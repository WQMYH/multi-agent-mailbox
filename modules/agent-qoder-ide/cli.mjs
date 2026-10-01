import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listInstances, readConfig, readIdentity } from "./client.mjs";
import { call } from "./adapter.mjs";

const usage = "Usage: node cli.mjs [--config ABS_PATH] instances | identity INSTANCE WORKSPACE | toolkit INSTANCE WORKSPACE COMMAND [TARGET_PATH]";

export async function run(argv, env = process.env) {
  let configPath, index = argv.indexOf("--config");
  if (index >= 0) {
    if (!argv[index + 1] || argv.indexOf("--config", index + 1) >= 0) throw Error(usage);
    configPath = resolve(argv[index + 1]);
    argv = [...argv.slice(0, index), ...argv.slice(index + 2)];
  }
  const config = readConfig(configPath, env);
  if (argv[0] === "instances" && argv.length === 1) return { instances: listInstances(config) };
  if (argv[0] === "identity" && argv.length === 3)
    return readIdentity({ instanceId: argv[1], workspace: resolve(argv[2]) }, config);
  if (argv[0] === "toolkit" && [4, 5].includes(argv.length)) {
    const { defaultRegistryPath, ModuleRegistry } = await import("../agent-core/src/registry.mjs");
    const registry = new ModuleRegistry({ registryPath: defaultRegistryPath(env) });
    return call("toolkit_check", { instanceId: argv[1], workspace: resolve(argv[2]), requestId: randomUUID(),
      command: argv[3], ...(argv[4] ? { targetPath: resolve(argv[4]) } : {}) }, { config,
      messageBudget: { status: () => registry.messageBudget(), check: input => registry.checkMessageBudget(input) } });
  }
  throw Error(usage);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  run(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2)), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
