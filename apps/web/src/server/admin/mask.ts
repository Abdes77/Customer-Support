import type { AnyField } from "@repo/settings";

/*
 * What the browser may see of a sensitive setting (alert contacts, escalation chains, webhook
 * addresses): that it is set, how many entries it has, and for each entry a name and masked
 * contact details, never the value itself. Pure functions; the settings screen's view model
 * (`settings-view.ts`) calls them on the server before anything is sent.
 */

const BULLETS = "•••";

export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return BULLETS;
  return `${value.charAt(0)}${BULLETS}@${value.slice(at + 1)}`;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? BULLETS : `${BULLETS} ${digits.slice(-4)}`;
}

export function maskUrl(value: string): string {
  try {
    return `${new URL(value).host}/${BULLETS}`;
  } catch {
    return BULLETS;
  }
}

/** One entry of a sensitive list, as the admin panel shows it. */
export interface MaskedEntry {
  readonly label: string;
  readonly details: readonly string[];
}

const NAME_PROPERTIES = ["name", "label", "title"];

function optionLabel(field: AnyField | undefined, value: string): string {
  if (field?.kind === "multi_select" || field?.kind === "select") {
    return field.options.find((option) => option.value === value)?.label ?? value;
  }
  return value;
}

function maskText(name: string, value: string, field: AnyField | undefined): string | null {
  if (value.trim() === "") return null;
  const format = field?.kind === "text" ? field.format : null;
  if (format === "email" || /^[^\s@]+@[^\s@]+$/.test(value)) return maskEmail(value);
  if (format === "phone" || /^\+\d{7,15}$/.test(value)) return maskPhone(value);
  if (format === "url" || /^https?:\/\//i.test(value)) return maskUrl(value);
  if (field?.kind === "select") return optionLabel(field, value);
  // Any other text of a sensitive entry stays hidden: it could be a token or an address.
  return `${name} set`;
}

/** Masks one object entry of a sensitive list. */
export function maskEntry(value: unknown, index: number, item?: AnyField): MaskedEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (typeof value === "string") {
      return { label: maskText("value", value, item) ?? `Entry ${index + 1}`, details: [] };
    }
    return { label: `Entry ${index + 1}`, details: [] };
  }
  const record = value as Record<string, unknown>;
  const properties = item?.kind === "object" ? item.properties : [];
  const fieldOf = (name: string) => properties.find((property) => property.name === name)?.field;
  const nameKey = NAME_PROPERTIES.find((name) => typeof record[name] === "string");
  const label = nameKey === undefined ? `Entry ${index + 1}` : String(record[nameKey]).slice(0, 80);
  const details: string[] = [];
  for (const [name, raw] of Object.entries(record)) {
    if (name === nameKey) continue;
    const field = fieldOf(name);
    if (typeof raw === "string") {
      const shown = maskText(name, raw, field);
      if (shown !== null) details.push(shown);
    } else if (Array.isArray(raw) && raw.every((part) => typeof part === "string")) {
      if (raw.length > 0) details.push(raw.map((part) => optionLabel(field, part)).join(", "));
    } else if (typeof raw === "boolean" && name === "active" && !raw) {
      details.push("paused");
    }
  }
  return { label, details };
}

/** "Not set", "Set", "2 entries": what a sensitive value's summary says. */
export function sensitiveSummary(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value.length === 1 ? "1 entry" : `${value.length} entries`;
  }
  return "Set";
}
