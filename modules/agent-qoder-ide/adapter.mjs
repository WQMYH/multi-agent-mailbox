import { activateConversation, listInstances, readConfig, readConversationStatus, readIdentity, readMessageOwner,
  runToolkit, sendCurrentConversation, toolkitCommands } from "./client.mjs";

const target = Object.freeze({ id: "qoder-cn-ide", kind: "desktop", label: "Qoder CN IDE" });
const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const path = { type: "string", minLength: 3, maxLength: 4096 };
const receiptId = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const definitions = [
  ["instances", "List configured Qoder IDE bridge instances and their explicit workspaces without contacting them.", true, {}, []],
  ["identity", "Read one authenticated Qoder IDE instance identity for an explicit workspace.", true,
    { instanceId: uuid, workspace: path }, ["instanceId", "workspace"]],
  ["toolkit_check", "Run one configured Paradox Toolkit command in an explicit Qoder IDE instance/workspace. A requestId is single-use; unknown outcomes are never retried automatically.", false,
    { instanceId: uuid, workspace: path, requestId: uuid,
      command: { type: "string", enum: toolkitCommands }, targetPath: path },
    ["instanceId", "workspace", "requestId", "command"]],
  ["conversation_activate", "Open or activate one known conversation in the selected single-workspace IDE window. This does not atomically bind a later send.", false,
    { instanceId: uuid, workspace: path, requestId: uuid,
      sessionId: { type: "string", minLength: 1, maxLength: 512 },
      sessionType: { type: "string", minLength: 1, maxLength: 128 },
      title: { type: "string", minLength: 1, maxLength: 1000 },
      targetRemoteAuthority: { type: "string", maxLength: 512 } },
    ["instanceId", "workspace", "requestId", "sessionId", "sessionType", "title"]],
  ["conversation_send_current", "Persist and send one page-level message to the current page in the selected IDE window. The page can change before dispatch; precise session delivery is not claimed.", false,
    { instanceId: uuid, workspace: path, requestId: uuid,
      deliveryId: receiptId, correlation: receiptId,
      content: { type: "string", minLength: 1, maxLength: 16000 } },
    ["instanceId", "workspace", "requestId", "content"]],
  ["conversation_status", "Read the persisted page-level delivery, matching Hook evidence and corresponding reply preview without consuming or acknowledging it.", true,
    { instanceId: uuid, workspace: path, requestId: uuid }, ["instanceId", "workspace", "requestId"]]
].map(([name, description, readOnlyHint, properties, required]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint }
}));

function validate(operation, args) {
  const definition = definitions.find(candidate => candidate.name === operation);
  if (!definition) throw Error("Unknown Qoder IDE operation");
  if (!args || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)))
    throw Error("Arguments must be an object");
  const { properties, required } = definition.inputSchema;
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (!rule) throw Error(`Unknown argument: ${key}`);
    if (rule.type === "string" && (typeof value !== "string" || value.length < (rule.minLength ?? 1) ||
        value.length > (rule.maxLength ?? 4096) || rule.pattern && !new RegExp(rule.pattern).test(value) ||
        rule.enum && !rule.enum.includes(value))) throw Error(`Invalid ${key}`);
  }
  for (const key of required) if (!Object.hasOwn(args, key)) throw Error(`Missing ${key}`);
  if (operation === "toolkit_check" && args.command === "px.runTiger" && !args.targetPath)
    throw Error("px.runTiger requires targetPath");
  if (operation === "toolkit_check" && args.command !== "px.runTiger" && args.targetPath)
    throw Error(`${args.command} does not accept targetPath`);
  return definition;
}

export async function describe() { return structuredClone(definitions); }

export async function call(operation, args = {}, services = {}) {
  validate(operation, args);
  const config = services.config ?? readConfig();
  if (operation === "instances") return { target, instances: (services.listInstances ?? listInstances)(config) };
  if (operation === "identity") return { target, experimental: true,
    ...(await (services.readIdentity ?? readIdentity)(args, config)) };
  if (operation === "conversation_status") {
    const result = await (services.readConversationStatus ?? readConversationStatus)(args, config);
    const messageReceipt = {
      schemaVersion: 1, requestId: result.requestId, deliveryId: result.deliveryId, ownerId: result.ownerId,
      target: { moduleId: "agent-qoder-ide", address: args.instanceId }, correlation: result.correlation,
      acceptance: {
        owner: result.reservation?.state === "persisted" ?
          { state: "accepted", evidence: "exclusive durable page reservation" } : { state: "unknown" },
        provider: result.providerAcceptance?.state === "accepted" ?
          { state: "accepted", evidence: "matched UserPromptSubmit hook" } : { state: "unknown" }
      }
    };
    services.validateMessageReceipt?.(messageReceipt);
    return { target, experimental: true, ...result, messageReceipt };
  }
  services.assertCurrent?.();
  const invoke = operation === "toolkit_check" ? services.runToolkit ?? runToolkit
    : operation === "conversation_activate" ? services.activateConversation ?? activateConversation
    : services.sendCurrentConversation ?? sendCurrentConversation;
  const ownerId = (services.readMessageOwner ?? readMessageOwner)(config, args.instanceId);
  const budget = services.messageBudget?.status?.();
  const allocation = budget?.allocations?.find(candidate => candidate.ownerId === ownerId);
  const preflight = allocation && services.messageBudget.check({ ownerId, usedBytes: 0, additionalBytes: 1 });
  if (!allocation || !preflight?.ok)
    throw Error(`Qoder IDE mutation backpressure: ${preflight?.reason ?? "owner_budget_not_configured"}`);
  const mutationArgs = { ...args, ownerId, allocatedBytes: allocation.bytes };
  if (operation !== "conversation_send_current")
    return { target, experimental: true, ...(await invoke(mutationArgs, config)) };
  const deliveryId = args.deliveryId ?? args.requestId;
  const correlation = args.correlation ?? args.requestId;
  const result = await invoke({ ...mutationArgs, deliveryId, correlation }, config);
  const ownerAccepted = result.reservation?.state === "persisted" &&
    result.reservation.ownerId === ownerId && result.reservation.deliveryId === deliveryId;
  const providerAccepted = result.providerAcceptance?.state === "accepted";
  const messageReceipt = {
    schemaVersion: 1, requestId: args.requestId, deliveryId, ownerId,
    target: { moduleId: "agent-qoder-ide", address: args.instanceId }, correlation,
    acceptance: {
      owner: ownerAccepted ? { state: "accepted", evidence: "exclusive durable page reservation" } : { state: "unknown" },
      provider: providerAccepted ? { state: "accepted", evidence: "matched UserPromptSubmit hook" } : { state: "unknown" }
    }
  };
  services.validateMessageReceipt?.(messageReceipt);
  return { target, experimental: true, ...result, messageReceipt };
}
