import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const schema = "https://raw.githubusercontent.com/WQMYH/Codex-with-Zcode/main/config.schema.json";

export function configPath() {
  const configured = process.env.ZCODE_OPS_CONFIG;
  if (configured && !isAbsolute(configured)) throw Error("ZCODE_OPS_CONFIG must be an absolute path");
  return configured || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "zcode-ops", "config.json");
}

export function validateSharingLink(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("Cannot use the saved ZCode Sharing Link; ask the user for the current link and call zcode_config_set"); }
  if (url.origin !== "https://zcode.z.ai" || url.pathname !== "/remote/v4" || url.username || url.password ||
      !["sid", "hash", "mid"].every(key => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key))) {
    throw Error("Cannot use the saved ZCode Sharing Link; ask the user for the current link and call zcode_config_set");
  }
  return url;
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["$schema", "schemaVersion", "promptOnStartup", "sharingLink", "updatedAt"].includes(key)) ||
      value.schemaVersion !== 1 || (value.promptOnStartup !== undefined && typeof value.promptOnStartup !== "boolean") ||
      !(value.sharingLink === null || typeof value.sharingLink === "string")) throw Error("Invalid ZCode Ops config schema");
  if (typeof value.sharingLink === "string" && (!value.sharingLink.trim() || value.sharingLink.length > 4096)) throw Error("Invalid ZCode Ops config schema");
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt)))) throw Error("Invalid config updatedAt");
  return value;
}

export function readConfig({ optional = false, path = configPath() } = {}) {
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 16384) throw Error("Config exceeds size limit");
    return validateConfig(JSON.parse(text));
  } catch (error) {
    if (optional && !existsSync(path)) return null;
    throw error instanceof SyntaxError ? Error("ZCode Ops config is not valid JSON") : error;
  }
}

export function writeConfig({ sharingLink = null }, path = configPath()) {
  if (!(sharingLink === null || typeof sharingLink === "string") || (typeof sharingLink === "string" && (!sharingLink.trim() || sharingLink.length > 4096))) throw Error("sharingLink must be a non-empty bounded string or null");
  const config = { $schema: schema, schemaVersion: 1, promptOnStartup: false, sharingLink, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  return config;
}

export function readSharingLink() {
  const config = readConfig();
  if (!config.sharingLink) throw Error("ZCode is not configured; ask the user for the current Sharing Link and call zcode_config_set");
  return config.sharingLink;
}

export const configTools = [
  { name: "zcode_config_status", description: "Read installed ZCode Ops configuration status without returning the sharing link.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "zcode_config_set", description: "Save a user-provided ZCode Sharing Link without pre-validating it. Connection errors mean the user should provide a fresh link.", inputSchema: { type: "object", properties: { sharingLink: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["sharingLink"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "zcode_config_clear", description: "Clear the saved sharing link.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }
];

export async function callConfigTool(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid config tool arguments");
  if (name === "zcode_config_status") {
    let value;
    try { value = readConfig({ optional: true }); }
    catch (error) { return { configPath: configPath(), configured: false, valid: false, error: error.message }; }
    return { configPath: configPath(), configured: Boolean(value?.sharingLink), valid: value !== null,
      schemaVersion: value?.schemaVersion ?? null, updatedAt: value?.updatedAt ?? null };
  }
  if (name === "zcode_config_clear") {
    const next = writeConfig({ sharingLink: null });
    return { saved: true, configured: false, configPath: configPath(), updatedAt: next.updatedAt };
  }
  if (name === "zcode_config_set") {
    if (Object.keys(args).some(key => key !== "sharingLink") || typeof args.sharingLink !== "string") throw Error("Set sharingLink");
    const next = writeConfig({ sharingLink: args.sharingLink });
    return { saved: true, configured: true, configPath: configPath(), updatedAt: next.updatedAt };
  }
  throw Error("Unknown config tool");
}
