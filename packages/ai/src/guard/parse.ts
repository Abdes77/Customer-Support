/**
 * Turns the model's final text into what is to be sent. The model writes the reply as plain
 * text; a few markers (described in the core prompt) control delivery.
 */

export type ParsedReply =
  | { readonly kind: "no_reply" }
  | { readonly kind: "after_hours_message" }
  | {
      readonly kind: "messages";
      readonly messages: string[];
      readonly quickReplies: string[];
      readonly subject: string | null;
    };

const NO_REPLY = /<no_reply\s*\/?>/gi;
const AFTER_HOURS = /<after_hours_message\s*\/?>/gi;
const NEXT_MESSAGE = /<next_message\s*\/?>/i;
const SUBJECT = /^\s*<subject>([\s\S]*?)<\/subject>\s*/i;
const QUICK_REPLIES = /<quick_replies>([\s\S]*?)<\/quick_replies>\s*$/i;
/** Any tag-like run: internal markup must never reach a customer. */
const ANY_TAG = /<\/?[a-z][a-z0-9_]*(?:\s[^<>]*)?\/?>/gi;

export function stripTags(text: string): string {
  return text.replaceAll(ANY_TAG, "");
}

export function parseReply(raw: string): ParsedReply {
  let text = raw.trim();
  if (text.length === 0) return { kind: "no_reply" };

  // A marker counts only when nothing else is left once it is taken out.
  if (text.replaceAll(NO_REPLY, "").trim().length === 0) return { kind: "no_reply" };
  if (text.replaceAll(AFTER_HOURS, "").replaceAll(NO_REPLY, "").trim().length === 0) {
    return { kind: "after_hours_message" };
  }
  text = text.replaceAll(NO_REPLY, "").replaceAll(AFTER_HOURS, "").trim();

  let subject: string | null = null;
  const subjectMatch = SUBJECT.exec(text);
  if (subjectMatch !== null) {
    subject =
      stripTags(subjectMatch[1] ?? "")
        .replaceAll(/\s+/g, " ")
        .trim() || null;
    text = text.slice(subjectMatch[0].length);
  }

  let quickReplies: string[] = [];
  const quickMatch = QUICK_REPLIES.exec(text);
  if (quickMatch !== null) {
    quickReplies = (quickMatch[1] ?? "")
      .split("|")
      .map((option) => stripTags(option).replaceAll(/\s+/g, " ").trim())
      .filter((option) => option.length > 0);
    text = text.slice(0, quickMatch.index);
  }

  const messages = text
    .split(NEXT_MESSAGE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (messages.length === 0) return { kind: "no_reply" };
  return { kind: "messages", messages, quickReplies, subject };
}
