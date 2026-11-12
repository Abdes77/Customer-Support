import { getSetting, type SettingKey } from "@repo/settings";

/**
 * Small text helpers for scoring and the report. Customer-written values (lead field values,
 * evidence) reach staff and, through the report, possibly a model: `asData` turns them into
 * one quoted line with nothing that Markdown or HTML would act on.
 */

/** The label of a select or multi-select option, or the value itself. */
export function optionLabel(key: SettingKey, value: string): string {
  const field = getSetting(key).field;
  if (field.kind !== "select" && field.kind !== "multi_select") return value;
  return field.options.find((candidate) => candidate.value === value)?.label ?? value;
}

// Control characters, zero-width and bidirectional marks: built from code points so the source
// holds none of them.
const CONTROL = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}\u200b-\u200f\u2028-\u202e\u2066-\u2069]`,
  "gu",
);
const MARKUP = /[<>`*[\]|#\\]/g;

/** One line, no control characters, no Markdown or HTML specials, at most `max` characters. */
export function plain(text: string, max = 200): string {
  const line = text.replaceAll(CONTROL, " ").replaceAll(MARKUP, " ").replaceAll(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A customer-written value as a quoted, inert line. */
export function asData(text: string, max = 200): string {
  return `"${plain(text, max).replaceAll('"', "'")}"`;
}

export function usd(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/** Lower case words of three letters or more, with a plural "s" taken off. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
    );
}

/** Words too general to tell one service from another. */
const GENERIC = new Set([
  "and",
  "the",
  "for",
  "new",
  "service",
  "repair",
  "replacement",
  "replace",
  "install",
  "installation",
  "work",
  "job",
  "home",
  "house",
]);

/** True when every telling word of `entry` occurs in `text` ("roof repair" in "leaking roof repair"). */
export function mentions(text: string, entry: string): boolean {
  const have = new Set(words(text));
  const telling = words(entry).filter((word) => !GENERIC.has(word));
  const wanted = telling.length > 0 ? telling : words(entry);
  return wanted.length > 0 && wanted.every((word) => have.has(word));
}

/** "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
