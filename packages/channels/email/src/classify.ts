import { domainMatches, domainOf, isNoReplyAddress, PUBLIC_MAIL_DOMAINS } from "./addresses";
import { LOOP_HEADER } from "./config";
import { header, type ParsedAddress, type ParsedEmail } from "./mime/parse";
import { messageIdList } from "./thread";

/*
 * Which emails the bot may answer. Everything that is not a person writing to the business
 * is told apart here, from the headers mail systems set for exactly this purpose (RFC 3834
 * for automatic replies, RFC 3464 for delivery reports, RFC 2369/2919 for mailing lists),
 * plus the usual fallbacks (out-of-office subjects, no-reply senders, MAILER-DAEMON).
 */

export type EmailClass =
  /** One of our own sends, coming back (our marker header with this connection's token). */
  | { readonly kind: "own_send" }
  /** Sent by another installation of this system: never answered, or two bots talk forever. */
  | { readonly kind: "loop" }
  /** A delivery report. `failed` when it reports a permanent failure. */
  | {
      readonly kind: "bounce";
      readonly failed: boolean;
      /** Message-IDs the report names: one of them is the message that bounced. */
      readonly candidates: readonly string[];
      /**
       * The recipients the report says failed (Final-Recipient, Original-Recipient,
       * X-Failed-Recipients), lower case. A report marks one of our messages failed only
       * when it names that message's recipient (C17: forged bounces).
       */
      readonly recipients: readonly string[];
      /** The receiving server says the report's sender failed DMARC: it is ignored. */
      readonly spoofed: boolean;
      readonly diagnostic: string | null;
    }
  /** Written by the business itself (the inbox, an internal domain). */
  | { readonly kind: "business"; readonly reason: "inbox" | "internal_domain" | "own_domain" }
  | { readonly kind: "ignored_sender" }
  /** Automatic mail: out-of-office and other auto-replies, newsletters, notifications. */
  | {
      readonly kind: "automatic";
      readonly reason: "auto_reply" | "bulk" | "no_reply_sender" | "read_receipt";
      readonly evidence: string;
    }
  /** A person writing to the business: the bot may answer. */
  | { readonly kind: "customer" };

export interface ClassifyContext {
  /** The inbox address and its aliases, lower case. */
  readonly inboxAddresses: readonly string[];
  /** `channels.email.internal_domains`. */
  readonly internalDomains: readonly string[];
  /** `channels.email.ignored_senders`, lower case. */
  readonly ignoredSenders: readonly string[];
  /** This connection's loop token. */
  readonly loopToken: string;
}

const AUTO_REPLY_SUBJECT =
  /^(?:(?:re|aw)\s*:\s*)?(?:auto(?:matic)?[\s-]*(?:reply|response|antwort)|autoreply|auto:|out of (?:the )?office|ooo\b|away from (?:the )?office|on vacation|vacation reply|abwesenheit|automatische antwort|réponse automatique|respuesta automática|risposta automatica|i am (?:currently )?out of the office)/i;
const BOUNCE_SUBJECT =
  /(?:undeliver(?:able|ed)|delivery (?:status notification|has failed|failure|failed|incomplete)|returned mail|mail delivery (?:failed|subsystem)|failure notice|could not be delivered|message not delivered|non[- ]?delivery|delivery notification)/i;

function decode(bytes: Uint8Array, max = 256 * 1024): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, max));
}

/** The Message-IDs a delivery report names, from its attached original and its text. */
function bounceCandidates(email: ParsedEmail): string[] {
  const ids: string[] = [];
  const add = (list: readonly string[]) => {
    for (const id of list) if (!ids.includes(id)) ids.push(id);
  };
  for (const attachment of email.attachments) {
    if (
      !/^(?:message\/rfc822|text\/rfc822-headers|message\/rfc822-headers|message\/global(?:-headers)?)$/.test(
        attachment.mimeType,
      )
    ) {
      continue;
    }
    const text = decode(attachment.bytes);
    // The header block of the original, unfolded.
    const head = (text.split(/\r?\n\r?\n/)[0] ?? "").replace(/\r?\n[ \t]+/g, " ");
    const match = /^message-id\s*:\s*(.+)$/im.exec(head);
    if (match?.[1] !== undefined) add(messageIdList(match[1]));
  }
  const body = `${email.text ?? ""}\n${email.html ?? ""}`;
  for (const match of body.matchAll(/message-id\s*:\s*(<[^<>\s]+>)/gi))
    add(messageIdList(match[1]));
  if (email.inReplyTo !== null) add([email.inReplyTo]);
  add(email.references);
  return ids;
}

