import type {
  ConnectorSyncOptions,
  FieldMapping,
  FieldMappingEntry,
  LeadSyncPayload,
} from "@repo/core";

/*
 * Field mapping: which values of the canonical lead payload go into which fields of a CRM.
 * A mapping is a list of `{ source, target, transform? }`; `source` is a dot path into the
 * payload (plus `sync.*` for the business's integration settings), `target` the CRM's field
 * name. A CRM receives exactly the mapped fields: a path that is not in the catalogue below
 * is ignored, so a mapping cannot reach anything the payload was not meant to carry.
 */

export type MappedValue = string | number | boolean;
export type MappedFields = Readonly<Record<string, MappedValue>>;

export interface MappingSource {
  readonly path: string;
  readonly label: string;
  /** True for paths that are a family (`lead.fields.<key>`): the editor asks for the key. */
  readonly prefix?: boolean;
}

/** Every path a mapping may read, for the admin panel's mapping editor (C16). */
export const MAPPING_SOURCES: readonly MappingSource[] = [
  { path: "contact.name", label: "Customer's full name" },
  { path: "contact.firstName", label: "Customer's first name" },
  { path: "contact.lastName", label: "Customer's last name" },
  { path: "contact.phone", label: "Phone number" },
  { path: "contact.email", label: "Email address" },
  { path: "contact.address", label: "Address of the job" },
  { path: "contact.postalCode", label: "ZIP code" },
  { path: "lead.id", label: "Lead id (ours)" },
  { path: "lead.status", label: "Lead status" },
  { path: "lead.score", label: "Lead score (0 to 100)" },
  { path: "lead.band", label: "Score band" },
  { path: "lead.routing", label: "Routing outcome" },
  { path: "lead.trigger", label: "What caused the update" },
  { path: "lead.report.summary", label: "Report summary" },
  { path: "lead.report.markdown", label: "Full written report" },
  { path: "lead.createdAt", label: "When the lead started" },
  { path: "lead.updatedAt", label: "When the lead last changed" },
  { path: "lead.fields.", label: "An answer the customer gave (by criterion key)", prefix: true },
  { path: "business.name", label: "Business name" },
  { path: "conversation.channel", label: "Channel" },
  { path: "conversation.url", label: "Link to the conversation" },
  { path: "booking.status", label: "Meeting status" },
  { path: "booking.startsAt", label: "Meeting start" },
  { path: "booking.endsAt", label: "Meeting end" },
  { path: "sync.leadSource", label: "Lead source (from settings)" },
  { path: "sync.tags", label: "Tags (from settings)" },
];

const EXACT = new Set(MAPPING_SOURCES.filter((s) => s.prefix !== true).map((s) => s.path));
const PREFIXES = MAPPING_SOURCES.filter((s) => s.prefix === true).map((s) => s.path);
const FIELD_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

/** True when a mapping may read `path`. */
export function isMappingSource(path: string): boolean {
  if (EXACT.has(path)) return true;
  return PREFIXES.some(
    (prefix) => path.startsWith(prefix) && FIELD_KEY.test(path.slice(prefix.length)),
  );
}

/** The value at a dot path, walking own properties of plain objects only. */
function valueAt(root: unknown, path: string): unknown {
  // `lead.fields.<key>`: the key may itself contain a dot (`system.emergency`).
  if (path.startsWith("lead.fields.")) {
    const fields = (root as { lead?: { fields?: Record<string, unknown> } }).lead?.fields;
    const key = path.slice("lead.fields.".length);
    return fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined;
  }
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Plain text of a stored value: arrays joined, objects as their values. */
export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    const parts = value.map(asText).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const parts = Object.values(value as Record<string, unknown>)
      .map(asText)
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/**
 * A US phone number in E.164 (`+15125550199`), or null when it is not one. Numbers that
 * already start with `+` keep their country code.
 */
export function toE164(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+"))
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function transformValue(
  value: unknown,
  transform: FieldMappingEntry["transform"],
): MappedValue | null {
  if (value === null || value === undefined) return null;
  switch (transform) {
    case "number": {
      const number = typeof value === "number" ? value : Number(asText(value) ?? Number.NaN);
      return Number.isFinite(number) ? number : null;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = (asText(value) ?? "").toLowerCase();
      if (["yes", "true", "y", "1"].includes(text)) return true;
      if (["no", "false", "n", "0"].includes(text)) return false;
      return null;
    }
    case "date": {
      const text = asText(value);
      if (text === null) return null;
      const time = Date.parse(text);
      return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
    }
    case "phone_e164": {
      const text = asText(value);
      return text === null ? null : toE164(text);
    }
    case "string":
      return asText(value);
    case undefined:
      if (typeof value === "number" || typeof value === "boolean") return value;
      return asText(value);
  }
}

/** Longest text a mapped field carries; a CRM field is no place for a whole transcript. */
const MAX_FIELD_LENGTH = 10_000;

export interface MappingResult {
  readonly fields: MappedFields;
  /** Entries that were skipped because their source is not in the catalogue. */
  readonly ignored: readonly string[];
}

/**
 * Applies a mapping. A missing or empty value leaves the target out (a CRM field is never
 * blanked by a value we do not know); the first entry for a target wins.
 */
export function applyFieldMapping(
  payload: LeadSyncPayload,
  mapping: FieldMapping,
  options: Pick<ConnectorSyncOptions, "leadSource" | "tags">,
): MappingResult {
  const root = { ...payload, sync: { leadSource: options.leadSource, tags: options.tags } };
  const fields: Record<string, MappedValue> = {};
  const ignored: string[] = [];
  for (const entry of mapping) {
    if (!isMappingSource(entry.source)) {
      ignored.push(entry.source);
      continue;
    }
    if (Object.hasOwn(fields, entry.target)) continue;
    const value = transformValue(valueAt(root, entry.source), entry.transform);
    if (value === null) continue;
    fields[entry.target] = typeof value === "string" ? value.slice(0, MAX_FIELD_LENGTH) : value;
  }
  return { fields, ignored };
}

/** The mapping in force: the business's own when it has entries, else the connector's. */
export function effectiveMapping(stored: FieldMapping, fallback: FieldMapping): FieldMapping {
  return stored.length > 0 ? stored : fallback;
}

/** The stored form of a mapping row (C2's setting) to the contract's entry. */
export function fromSettingMapping(
  rows: readonly {
    readonly source: string;
    readonly target: string;
    readonly transform: FieldMappingEntry["transform"] | null;
  }[],
): FieldMapping {
  return rows.map((row) => ({
    source: row.source,
    target: row.target,
    ...(row.transform === null || row.transform === undefined ? {} : { transform: row.transform }),
  }));
}

/** Text value of a mapped field, or null. */
export function mappedText(fields: MappedFields, key: string): string | null {
  const value = fields[key];
  if (value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** True when two email addresses are the same (case and surrounding space ignored). */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const left = a.trim().toLowerCase();
  return left.length > 0 && left === b.trim().toLowerCase();
}

/** True when two phone numbers are the same number (the last ten digits, at least seven). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const left = a.replace(/\D/g, "").slice(-10);
  return left.length >= 7 && left === b.replace(/\D/g, "").slice(-10);
}
