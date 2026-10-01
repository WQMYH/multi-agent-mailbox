import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Build packages the unchanged Core contract; source runs use the original.
let contractUrl = new URL("./core-contracts.mjs", import.meta.url);
if (!existsSync(contractUrl)) contractUrl = new URL("../modules/agent-core/src/contracts.mjs", import.meta.url);
const contracts = existsSync(contractUrl) ? await import(contractUrl.href) : null;

export const budgetSourceError = reason => Object.assign(Error(`ZCode Core budget source unavailable: ${reason}`), {
  code: "ZCODE_BUDGET_BLOCKED", budget: { ok: false, reason }
});

export function queueBudgetContext(registrationKey) {
  let source;
  try { source = JSON.parse(registrationKey); } catch { throw budgetSourceError("budget_source_invalid"); }
  if (!Array.isArray(source) || source.length !== 3 || !source.every(value => typeof value === "string" && value) ||
      !isAbsolute(source[0]) || !contracts) throw budgetSourceError("budget_source_invalid");
  const [registryPath, registrationId, revision] = source;
  const state = () => {
    let value;
    try { value = JSON.parse(readFileSync(registryPath, "utf8")); }
    catch { throw budgetSourceError("budget_source_unavailable"); }
    const record = value?.modules?.["agent-zcode"];
    if (value?.schemaVersion !== 1 || record?.enabled !== true || record.registrationId !== registrationId || record.revision !== revision)
      throw budgetSourceError("budget_registration_changed");
    return value;
  };
  const budget = () => {
    const value = state().messageBudget;
    if (value == null) return null;
    try { return contracts.validateMessageBudget(value); }
    catch { throw budgetSourceError("budget_contract_conflict"); }
  };
  return {
    registrationKey, assertCurrent: () => { state(); },
    messageBudget: {
      status: budget,
      check: input => {
        const current = budget();
        return current ? contracts.checkMessageBudget(current, input)
          : { ok: false, reason: "budget_not_configured", deltaBytes: input.additionalBytes ?? 0 };
      }
    }
  };
}
