import type { AttachmentKind, InboundAttachment, NormalizedInboundMessage } from "@repo/core";

import type { CleanedBody } from "./body/clean";
import type { ParsedAddress, ParsedAttachment, ParsedEmail } from "./mime/parse";

/** At most this many attachments of one email are kept. */
export const MAX_ATTACHMENTS = 10;
/** Larger files are not kept (a link to the inbox is the way to see them). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Images embedded in the HTML below this size are logos and signature icons. */
export const MIN_EMBEDDED_IMAGE_BYTES = 20 * 1024;

const SKIPPED_TYPES =
  /^(?:application\/(?:pkcs7-signature|x-pkcs7-signature|pgp-signature|pgp-keys|ms-tnef)|message\/(?:delivery-status|disposition-notification|global-delivery-status)|text\/(?:rfc822-headers|x-vcard|vcard))$/;

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

/**
 * The attachments worth keeping: real files and photos, not the logo of a signature, a
 * tracking pixel, a digital signature or a calendar's technical parts.
 */
export function selectAttachments(email: ParsedEmail): ParsedAttachment[] {
  const kept: ParsedAttachment[] = [];
  for (const attachment of email.attachments) {
    if (kept.length >= MAX_ATTACHMENTS) break;
    if (SKIPPED_TYPES.test(attachment.mimeType)) continue;
    if (attachment.bytes.byteLength === 0 || attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      continue;
    const embedded =
      attachment.related || (attachment.disposition === "inline" && attachment.contentId !== null);
    if (
      embedded &&
      attachment.mimeType.startsWith("image/") &&
      attachment.bytes.byteLength < MIN_EMBEDDED_IMAGE_BYTES
    ) {
      continue;
    }
    kept.push(attachment);
  }
  return kept;
}

export interface InboundEmailInput {
  readonly email: ParsedEmail;
  /** The inbox address: the connection's external account id. */
  readonly inboxAddress: string;
  readonly externalMessageId: string;
  readonly threadKey: string | null;
  /** Who the bot answers (`replyAddressOf`). */
  readonly sender: ParsedAddress;
  readonly body: CleanedBody;
  readonly attachments: readonly InboundAttachment[];
  /** When the provider received it; used when the Date header is missing or unreadable. */
  readonly receivedAt: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** The pipeline's inbound message for one customer email. */
export function toInboundMessage(input: InboundEmailInput): NormalizedInboundMessage {
  const { email } = input;
  const text = input.body.text.length > 0 ? input.body.text : null;
  const headerDate = email.date === null ? null : new Date(email.date);
  // A Date header in the future (a wrong clock) never moves the conversation ahead.
  const sentAt =
    headerDate !== null && headerDate.getTime() <= input.receivedAt.getTime()
      ? headerDate
      : input.receivedAt;
  return {
    channel: "email",
    externalAccountId: input.inboxAddress,
    externalMessageId: input.externalMessageId,
    externalThreadId: input.threadKey,
    sender: {
      externalId: input.sender.address,
      displayName: input.sender.name,
      phone: null,
      email: input.sender.address,
    },
    sentAt: sentAt.toISOString(),
    kind: text === null && input.attachments.length > 0 ? "media" : "text",
    text,
    attachments: [...input.attachments],
    location: null,
    interactiveReply: null,
    reaction: null,
    replyToExternalMessageId: email.inReplyTo,
    email: {
      messageIdHeader: input.externalMessageId,
      inReplyTo: email.inReplyTo,
      references: [...email.references],
      subject: email.subject,
      from: { address: input.sender.address, name: input.sender.name },
      to: email.to.map((item) => ({ address: item.address, name: item.name })),
      cc: email.cc.map((item) => ({ address: item.address, name: item.name })),
    },
    metadata: { ...input.metadata },
  };
}