/** `failed` unless every action the report lists is delayed, delivered, relayed or expanded. */
function bounceOutcome(email: ParsedEmail): { failed: boolean; diagnostic: string | null } {
  const report = email.attachments.find((item) =>
    /^message\/(?:global-)?delivery-status$/.test(item.mimeType),
  );
  if (report === undefined) return { failed: true, diagnostic: null };
  const text = decode(report.bytes, 64 * 1024);
  const actions = [...text.matchAll(/^action\s*:\s*([a-z]+)/gim)].map((match) =>
    match[1]!.toLowerCase(),
  );
  const status = /^status\s*:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(text)?.[1] ?? null;
  const diagnostic = /^diagnostic-code\s*:\s*(.{1,300})$/im.exec(text)?.[1]?.trim() ?? null;
  const failed =
    actions.length === 0 ? status === null || status.startsWith("5") : actions.includes("failed");
  return { failed, diagnostic: diagnostic ?? status };
}

const ADDRESS = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

/** The recipients a delivery report says failed, lower case. */
export function failedRecipients(email: ParsedEmail): string[] {
  const found = new Set<string>();
  const add = (text: string) => {
    for (const match of text.matchAll(ADDRESS)) found.add(match[0].toLowerCase());
  };
  const report = email.attachments.find((item) =>
    /^message\/(?:global-)?delivery-status$/.test(item.mimeType),
  );
  if (report !== undefined) {
    const text = decode(report.bytes, 64 * 1024);
    for (const match of text.matchAll(/^(?:final|original)-recipient\s*:\s*[^;\n]*;\s*(.+)$/gim)) {
      add(match[1] ?? "");
    }
  }
  for (const value of email.headers.get("x-failed-recipients") ?? []) add(value);
  return [...found];
}

/**
 * Whether the receiving mail server says the message failed DMARC: the topmost
 * Authentication-Results header (the one our provider added on receipt; anything below it
 * was written by whoever sent the message) reports `dmarc=fail`. Only ever used to trust a
 * message less: a sender can add an Authentication-Results header of its own, but only
 * below the receiver's, and a forged `dmarc=pass` is never believed (C17: reflection and
 * forged bounces).
 */
export function failedDmarc(email: ParsedEmail): boolean {
  const topmost = email.headers.get("authentication-results")?.[0];
  return topmost !== undefined && /\bdmarc\s*=\s*fail\b/i.test(topmost);
}

function isBounce(email: ParsedEmail): boolean {
  if (email.reportType === "delivery-status") return true;
  if (header(email, "x-failed-recipients") !== null) return true;
  const from = email.from?.address ?? "";
  const local = from.slice(0, from.indexOf("@")).toLowerCase();
  const daemon = local === "mailer-daemon" || local === "postmaster" || local === "mail-daemon";
  const emptyReturnPath = /^<\s*>$/.test(header(email, "return-path") ?? "");
  return (daemon || emptyReturnPath) && BOUNCE_SUBJECT.test(email.subject);
}

