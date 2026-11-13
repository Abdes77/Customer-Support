import { getSetting, type SettingKey } from "@repo/settings";

/**
 * Small helpers shared by the prompt renderers. Everything here is deterministic: the same
 * input gives the same bytes, which is what the prompt cache needs.
 */

/** Drops control characters other than tab, newline and carriage return. */
function withoutControlCharacters(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += char;
  }
  return out;
}

/**
 * Text from outside (a customer, an imported fact, a web page) made safe to place inside a
 * delimited block: angle brackets become look-alikes so the text cannot close the block or
 * open one of its own, and control characters are dropped.
 */
export function dataText(value: string): string {
  return withoutControlCharacters(value)
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll(/\r\n?/g, "\n")
    .trim();
}

/** `dataText` on one line: for titles and attribute values. */
export function dataLine(value: string): string {
  return dataText(value).replaceAll(/\s+/g, " ").replaceAll('"', "'");
}

/** `dataLine` cut to a length: for values a customer controls that sit in a system message. */
export function dataShort(value: string, max: number): string {
  const line = dataLine(value);
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "a, b and c" */
export function listOf(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** The label of a select option as the settings screen shows it, with its description. */
export function optionText(key: SettingKey, value: string): string {
  const field = getSetting(key).field;
  if (field.kind !== "select" && field.kind !== "multi_select") return value;
  const option = field.options.find((candidate) => candidate.value === value);
  if (option === undefined) return value;
  return option.description === undefined ? option.label : `${option.label}. ${option.description}`;
}

/** The label alone. */
export function optionLabel(key: SettingKey, value: string): string {
  const field = getSetting(key).field;
  if (field.kind !== "select" && field.kind !== "multi_select") return value;
  return field.options.find((candidate) => candidate.value === value)?.label ?? value;
}

/** Parts joined with newlines, skipping the ones that are null, undefined, false or empty. */
export function lines(...parts: readonly (string | null | undefined | false)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

export function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** "Summit Roofing Co.." reads badly: two periods in a row (not an ellipsis) become one. */
export function collapseDots(value: string): string {
  return value.replaceAll(/(?<!\.)\.\.(?!\.)/g, ".");
}

/** "an on-site estimate", "a phone call". */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun.trim()) ? "an" : "a"} ${noun.trim()}`;
}

/** "1 message", "2 messages". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
