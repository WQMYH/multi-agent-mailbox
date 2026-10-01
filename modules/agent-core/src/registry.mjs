import {
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  checkMessageBudget,
  planMessageBudget,
  validateMessageBudget,
  validateMessageReceipt
} from "./contracts.mjs";

export const REGISTRY_VERSION = 1;

const moduleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const operationPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const NO_WRITE = Symbol("no-write");

const fail = message => { throw Error(message); };

const isObject = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const copy = value => structuredClone(value);

const within = (root, target) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export const validateModuleId = value => {
  if (typeof value !== "string" || !moduleIdPattern.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value.toLowerCase())) fail("Invalid moduleId");
  return value;
};

export const validateOperation = value => {
  if (typeof value !== "string" || !operationPattern.test(value)) fail("Invalid operation");
  return value;
};

export const validateArguments = value => {
  if (value === undefined) return {};
  if (!isObject(value)) fail("Arguments must be a JSON object");
  return value;
};

function envelope(value, allowed) {
  value = validateArguments(value);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown argument: ${key}`);
  return value;
}

export function defaultRegistryPath(env = process.env) {
  return resolve(env.AGENT_CORE_REGISTRY || join(homedir(), ".codex-agent-core", "registry.json"));
}

function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== REGISTRY_VERSION) fail("Unsupported agent-module.json schemaVersion");
  validateModuleId(manifest.id);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) fail("Invalid module name");
  if (typeof manifest.version !== "string" || !manifest.version.trim()) fail("Invalid module version");
  if (typeof manifest.entry !== "string" || !manifest.entry.startsWith("./") || isAbsolute(manifest.entry)) fail("Module entry must be a relative ./ path");
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) fail("Module targets must be a non-empty array");
  const targetIds = new Set();
  const targets = manifest.targets.map(target => {
    if (!isObject(target) || typeof target.id !== "string" || !target.id.trim() ||
        typeof target.kind !== "string" || !target.kind.trim() ||
        typeof target.label !== "string" || !target.label.trim()) fail("Invalid module target metadata");
    if (targetIds.has(target.id)) fail(`Duplicate target id: ${target.id}`);
    targetIds.add(target.id);
    return { id: target.id, kind: target.kind, label: target.label };
  });
  return { schemaVersion: REGISTRY_VERSION, id: manifest.id, name: manifest.name, version: manifest.version,
    entry: manifest.entry, targets };
}

export function readModuleManifest(moduleRoot) {
  if (typeof moduleRoot !== "string" || !moduleRoot.trim()) fail("Module root is required");
  const root = realpathSync(resolve(moduleRoot));
  if (!statSync(root).isDirectory()) fail("Module root must be a directory");
  const manifestPath = realpathSync(join(root, "agent-module.json"));
  if (!within(root, manifestPath)) fail("Module manifest escapes its registered root");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { throw Error(`Cannot read agent-module.json: ${error.message}`); }
  manifest = validateManifest(manifest);
  let entryPath;
  try { entryPath = realpathSync(resolve(root, manifest.entry)); }
  catch (error) { throw Error(`Cannot resolve module entry: ${error.message}`); }
  if (!within(root, entryPath) || !statSync(entryPath).isFile()) fail("Module entry escapes its registered root");
  return { root, entryPath, manifest };
}

function publicRecord(record) {
  return { id: record.id, name: record.name, version: record.version, entry: record.entry,
    targets: copy(record.targets), enabled: record.enabled };
}

function emptyRegistry() {
  return { schemaVersion: REGISTRY_VERSION, modules: {} };
}

const withoutWrite = result => ({ [NO_WRITE]: true, result });

export class ModuleRegistry {
  #cache = new Map();
  constructor({ registryPath = defaultRegistryPath(), now = () => Date.now() } = {}) {
    this.registryPath = resolve(registryPath);
    this.now = now;
  }

  readState() {
    if (!existsSync(this.registryPath)) return emptyRegistry();
    let state;
    try { state = JSON.parse(readFileSync(this.registryPath, "utf8")); }
    catch (error) { throw Error(`Cannot read module registry: ${error.message}`); }
    if (!isObject(state) || state.schemaVersion !== REGISTRY_VERSION || !isObject(state.modules))
      fail("Unsupported module registry");
    for (const [id, record] of Object.entries(state.modules)) {
      validateManifest(record);
      if (record.id !== id || typeof record.root !== "string" || !isAbsolute(record.root) ||
          typeof record.entryPath !== "string" || !isAbsolute(record.entryPath) ||
          typeof record.enabled !== "boolean" || typeof record.registrationId !== "string" ||
          !record.registrationId || typeof record.revision !== "string" || !record.revision)
        fail("Invalid module registry record; explicitly reinstall the module");
    }
    if (state.messageBudget !== undefined) state.messageBudget = validateMessageBudget(state.messageBudget);
    return state;
  }

  #mutate(update) {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const lockPath = `${this.registryPath}.lock`;
    let lock;
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") fail("Registry locked by another writer; retry after it finishes. Do not remove a live lock.");
      throw error;
    }
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const state = this.readState();
      const result = update(state);
      if (result?.[NO_WRITE]) return result.result;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.registryPath);
      return result;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  record(moduleId, state = this.readState()) {
    validateModuleId(moduleId);
    if (!Object.hasOwn(state.modules, moduleId)) fail(`Unknown module: ${moduleId}`);
    const record = state.modules[moduleId];
    return record;
  }

  enabledRecord(moduleId, state = this.readState()) {
    const record = this.record(moduleId, state);
    if (!record.enabled) fail(`Module disabled: ${moduleId}`);
    return record;
  }

  list() {
    const state = this.readState();
    return Object.values(state.modules).sort((a, b) => a.id.localeCompare(b.id)).map(publicRecord);
  }

  messageBudget() {
    const budget = this.readState().messageBudget;
    return budget === undefined ? null : copy(validateMessageBudget(budget));
  }

  initializeMessageBudget(ownerIds) {
    return this.configureMessageBudget({ ownerIds });
  }

  configureMessageBudget(input = {}) {
    const { ownerIds, ...options } = validateArguments(input);
    return this.#mutate(state => {
      const enabled = ownerIds ?? state.messageBudget?.allocations.map(allocation => allocation.ownerId);
      const planned = planMessageBudget(state.messageBudget, enabled, options);
      if (!planned.ok || !planned.changed) return withoutWrite(copy(planned));
      state.messageBudget = planned.config;
      return copy(planned);
    });
  }

  checkMessageBudget(input) {
    const budget = this.readState().messageBudget;
    if (budget === undefined) return { ok: false, reason: "budget_not_configured", deltaBytes: input?.additionalBytes ?? 0 };
    return checkMessageBudget(budget, input);
  }

  install(moduleRoot) {
    const { root, entryPath, manifest } = readModuleManifest(moduleRoot);
    return this.#mutate(state => {
      state.modules[manifest.id] = {
      ...manifest,
      root, entryPath,
      enabled: true,
      registrationId: randomUUID(),
      revision: randomUUID(),
      registeredAt: new Date(this.now()).toISOString()
      };
      this.#cache.delete(manifest.id);
      return publicRecord(state.modules[manifest.id]);
    });
  }

  enable(moduleId) { return this.#setEnabled(moduleId, true); }
  disable(moduleId) { return this.#setEnabled(moduleId, false); }

  #setEnabled(moduleId, enabled) {
    return this.#mutate(state => {
      const record = this.record(moduleId, state);
      record.enabled = enabled;
      record.revision = randomUUID();
      this.#cache.delete(moduleId);
      return publicRecord(record);
    });
  }

  uninstall(moduleId) {
    return this.#mutate(state => {
      const record = this.record(moduleId, state);
      delete state.modules[moduleId];
      this.#cache.delete(moduleId);
      return { id: record.id, uninstalled: true, sourcePreserved: true, userDataPreserved: true };
    });
  }

  registeredEntry(record) {
    let root;
    let entry;
    try {
      root = realpathSync(record.root);
      entry = realpathSync(resolve(root, record.entry));
    } catch (error) { throw Error(`Module entry is unavailable: ${error.message}`); }
    if (root !== record.root || !within(root, entry) || entry !== record.entryPath || !statSync(entry).isFile())
      fail("Module entry escapes or changed from its registered root; reinstall explicitly");
    return entry;
  }

  #assertCurrent(record) {
    const current = this.enabledRecord(record.id);
    if (JSON.stringify(current) !== JSON.stringify(record)) fail(`Module registration changed: ${record.id}`);
    this.registeredEntry(current);
  }

  async #loaded(moduleId) {
    const record = this.enabledRecord(moduleId);
    const entry = this.registeredEntry(record);
    let cached = this.#cache.get(moduleId);
    if (!cached || cached.key !== JSON.stringify(record)) {
      cached = { key: JSON.stringify(record), promise: this.#load(record, entry) };
      this.#cache.set(moduleId, cached);
    }
    try {
      const loaded = await cached.promise;
      this.#assertCurrent(record);
      return loaded;
    } catch (error) {
      if (this.#cache.get(moduleId) === cached) this.#cache.delete(moduleId);
      throw error;
    }
  }

  async #load(record, entry) {
    const module = await import(`${pathToFileURL(entry).href}?agent_core=${encodeURIComponent(record.registrationId)}`);
    this.#assertCurrent(record);
    if (typeof module.describe !== "function" || typeof module.call !== "function")
      fail(`Module ${record.id} must export describe() and call()`);
    const descriptions = await module.describe();
    this.#assertCurrent(record);
    if (!Array.isArray(descriptions)) fail(`Module ${record.id} describe() must return an array`);
    const names = new Set();
    const operations = descriptions.map(operation => {
      if (!isObject(operation) || !operation.name || typeof operation.description !== "string" ||
          !isObject(operation.inputSchema) || operation.inputSchema.type !== "object" || !isObject(operation.annotations) ||
          typeof operation.annotations.readOnlyHint !== "boolean") fail(`Invalid operation description in ${record.id}`);
      validateOperation(operation.name);
      if (names.has(operation.name)) fail(`Duplicate operation: ${operation.name}`);
      names.add(operation.name);
      return copy(operation);
    });
    const context = Object.freeze({
      registrationKey: JSON.stringify([this.registryPath, record.registrationId, record.revision]),
      assertCurrent: () => this.#assertCurrent(record),
      validateMessageReceipt,
      messageBudget: Object.freeze({
        status: () => this.messageBudget(),
        check: input => this.checkMessageBudget(input)
      })
    });
    return { record, module, operations, context };
  }

  async discover({ moduleId } = {}) {
    if (moduleId === undefined) return { modules: this.list() };
    validateModuleId(moduleId);
    const loaded = await this.#loaded(moduleId);
    this.#assertCurrent(loaded.record);
    return { module: publicRecord(loaded.record), operations: copy(loaded.operations) };
  }

  async call(kind, { moduleId, operation, args } = {}) {
    if (!["read", "act"].includes(kind)) fail("Unknown call kind");
    validateModuleId(moduleId);
    validateOperation(operation);
    const normalizedArgs = validateArguments(args);
    const loaded = await this.#loaded(moduleId);
    const definition = loaded.operations.find(candidate => candidate.name === operation);
    if (!definition) fail(`Unknown operation ${operation} for module ${moduleId}`);
    const readOnly = definition.annotations.readOnlyHint === true;
    if (kind === "read" && !readOnly) fail(`agent_read cannot call mutating operation: ${operation}`);
    if (kind === "act" && readOnly) fail(`agent_act cannot call read-only operation: ${operation}`);
    this.#assertCurrent(loaded.record);
    const result = await loaded.module.call(operation, normalizedArgs, loaded.context);
    if (isObject(result) && Object.hasOwn(result, "messageReceipt")) {
      try { validateMessageReceipt(result.messageReceipt); }
      catch (error) {
        const actionMayHaveOccurred = kind === "act";
        return {
          ...result,
          messageReceiptContract: {
            status: "contract_error",
            acceptance: "unknown",
            actionMayHaveOccurred,
            retrySafe: !actionMayHaveOccurred,
            error: error.message
          }
        };
      }
    }
    return result;
  }

  async agentDiscover(args = {}) { return this.discover(envelope(args, ["moduleId"])); }
  async agentRead(args = {}) { return this.call("read", envelope(args, ["moduleId", "operation", "args"])); }
  async agentAct(args = {}) { return this.call("act", envelope(args, ["moduleId", "operation", "args"])); }
}
