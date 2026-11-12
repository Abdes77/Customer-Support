import { htmlToText } from "./html";

/*
 * What the customer wrote this time: the body without the earlier messages a reply quotes
 * and without the signature. The bot reads this, and the inbox shows it. Earlier messages of
 * the thread are already in the conversation, so dropping their quoted copies loses nothing
 * and keeps old text (and anything planted in it) from being read as new.
 */

export interface CleanedBody {
  readonly text: string;
  readonly quoteRemoved: boolean;
  readonly signatureRemoved: boolean;
  /** The text was cut to `MAX_BODY_CHARS`. */
  readonly truncated: boolean;
}

/** Longest body the bot reads; a longer one is cut with a note. */
export const MAX_BODY_CHARS = 12_000;

const ON_WROTE = /^(?:on|am|le|el)\b[\s\S]{0,400}?\b(?:wrote|schrieb|a écrit|escribió)\s*:\s*$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*(?:original message|reply message|original)\s*-{2,}\s*$/i;
const UNDERSCORE_RULE = /^_{8,}\s*$/;
const HEADER_FROM = /^\*?from\s*:\*?\s+\S/i;
const HEADER_FIELD = /^\*?(?:sent|date|to|subject|cc)\s*:\*?\s+/i;
const FORWARDED = /^-{2,}\s*forwarded message\s*-{2,}\s*$|^begin forwarded message:\s*$/i;
const SIGNATURE_RULE = /^-- ?$/;
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv)\s*:/i;
const MOBILE_SIGNATURE =
  /^(?:sent from (?:my )?(?:iphone|ipad|android|galaxy|samsung|mobile|phone|pixel|blackberry|windows phone|outlook|yahoo mail|aol)\b.*|get outlook for (?:ios|android)\b.*|sent via .{1,40}|sent from outlook\b.*)$/i;

function isQuoteHeaderAt(lines: readonly string[], index: number): boolean {
  const line = lines[index]!.trim();
  if (ORIGINAL_MESSAGE.test(line)) return true;
  // "On Tue, Nov 10, 2026 at 3:04 PM Sam <office@acme.test> wrote:" may wrap over 3 lines.
  if (/^(?:on|am|le|el)\b/i.test(line)) {
    for (let span = 1; span <= 3 && index + span <= lines.length; span += 1) {
      const joined = lines
        .slice(index, index + span)
        .map((item) => item.trim())
        .join(" ");
      if (ON_WROTE.test(joined)) return true;
    }
  }
  // Outlook: an underscore rule, then "From: …" and "Sent: …".
  if (UNDERSCORE_RULE.test(line)) {
    const next = lines.slice(index + 1, index + 3).map((item) => item.trim());
    if (next.some((item) => HEADER_FROM.test(item))) return true;
  }
  // A bare header block: "From: …" followed by "Sent:/Date:" and "To:/Subject:".
  if (HEADER_FROM.test(line)) {
    const next = lines.slice(index + 1, index + 5).map((item) => item.trim());
    return next.filter((item) => HEADER_FIELD.test(item)).length >= 2;
  }
  return false;
}

const QUOTED = /^\s*>/;

/**
 * The customer's own lines below a quote header: what they wrote between or after the `>`
 * lines (an interleaved or bottom-posted reply). Only when the quote is marked with `>`;
 * an unmarked block below a header (Outlook) is the earlier message itself.
 */
function ownLinesBelow(below: readonly string[]): string[] {
  const first = below.findIndex((line) => QUOTED.test(line));
  if (first < 0) return [];
  const own: string[] = [];
  for (let index = first + 1; index < below.length; index += 1) {
    const line = below[index]!;
    if (QUOTED.test(line)) {
      if (own.length > 0 && own[own.length - 1] !== "") own.push("");
      continue;
    }
    if (line.trim().length > 0 && isQuoteHeaderAt(below, index)) break;
    own.push(line);
  }
  return own;
}

function cutQuotes(lines: string[]): { lines: string[]; removed: boolean } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    // A forwarded message is the customer's to share: keep it.
    if (FORWARDED.test(line)) return { lines, removed: false };
    if (isQuoteHeaderAt(lines, index)) {
      const above = lines.slice(0, index);
      const own = ownLinesBelow(lines.slice(index + 1));
      if (own.some((item) => item.trim().length > 0)) {
        return { lines: [...above, "", ...own], removed: true };
      }
      return { lines: above, removed: true };
    }
  }
  // A trailing block of "> " lines (with blank lines between) is a quote without a header.
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  let start = end;
  while (start > 0 && (/^\s*>/.test(lines[start - 1]!) || lines[start - 1]!.trim() === "")) {
    start -= 1;
  }
  if (start < end && lines.slice(start, end).some((line) => /^\s*>/.test(line))) {
    return { lines: lines.slice(0, start), removed: true };
  }
  return { lines, removed: false };
}

function cutSignature(lines: string[]): { lines: string[]; removed: boolean } {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (SIGNATURE_RULE.test(lines[index]!)) {
      // "-- " starts the signature (RFC 3676 §4.3): only near the end, so a "--" inside the
      // text is not taken for one.
      if (lines.length - index <= 15) return { lines: lines.slice(0, index), removed: true };
      break;
    }
  }
  // "Sent from my iPhone" and the like, as the last line: never a line with the
  // customer's words after it ("Sent via email yesterday.\nCan you confirm?").
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  if (last >= 0 && MOBILE_SIGNATURE.test(lines[last]!.trim())) {
    return { lines: lines.slice(0, last), removed: true };
  }
  return { lines, removed: false };
}

function tidy(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/[ \t\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The new text of an email from its text part, or from its HTML when it has none. */
export function cleanBody(input: {
  readonly text: string | null;
  readonly html: string | null;
  /** A forwarded email ("Fwd: …") keeps the message it forwards, whatever its layout. */
  readonly subject?: string | null;
}): CleanedBody {
  const forwarded = FORWARD_SUBJECT.test(input.subject ?? "");
  let quoteRemoved = false;
  let source = input.text ?? "";
  if (source.trim().length === 0 && input.html !== null) {
    const fromHtml = htmlToText(input.html, { keepQuotes: forwarded });
    source = fromHtml.text;
    quoteRemoved = fromHtml.quoteRemoved;
  }
  const original = source.replace(/\r\n?/g, "\n").replace(/\u200b|\ufeff/g, "");
  // Outlook writes a forward exactly like a reply (a rule, From:, Sent:): the subject tells.
  const quotes = forwarded
    ? { lines: original.split("\n"), removed: false }
    : cutQuotes(original.split("\n"));
  const signature = cutSignature(quotes.lines);
  let text = tidy(signature.lines);
  if (text.length === 0 && quotes.removed) {
    // Nothing above the quote (a reply written below it, or an empty reply): keep what is
    // not quoted, or nothing.
    text = tidy(original.split("\n").filter((line) => !/^\s*>/.test(line)));
    if (ON_WROTE.test(text)) text = "";
  }
  const truncated = text.length > MAX_BODY_CHARS;
  if (truncated)
    text = `${text.slice(0, MAX_BODY_CHARS).trimEnd()}\n[…the rest of this email was cut]`;
  return {
    text,
    quoteRemoved: quoteRemoved || quotes.removed,
    signatureRemoved: signature.removed,
    truncated,
  };
}
