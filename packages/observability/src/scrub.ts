import { redact } from "@repo/core";

/**
 * Scrubbing of free text before anything leaves the process (Sentry, C17).
 *
 * The logger already redacts by field name (`redact` in @repo/core): message bodies, contact
 * details and credentials under their usual names never reach a record. What it cannot see is
 * free text: an error message that quotes a value, a URL with a token in its query, a string
 * in an array. `scrubText` replaces what looks like personal data or a credential in such
 * text; `scrubValue` applies both rules to a whole value. Both err on the side of removing
 * too much: an event that is harder to read is acceptable, a leaked phone number is not.
 */

export const SCRUBBED = {
  email: "[email]",
  phone: "[phone]",
  token: "[secret]",
  query: "[query]",
} as const;

/** The longest string kept in an event; longer ones are cut (free text is rarely useful). */
export const MAX_SCRUBBED_LENGTH = 500;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// North American numbers in their usual spellings, and any international "+" number.
const NANP_PHONE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;
const INTL_PHONE = /(?<![\w-])\+\d[\d\s.-]{7,17}\d(?![\w-])/g;
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|signature)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi;
const LONG_OPAQUE = /[A-Za-z0-9_-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeSecret(run: string): boolean {
  if (UUID.test(run)) return false;
  // Identifiers written as words (`pipeline-send-message-failed`) are not secrets.
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  const digits = run.replace(/\D/g, "").length;
  return digits >= 4 || run.length >= 32;
}

/**
 * The most text the patterns ever look at. Only `MAX_SCRUBBED_LENGTH` characters are kept
 * afterwards, and a pattern such as the one for email addresses takes time quadratic in the
 * length of a run without an "@": a megabyte of letters in an error message (a customer can
 * cause one) would otherwise hold the process for minutes while an event is being built.
 */
export const MAX_SCRUB_INPUT = 4 * MAX_SCRUBBED_LENGTH;

/** Replaces emails, phone numbers, credentials and URL queries in free text. */
export function scrubText(input: string): string {
  const text = input.length > MAX_SCRUB_INPUT ? input.slice(0, MAX_SCRUB_INPUT) : input;
  let out = text
    .replace(URL_QUERY, `$1?${SCRUBBED.query}`)
    .replace(EMAIL, SCRUBBED.email)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${SCRUBBED.token}`)
    .replace(KEY_VALUE, (_match, name: string, separator: string) => {
      return `${name}${separator}${SCRUBBED.token}`;
    })
    .replace(INTL_PHONE, SCRUBBED.phone)
    .replace(NANP_PHONE, SCRUBBED.phone)
    .replace(LONG_OPAQUE, (run) => (looksLikeSecret(run) ? SCRUBBED.token : run));
  if (out.length > MAX_SCRUBBED_LENGTH || input.length > text.length) {
    out = `${out.slice(0, MAX_SCRUBBED_LENGTH)}…`;
  }
  return out;
}

function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubDeep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = scrubDeep(inner, depth + 1);
  return out;
}

/**
 * A copy of `value` that may leave the process: redacted by field name (the logger's rule),
 * then every string scrubbed as free text.
 */
export function scrubValue(value: unknown): unknown {
  return scrubDeep(redact(value), 0);
}

/**
 * A URL path with the parts that may be capabilities removed: acknowledgement links,
 * webhook keys and anything that looks like a token become `[id]`; UUIDs stay.
 */
export function scrubPath(path: string): string {
  const [pathname] = path.split(/[?#]/, 1);
  return (pathname ?? "")
    .split("/")
    .map((segment) =>
      segment.length === 0 ||
      UUID.test(segment) ||
      // Route words, optionally with a short version number ("v1"); nothing else.
      /^[a-z][a-z_-]{0,40}(?:\d{1,2}(?:\.\d{1,2})?)?$/.test(segment)
        ? segment
        : "[id]",
    )
    .join("/");
}
