import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, "runtime"), { recursive: true });
await cp(join(root, "../../qoder-ide-bridge/extension/message-observe.cjs"), join(root, "runtime/message-observe.cjs"));
await cp(join(root, "../agent-core/src/contracts.mjs"), join(root, "runtime/core-contracts.mjs"));
console.log("built agent-qoder-ide runtime (pure observer + shared Core contracts)");
