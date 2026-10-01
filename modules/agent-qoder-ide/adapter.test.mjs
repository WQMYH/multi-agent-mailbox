import { strict as assert } from "node:assert";
import { call, describe } from "./adapter.mjs";
import { validateMessageReceipt } from "../agent-core/src/contracts.mjs";

const instanceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const workspace = "E:\\fixture";
const ownerId = "qoder-ide-store:1111111111111111111111111111111111111111";
const config = { allowedCommands: ["px.runTiger", "aicoding.chat.history", "workbench.action.aichat.sendText"] };
const services = {
  config,
  listInstances: () => [{ instanceId, workspaces: [workspace] }],
  readIdentity: async args => ({ identity: { productId: "qoder-cn-ide" }, ...args }),
  runToolkit: async args => ({ state: "accepted", completion: "unobservable_after_command_return", ...args }),
  activateConversation: async args => ({ state: "accepted",
    completion: "unobservable_current_page_activation_after_command_return", ...args }),
  sendCurrentConversation: async args => ({ state: "accepted",
    completion: "provider_input_observed_reply_pending", reservation: { state: "persisted",
      ownerId, deliveryId: args.deliveryId },
    providerAcceptance: { state: "accepted" }, ...args }),
  readConversationStatus: async args => ({ state: "reply_observed", deliveryId: args.requestId,
    ownerId, correlation: args.requestId,
    reservation: { state: "persisted" }, providerAcceptance: { state: "accepted" },
    reply: { state: "observed", preview: "reply" }, ...args }),
  messageBudget: {
    status: () => ({ allocations: [{ ownerId, bytes: 1_000_000 }] }),
    check: () => ({ ok: true })
  },
  validateMessageReceipt: receipt => { services.validatedReceipt = validateMessageReceipt(receipt); },
  readMessageOwner: () => ownerId,
  assertCurrent: () => { services.currentChecks = (services.currentChecks ?? 0) + 1; }
};

const definitions = await describe();
assert.deepEqual(definitions.map(item => [item.name, item.annotations.readOnlyHint]),
  [["instances", true], ["identity", true], ["toolkit_check", false],
    ["conversation_activate", false], ["conversation_send_current", false], ["conversation_status", true]]);
assert.equal((await call("instances", {}, services)).instances.length, 1);
assert.equal((await call("identity", { instanceId, workspace }, services)).identity.productId, "qoder-cn-ide");
const action = await call("toolkit_check", { instanceId, workspace, requestId,
  command: "px.runTiger", targetPath: workspace }, services);
assert.equal(action.completion, "unobservable_after_command_return");
assert.equal(action.ownerId, ownerId);
assert.equal(action.allocatedBytes, 1_000_000);
assert.equal(action.messageReceipt, undefined);
const activation = await call("conversation_activate", { instanceId, workspace,
  requestId: "33333333-3333-4333-8333-333333333333", sessionId: "session-a",
  sessionType: "agent", title: "Conversation A" }, services);
assert.equal(activation.completion, "unobservable_current_page_activation_after_command_return");
assert.equal(activation.ownerId, ownerId);
assert.equal(activation.allocatedBytes, 1_000_000);
assert.equal(activation.messageReceipt, undefined);
const sent = await call("conversation_send_current", { instanceId, workspace,
  requestId: "44444444-4444-4444-8444-444444444444", content: "hello current page" }, services);
assert.equal(sent.messageReceipt.acceptance.owner.state, "accepted");
assert.equal(sent.messageReceipt.acceptance.provider.state, "accepted");
assert.equal(sent.messageReceipt.ownerId, ownerId);
assert.deepEqual(services.validatedReceipt, sent.messageReceipt);
const status = await call("conversation_status", { instanceId, workspace,
  requestId: "44444444-4444-4444-8444-444444444444" }, services);
assert.equal(status.reply.preview, "reply");
assert.equal(status.messageReceipt.acceptance.provider.state, "accepted");
assert.equal(services.currentChecks, 3);
for (const [operation, extra] of [["toolkit_check", { command: "px.reloadScriptDocs" }],
  ["conversation_activate", { sessionId: "session-a", sessionType: "agent", title: "Conversation A" }],
  ["conversation_send_current", { content: "no budget" }]]) {
  const args = { instanceId, workspace, requestId, ...extra };
  for (const messageBudget of [undefined, { status: () => ({ allocations: [] }) },
    { status: services.messageBudget.status, check: () => ({ ok: false, reason: "owner_limit" }) }])
    await assert.rejects(() => call(operation, args, { ...services, messageBudget,
      runToolkit: () => assert.fail("backpressure must precede Toolkit dispatch"),
      activateConversation: () => assert.fail("backpressure must precede activation"),
      sendCurrentConversation: () => assert.fail("backpressure must precede page dispatch") }), /backpressure/);
  await assert.rejects(() => call(operation, { ...args, ownerId, allocatedBytes: 1_000_000 }, services), /Unknown argument/);
}
await assert.rejects(() => call("conversation_send_current", { instanceId, workspace,
  requestId: "55555555-5555-4555-8555-555555555555", content: "" }, services), /Invalid content/);
await assert.rejects(() => call("toolkit_check", { instanceId, workspace, requestId, command: "px.runTiger" }, services), /targetPath/);
await assert.rejects(() => call("identity", { instanceId, workspace, extra: true }, services), /Unknown argument/);
await assert.rejects(() => call("toolkit_check", { instanceId, workspace, requestId,
  command: "px.reloadScriptDocs", targetPath: workspace }, services), /does not accept/);
await assert.rejects(() => call("missing", {}, services), /Unknown/);

console.log("agent-qoder-ide adapter tests passed");
