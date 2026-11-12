import { createHash } from "node:crypto";

/*
 * Threading (RFC 5322 §3.6.4). Every message has a Message-ID; a reply names its parent in
 * In-Reply-To and the whole chain, oldest first, in References. We keep ids in their
 * canonical form `<local@domain>`, compare them exactly, and use them as the provider message
 * id of email messages, so a reply's In-Reply-To finds what it answers in our own tables.
 */

const ID = /<([^<>\s]{1,900})>/g;

/** `<id>` as stored and compared: angle brackets, no whitespace, at most 998 characters. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const bracketed = /^<([^<>\s]+)>$/.exec(trimmed);
  if (bracketed !== null) return `<${bracketed[1]}>`;
  // Some mailers leave out the brackets.
  if (/^[^<>\s]+@[^<>\s]+$/.test(trimmed)) return `<${trimmed}>`;
  const first = /<([^<>\s]+)>/.exec(trimmed);
  return first === null ? null : `<${first[1]}>`;
}

/** Every `<id>` in a header value (References, In-Reply-To), in order, without duplicates. */
export function messageIdList(value: string | null | undefined): string[] {
  if (value == null) return [];
  const ids: string[] = [];
  for (const match of value.matchAll(ID)) {
    const id = `<${match[1]}>`;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    const single = normalizeMessageId(value);
    if (single !== null) ids.push(single);
  }
  return ids;
}

/**
 * The References of a reply to a message: its References (or, without them, its
 * In-Reply-To) followed by its own id (RFC 5322 §3.6.4). Long chains keep the first id and
 * the most recent ones, as mail programs do, so the header stays a sensible size.
 */
export function replyReferences(
  parent: {
    readonly messageId: string | null;
    readonly references: readonly string[];
    readonly inReplyTo: string | null;
  },
  max = 20,
): string[] {
  const chain = [
    ...(parent.references.length > 0
      ? parent.references
      : parent.inReplyTo === null
        ? []
        : [parent.inReplyTo]),
  ];
  if (parent.messageId !== null && !chain.includes(parent.messageId)) chain.push(parent.messageId);
  if (chain.length <= max) return chain;
  return [chain[0]!, ...chain.slice(chain.length - (max - 1))];
}

/** "Re: " in front of a subject, once. */
export function replySubject(subject: string | null | undefined): string {
  const text = (subject ?? "").replace(/[\r\n]+/g, " ").trim();
  if (text.length === 0) return "Re: Your message";
  return /^(re|aw|sv|antw)\s*:/i.test(text) ? text : `Re: ${text}`;
}

/** The subject without reply and forward prefixes, for comparisons and display. */
export function baseSubject(subject: string | null | undefined): string {
  let text = (subject ?? "").trim();
  for (;;) {
    const next = text.replace(/^(?:re|fw|fwd|aw|sv|antw|wg)\s*(?:\[\d+\])?\s*:\s*/i, "");
    if (next === text) return text;
    text = next;
  }
}

/**
 * The Message-ID of a message we send: derived from the connection and the outbound
 * message's idempotency key, so a retried send carries the same id (mail systems that see it
 * twice can drop the copy) and a bounce or a reply names it.
 */
export function outboundMessageId(input: {
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly domain: string;
}): string {
  const hash = createHash("sha256")
    .update(`${input.connectionId}\u0000${input.idempotencyKey}`)
    .digest("hex");
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
  return `<${uuid}@${input.domain}>`;
}

/**
 * The thread key of a message that starts a conversation, when nothing we stored tells us
 * its thread: the provider's thread (Gmail thread, Outlook conversation) when there is one,
 * else the root of its References, else its own id. The server half first looks for a
 * stored message that the message answers (its In-Reply-To and References) and keeps that
 * message's thread.
 */
export function threadKeyOf(input: {
  readonly providerThreadId: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
}): string | null {
  if (input.providerThreadId !== null && input.providerThreadId.length > 0) {
    return input.providerThreadId;
  }
  const root = input.references[0] ?? input.inReplyTo ?? input.messageId;
  return root === null ? null : `mid:${root}`;
}