function automaticReason(email: ParsedEmail): Extract<EmailClass, { kind: "automatic" }> | null {
  if (email.reportType === "disposition-notification") {
    return { kind: "automatic", reason: "read_receipt", evidence: "disposition-notification" };
  }
  const autoSubmitted = header(email, "auto-submitted");
  if (autoSubmitted !== null && autoSubmitted.toLowerCase() !== "no") {
    return {
      kind: "automatic",
      reason: "auto_reply",
      evidence: `auto-submitted: ${autoSubmitted.slice(0, 40)}`,
    };
  }
  for (const name of [
    "x-autoreply",
    "x-autorespond",
    "x-autoresponder",
    "x-auto-response-suppress",
  ]) {
    if (header(email, name) !== null) {
      return { kind: "automatic", reason: "auto_reply", evidence: name };
    }
  }
  const precedence = (
    header(email, "precedence") ??
    header(email, "x-precedence") ??
    ""
  ).toLowerCase();
  if (precedence === "auto_reply") {
    return { kind: "automatic", reason: "auto_reply", evidence: "precedence: auto_reply" };
  }
  if (AUTO_REPLY_SUBJECT.test(email.subject)) {
    return { kind: "automatic", reason: "auto_reply", evidence: "subject" };
  }
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { kind: "automatic", reason: "bulk", evidence: `precedence: ${precedence}` };
  }
  for (const name of [
    "list-id",
    "list-unsubscribe",
    "list-post",
    "feedback-id",
    "x-campaign",
    "x-mailchimp-campaign-id",
  ]) {
    if (header(email, name) !== null) {
      return { kind: "automatic", reason: "bulk", evidence: name };
    }
  }
  return null;
}

/**
 * Who the bot would answer: the Reply-To when the message names one (contact forms send
 * from a no-reply address with the visitor in Reply-To), otherwise the sender.
 */
export function replyAddressOf(email: ParsedEmail): ParsedAddress | null {
  const replyTo = email.replyTo[0];
  if (replyTo !== undefined) {
    const fromNoReply = email.from === null || isNoReplyAddress(email.from.address);
    return {
      address: replyTo.address,
      name: replyTo.name ?? (fromNoReply ? null : (email.from?.name ?? null)),
    };
  }
  return email.from;
}

/** True when `address` belongs to the business (its inbox, an internal domain). */
export function businessAddressReason(
  address: string,
  context: Pick<ClassifyContext, "inboxAddresses" | "internalDomains">,
): Extract<EmailClass, { kind: "business" }>["reason"] | null {
  const lower = address.toLowerCase();
  if (context.inboxAddresses.includes(lower)) return "inbox";
  const domain = domainOf(lower);
  if (domain === null) return null;
  if (domainMatches(domain, context.internalDomains)) return "internal_domain";
  const own = context.inboxAddresses
    .map((item) => domainOf(item))
    .filter((item): item is string => item !== null && !PUBLIC_MAIL_DOMAINS.has(item));
  if (own.includes(domain)) return "own_domain";
  return null;
}

export function classifyEmail(email: ParsedEmail, context: ClassifyContext): EmailClass {
  const marker = header(email, LOOP_HEADER);
  if (marker !== null)
    return marker === context.loopToken ? { kind: "own_send" } : { kind: "loop" };

  if (isBounce(email)) {
    const outcome = bounceOutcome(email);
    return {
      kind: "bounce",
      candidates: bounceCandidates(email),
      recipients: failedRecipients(email),
      spoofed: failedDmarc(email),
      ...outcome,
    };
  }

  const from = email.from?.address ?? null;
  if (from !== null) {
    const reason = businessAddressReason(from, context);
    if (reason !== null) return { kind: "business", reason };
  }

  const reply = replyAddressOf(email);
  const ignored = new Set(context.ignoredSenders.map((item) => item.toLowerCase()));
  if ((from !== null && ignored.has(from)) || (reply !== null && ignored.has(reply.address))) {
    return { kind: "ignored_sender" };
  }

  const automatic = automaticReason(email);
  if (automatic !== null) return automatic;

  if (reply === null || isNoReplyAddress(reply.address)) {
    return { kind: "automatic", reason: "no_reply_sender", evidence: "sender" };
  }
  // A reply address that is the business's own (a form that puts the inbox in Reply-To).
  if (businessAddressReason(reply.address, context) !== null) {
    return { kind: "automatic", reason: "no_reply_sender", evidence: "reply-to is the business" };
  }
  return { kind: "customer" };
}
