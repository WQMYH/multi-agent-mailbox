import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Notification", "PreCompact"
]);
const REQUIRED_LIFECYCLE_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"];
const EXPECTED_MANIFEST_HOOKS_REF = "./hooks/hooks.json";
const EXPECTED_MANIFEST_MCP_REF = "./mcp.json";
const EXPECTED_COMMAND_REF = "./commands/codex-message.md";

// Path components in shipped config must stay inside the plugin root; a manifest
// that reaches "../" or an absolute path is rejected rather than trusted.
function staysInside(baseDir, targetPath) {
  const rel = relative(resolve(baseDir), resolve(targetPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function issue(diagnostics, path, message) { diagnostics.push({ path, message }); }

export function validateManifestObject(manifest) {
  const diagnostics = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    issue(diagnostics, "manifest", "plugin.json must be a JSON object");
    return diagnostics;
  }
  if (typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(manifest.name))
    issue(diagnostics, "manifest.name", "name must be a lowercase slug");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version))
    issue(diagnostics, "manifest.version", "version must be a semantic version string");
  if (manifest.hooks !== EXPECTED_MANIFEST_HOOKS_REF)
    issue(diagnostics, "manifest.hooks", `hooks must be the relative reference "${EXPECTED_MANIFEST_HOOKS_REF}"`);
  if (manifest.mcpServers !== EXPECTED_MANIFEST_MCP_REF)
    issue(diagnostics, "manifest.mcpServers", `mcpServers must be the relative reference "${EXPECTED_MANIFEST_MCP_REF}"`);
  if (manifest.commands?.["codex-message"]?.source !== EXPECTED_COMMAND_REF)
    issue(diagnostics, "manifest.commands", `codex-message must reference "${EXPECTED_COMMAND_REF}"`);
  return diagnostics;
}

function validateHookCommand(entry, where, diagnostics) {
  if (!entry || typeof entry !== "object") { issue(diagnostics, where, "hook entry must be an object"); return; }
  if (entry.type !== "command")
    issue(diagnostics, `${where}.type`, `only Qoder command-type hooks are supported, got ${JSON.stringify(entry.type)}`);
  if ("process" in entry || "timeoutMs" in entry)
    issue(diagnostics, `${where}`, "legacy ZCode fields (process/timeoutMs) are not Qoder hook fields");
  // `args` (exec form) IS a valid Qoder command-hook option, but this plugin ships only the
  // shell-string `command` form, so args is rejected as outside this plugin's supported subset.
  if ("args" in entry)
    issue(diagnostics, `${where}.args`, "exec-form args are valid Qoder but outside this plugin's shell-string command subset");
  if (typeof entry.command !== "string" || !entry.command.trim())
    issue(diagnostics, `${where}.command`, "command must be a non-empty string");
  else if (!entry.command.includes("handler.mjs"))
    issue(diagnostics, `${where}.command`, "command must invoke handler.mjs");
  else if (!entry.command.includes("${QODER_PLUGIN_ROOT}"))
    issue(diagnostics, `${where}.command`, "command must resolve handler via ${QODER_PLUGIN_ROOT}, not a hardcoded path");
  if (entry.timeout !== undefined && !(typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout > 0 && entry.timeout <= 600))
    issue(diagnostics, `${where}.timeout`, "timeout must be a positive number of seconds");
}

export function validateHooksObject(hooksConfig) {
  const diagnostics = [];
  if (!hooksConfig || typeof hooksConfig !== "object" || Array.isArray(hooksConfig)) {
    issue(diagnostics, "hooks", "hooks.json must be a JSON object");
    return diagnostics;
  }
  const groups = hooksConfig.hooks;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    issue(diagnostics, "hooks.hooks", "missing hooks map");
    return diagnostics;
  }
  for (const event of Object.keys(groups)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) issue(diagnostics, `hooks.${event}`, "unknown Qoder hook event");
    const matchers = groups[event];
    if (!Array.isArray(matchers) || matchers.length === 0) { issue(diagnostics, `hooks.${event}`, "event must map to a non-empty array"); continue; }
    matchers.forEach((matcher, mi) => {
      if (!matcher || typeof matcher !== "object") { issue(diagnostics, `hooks.${event}[${mi}]`, "matcher must be an object"); return; }
      if (!Array.isArray(matcher.hooks) || matcher.hooks.length === 0) { issue(diagnostics, `hooks.${event}[${mi}].hooks`, "matcher needs a non-empty hooks array"); return; }
      matcher.hooks.forEach((entry, ei) => validateHookCommand(entry, `hooks.${event}[${mi}].hooks[${ei}]`, diagnostics));
    });
  }
  for (const event of REQUIRED_LIFECYCLE_EVENTS)
    if (!Object.prototype.hasOwnProperty.call(groups, event)) issue(diagnostics, `hooks.${event}`, "required lifecycle event is not wired");
  return diagnostics;
}

export function validatePluginConfig(pluginDir, { read = (p) => readFileSync(p, "utf8") } = {}) {
  const diagnostics = [];
  const root = resolve(pluginDir);
  let manifest;
  try {
    manifest = JSON.parse(read(join(root, ".qoder-plugin", "plugin.json")));
  } catch (error) {
    return { ok: false, diagnostics: [{ source: "plugin.json", path: "manifest", message: `unreadable: ${error.message}` }] };
  }
  diagnostics.push(...validateManifestObject(manifest).map(d => ({ source: "plugin.json", ...d })));
  // Validate the hooks reference and fail closed on anything non-relative or
  // escaping BEFORE touching the filesystem, so an escaping manifest can never
  // cause the hooks body outside the plugin root to be read.
  if (typeof manifest?.hooks !== "string") {
    return { ok: false, diagnostics: [...diagnostics, { source: "plugin.json", path: "manifest.hooks", message: "hooks reference must be a string" }] };
  }
  const hooksPath = resolve(root, manifest.hooks);
  if (!staysInside(root, hooksPath)) {
    return { ok: false, diagnostics: [...diagnostics, { source: "plugin.json", path: "manifest.hooks", message: "hooks reference escapes the plugin root" }] };
  }
  try {
    diagnostics.push(...validateHooksObject(JSON.parse(read(hooksPath))).map(d => ({ source: "hooks.json", ...d })));
  } catch (error) {
    diagnostics.push({ source: "hooks.json", path: "hooks", message: `unreadable: ${error.message}` });
  }
  // Only the packaged local stdio server is in this plugin's supported subset.
  if (manifest.mcpServers === EXPECTED_MANIFEST_MCP_REF) {
    try {
      const mcp = JSON.parse(read(join(root, "mcp.json")));
      const server = mcp?.mcpServers?.["qoder-codex-bridge"];
      if (server?.command !== "node" || JSON.stringify(server.args) !== JSON.stringify(["${QODER_PLUGIN_ROOT}/scripts/mcp-server.mjs"]))
        diagnostics.push({ source: "mcp.json", path: "mcpServers.qoder-codex-bridge", message: "expected packaged local Node stdio server" });
    } catch (error) {
      diagnostics.push({ source: "mcp.json", path: "mcpServers", message: `unreadable: ${error.message}` });
    }
  }
  if (manifest.commands?.["codex-message"]?.source === EXPECTED_COMMAND_REF) {
    try { if (!read(join(root, "commands", "codex-message.md")).trim()) throw Error("empty command"); }
    catch (error) { diagnostics.push({ source: "codex-message.md", path: "commands.codex-message", message: `unreadable: ${error.message}` }); }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
