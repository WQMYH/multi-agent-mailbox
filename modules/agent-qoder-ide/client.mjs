import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const toolkitCommands = Object.freeze([
  "px.runTiger",
  "px.reloadScriptDocs",
  "px.dumpIndexStats",
  "px.tigerUnused"
]);
export const conversationCommands = Object.freeze([
  "aicoding.chat.history",
  "workbench.action.aichat.sendText"
]);
export const knownCommands = Object.freeze([...toolkitCommands, ...conversationCommands]);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plain = value => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw Error(message); };

export function defaultConfigPath(env = process.env) {
  return resolve(env.QODER_IDE_BRIDGE_CONFIG || join(homedir(), ".codex-agent-core", "agent-qoder-ide.json"));
}

export function readConfig(path, env = process.env) {
  path ??= defaultConfigPath(env);
  if (!isAbsolute(path)) fail("Qoder IDE bridge config path must be absolute");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw Error(`Cannot read Qoder IDE bridge config: ${error.message}`); }
  if (!plain(value) || value.schemaVersion !== 1 || typeof value.token !== "string" ||
      value.token.length < 32 || value.token.length > 512 || typeof value.stateDir !== "string" ||
      value.token === "replace-with-at-least-32-random-characters" ||
      !isAbsolute(value.stateDir) || !Array.isArray(value.allowedCommands) || !value.allowedCommands.length ||
      !value.allowedCommands.every((command, index, all) => knownCommands.includes(command) && all.indexOf(command) === index) ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30000)
    fail("Invalid Qoder IDE bridge config");
  return { path, token: value.token, stateDir: resolve(value.stateDir),
    allowedCommands: [...value.allowedCommands], timeoutMs: value.timeoutMs };
}

function instanceRecord(value) {
  if (!plain(value) || value.schemaVersion !== 1 || !uuid.test(value.instanceId ?? "") ||
      value.productId !== "qoder-cn-ide" || typeof value.endpoint !== "string" ||
      value.messageOwnerId !== undefined && !id.test(value.messageOwnerId) ||
      !Array.isArray(value.workspaces) || !value.workspaces.every(isAbsolute)) fail("Invalid Qoder IDE instance record");
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/")
    fail("Qoder IDE bridge endpoint must be loopback HTTP");
  return { ...value, endpoint: endpoint.origin };
}

export function listInstances(config = readConfig()) {
  let names;
  try { names = readdirSync(config.stateDir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name =>
    instanceRecord(JSON.parse(readFileSync(join(config.stateDir, name), "utf8"))))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    .map(({ endpoint, ...record }) => record);
}

function selectInstance(config, instanceId) {
  if (!uuid.test(instanceId ?? "")) fail("Invalid Qoder IDE instanceId");
  let value;
  try { value = JSON.parse(readFileSync(join(config.stateDir, `${instanceId}.json`), "utf8")); }
  catch (error) { throw Error(`Qoder IDE instance unavailable: ${error.message}`); }
  const record = instanceRecord(value);
  if (record.instanceId !== instanceId) fail("Qoder IDE instance identity mismatch");
  return record;
}

export function readMessageOwner(config, instanceId) {
  const ownerId = selectInstance(config, instanceId).messageOwnerId;
  if (!id.test(ownerId ?? "")) fail("Qoder IDE instance does not advertise a message reservation owner");
  return ownerId;
}

async function request(config, instanceId, route, body) {
  const instance = selectInstance(config, instanceId);
  if (route === "/v1/command" && instance.capabilities?.mutationOwnerBudget !== true)
    fail("Qoder IDE bridge lacks all-mutation Core owner budget enforcement; select a paired upgraded instance");
  if (route === "/v1/command") {
    const live = await request(config, instanceId, "/v1/identity", { instanceId, workspace: body.workspace });
    if (live.identity?.instanceId !== instanceId || live.identity?.capabilities?.mutationOwnerBudget !== true)
      fail("Qoder IDE bridge lacks authenticated all-mutation Core owner budget enforcement; select a paired upgraded instance");
  }
  let response;
  try {
    response = await fetch(`${instance.endpoint}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs + 1000)
    });
  } catch (error) { throw Error(`Qoder IDE bridge request failed for ${route}: ${error.message}`); }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 65536) fail("Qoder IDE bridge response exceeds 64 KiB");
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) fail("Qoder IDE bridge response exceeds 64 KiB");
  let value;
  try { value = JSON.parse(text); }
  catch { fail("Qoder IDE bridge returned invalid JSON"); }
  if (!response.ok) fail(typeof value.error === "string" ? value.error : `Qoder IDE bridge HTTP ${response.status}`);
  return value;
}

export async function readIdentity(args, config = readConfig()) {
  return request(config, args.instanceId, "/v1/identity", args);
}

export async function runToolkit(args, config = readConfig()) {
  if (!toolkitCommands.includes(args.command) || !config.allowedCommands.includes(args.command))
    fail("Toolkit command is not enabled in Qoder IDE bridge config");
  return request(config, args.instanceId, "/v1/command", args);
}

export async function activateConversation(args, config = readConfig()) {
  const command = "aicoding.chat.history";
  if (!config.allowedCommands.includes(command)) fail("Conversation activation is not enabled in Qoder IDE bridge config");
  return request(config, args.instanceId, "/v1/command", { ...args, command });
}

export async function sendCurrentConversation(args, config = readConfig()) {
  const command = "workbench.action.aichat.sendText";
  if (!config.allowedCommands.includes(command)) fail("Current-page send is not enabled in Qoder IDE bridge config");
  return request(config, args.instanceId, "/v1/command", { ...args, command });
}

export async function readConversationStatus(args, config = readConfig()) {
  return request(config, args.instanceId, "/v1/conversation/status", args);
}
