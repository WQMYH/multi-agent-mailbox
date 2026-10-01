import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ModuleRegistry, validateArguments } from "./registry.mjs";

const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
export const publicTools = [
  {
    name: "agent_discover",
    description: "List registered agent modules, or describe one selected module.",
    inputSchema: { type: "object", properties: { moduleId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "agent_read",
    description: "Call one read-only operation on one enabled registered module.",
    inputSchema: {
      type: "object", required: ["moduleId", "operation"],
      properties: { moduleId: { type: "string" }, operation: { type: "string" }, args: { type: "object" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "agent_act",
    description: "Call one mutating operation on one enabled registered module.",
    inputSchema: {
      type: "object", required: ["moduleId", "operation"],
      properties: { moduleId: { type: "string" }, operation: { type: "string" }, args: { type: "object" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false }
  }
];

const output = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const failure = (id, code, message) => output({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handle(message, core) {
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return failure(null, -32600, "Invalid JSON-RPC request");
  // Notifications never dispatch operations (in particular, never execute an unacknowledgeable action).
  if (!Object.hasOwn(message, "id")) return;
  const { id, method, params = {} } = message;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id)))
    return failure(null, -32600, "Invalid request id");
  try { validateArguments(params); }
  catch (error) { return failure(id, -32602, error.message); }
  if (method === "initialize") return output({ jsonrpc: "2.0", id, result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: manifest.name, version: manifest.version }
  } });
  if (method === "ping") return output({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return output({ jsonrpc: "2.0", id, result: { tools: publicTools } });
  if (method !== "tools/call") return failure(id, -32601, "Unsupported method");
  if (!params || typeof params.name !== "string" || !publicTools.some(tool => tool.name === params.name))
    return failure(id, -32601, "Unknown agent tool");
  try {
    const args = params.arguments === undefined ? {} : params.arguments;
    const result = params.name === "agent_discover" ? await core.agentDiscover(args)
      : params.name === "agent_read" ? await core.agentRead(args)
        : await core.agentAct(args);
    output({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] } });
  } catch (error) {
    output({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const core = new ModuleRegistry();
  const pending = new Set();
  process.stdout.on("error", () => process.exit(1));
  createInterface({ input: process.stdin }).on("line", line => {
    let message;
    try { message = JSON.parse(line); }
    catch { failure(null, -32700, "Invalid JSON-RPC"); return; }
    const work = handle(message, core).catch(() => failure(message?.id, -32603, "Request failed"));
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }).on("close", async () => {
    // Drain accepted calls and stdout before exiting, even if an adapter kept a socket/timer open.
    await Promise.allSettled([...pending]);
    process.stdout.write("", () => process.exit(0));
  });
}
