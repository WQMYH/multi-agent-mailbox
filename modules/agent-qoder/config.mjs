import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const fields = {
  cdpPort: 'QODER_DESKTOP_CDP_PORT',
  workspaceId: 'QODER_CONTROL_WORKSPACE_ID',
  root: 'QODER_CONTROL_ROOT',
  deliveryDir: 'QODER_DELIVERY_DIR'
};
const returnFields = new Set(['returnModulePath', 'returnDataDir']);

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Qoder configuration must be a JSON object');
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(fields, key) && !returnFields.has(key)) throw Error(`Unknown Qoder configuration field: ${key}`);
    if (key === 'cdpPort') {
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Invalid Qoder cdpPort');
    } else if (key === 'workspaceId') {
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw Error('Invalid Qoder workspaceId');
    } else if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value) ||
      (process.platform === 'win32' && /^[\\/](?![\\/])/.test(value))) throw Error(`Qoder ${key} must be an absolute path`);
  }
  if ((config.returnModulePath === undefined) !== (config.returnDataDir === undefined))
    throw Error('Qoder return module and data directory must be configured together');
  return config;
}

// Synchronous read gives each call its own snapshot; discovery/import performs no I/O.
export function readOperatorConfig(env = process.env, path = join(homedir(), '.codex-agent-core', 'agent-qoder.json')) {
  let config = {};
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error(`Cannot read Qoder operator configuration: ${error.message}`); }
  validate(config); // Reject invalid files even when an environment override could hide them.
  config = { ...config };
  for (const [key, name] of Object.entries(fields)) {
    if (env[name] === undefined) continue;
    const value = env[name];
    if (key === 'cdpPort' && (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value))) throw Error('Invalid Qoder cdpPort environment override');
    config[key] = key === 'cdpPort' ? Number(value) : value;
  }
  return validate(config);
}
