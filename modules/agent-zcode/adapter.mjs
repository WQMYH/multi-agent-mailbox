import { publicTools, callPublicTool } from "./runtime/tools.mjs";

const target = Object.freeze({ id: "zcode-desktop", kind: "desktop", label: "ZCode" });
const operations = new Set(publicTools.map(tool => tool.name));

export async function describe() {
  return structuredClone(publicTools);
}

export async function call(operation, args = {}, context = {}) {
  if (!operations.has(operation)) throw Error(`Unknown ZCode operation: ${operation}`);
  const result = await callPublicTool(operation, args, {
    assertCurrent: context.assertCurrent,
    validateMessageReceipt: context.validateMessageReceipt,
    messageBudget: context.messageBudget,
    registrationKey: context.registrationKey
  });
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, target }
    : { target, value: result };
}
