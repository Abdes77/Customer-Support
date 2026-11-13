import { type SettingScope, ValidationError } from "@repo/core";

import type { SettingDefinition } from "./define";
import { type FieldProblem, problemsOf } from "./fields";
import { type AppSettings, findSetting, type SettingKey } from "./registry";

/** Why a stored or submitted value is not used. */
export type SettingIssueReason = "unknown_key" | "scope_not_allowed" | "invalid_value";

export type SettingCheck<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly definition: SettingDefinition<T> }
  | {
      readonly ok: false;
      readonly reason: SettingIssueReason;
      /** One sentence that is safe to show in the admin panel. It never repeats the value. */
      readonly message: string;
      readonly problems: readonly FieldProblem[];
    };

function pathText(path: readonly (string | number)[]): string {
  return path.map((part) => (typeof part === "number" ? `#${part + 1}` : part)).join(" > ");
}

/** "Hot from: must be above ..." for the first problem, plus a count of the others. */
export function summarizeProblems(problems: readonly FieldProblem[]): string {
  const first = problems[0];
  if (first === undefined) return "The value is not valid.";
  const where = first.path.length === 0 ? "" : `${pathText(first.path)}: `;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return `${where}${first.message}${more}`;
}

/**
 * Checks one value against the registry: the key must be declared, the scope (when given)
 * must be one the setting allows, and the value must pass the setting's schema. On success
 * `value` is the tidied value (trimmed text, sorted multi-select) that should be stored.
 *
 * This is the single gate for values: the store calls it before writing and the resolver
 * calls it on every row it reads, because rows can be written without going through the
 * store (agency staff can reach business-level rows through Supabase's REST API).
 */
export function checkSettingValue(key: string, value: unknown, scope?: SettingScope): SettingCheck {
  const definition = findSetting(key);
  if (definition === undefined) {
    return {
      ok: false,
      reason: "unknown_key",
      message: `There is no setting "${key}".`,
      problems: [],
    };
  }
  if (scope !== undefined && !definition.scopes.includes(scope)) {
    return {
      ok: false,
      reason: "scope_not_allowed",
      message: `"${definition.label}" cannot be set at the ${scope} level (allowed: ${definition.scopes.join(", ")}).`,
      problems: [],
    };
  }
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    const problems = problemsOf(parsed.error);
    return {
      ok: false,
      reason: "invalid_value",
      message: `"${definition.label}": ${summarizeProblems(problems)}`,
      problems,
    };
  }
  return { ok: true, value: parsed.data, definition };
}

/** The validated, tidied value of a declared setting. Throws `ValidationError` when it is not valid. */
export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): AppSettings[K] {
  const checked = checkSettingValue(key, value);
  if (!checked.ok) {
    throw new ValidationError(checked.message, {
      details: { key, reason: checked.reason, problems: checked.problems },
    });
  }
  return checked.value as AppSettings[K];
}
