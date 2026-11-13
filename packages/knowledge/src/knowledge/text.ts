/**
 * Text that arrives from outside (a CSV cell, an API field, a web page) on its way into a
 * knowledge fact. Facts end up in the bot's prompt, where the engine places them as data;
 * here they are only made clean: no control characters, no runs of blank lines, a length
 * limit that is enforced by the caller's schema.
 */

/** Drops control characters (tab and newline stay), unifies line ends, trims. */
export function cleanText(value: string): string {
  let out = "";
  for (const char of value.replaceAll(/\r\n?/g, "\n")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127 && code !== 0xfeff)) out += char;
  }
  return out
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** `cleanText` on one line. */
export function cleanLine(value: string): string {
  return cleanText(value).replaceAll(/\s+/g, " ");
}

/** "Services Offered (2024)" → "services-offered-2024". Empty when nothing is left. */
export function slug(value: string, max = 60): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, max)
    .replaceAll(/-+$/g, "");
}

/** A short, stable fingerprint of a text (FNV-1a, 32 bit), for keys that need to tell contents apart. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Letters and digits in lower case, single spaces: for comparing two texts loosely. */
export function comparable(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

const INSTRUCTION_PATTERNS = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)\b/i,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|your) (?:instructions|prompts|rules)\b/i,
  /\b(?:system|developer) prompt\b/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|chatbot|language model)\b/i,
  /\bas an ai (?:language )?model\b/i,
  /\b(?:reveal|print|repeat|show) (?:your|the) (?:instructions|prompt|rules)\b/i,
  /\bnew instructions?:/i,
  /<\/?(?:system|instructions?|prompt)>/i,
];

/**
 * True when a text reads like an instruction to a model rather than a fact about a business.
 * Used on text taken from web pages (such a "fact" is dropped), on imported facts (the row is
 * reported) and on playbooks (the document is refused). It is a filter for the obvious cases,
 * not the defence: the engine treats every fact and the playbook as data whatever they say.
 */
export function looksLikeInstruction(value: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}
