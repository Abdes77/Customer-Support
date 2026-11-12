import type { AttachmentKind, OutboundMessage } from "@repo/core";

import type { MetaMessagingChannel } from "./webhook";

/*
 * Request bodies of the Send API, `POST /{page-id}/messages` (Messenger, and Instagram
 * accounts linked to a Page), as documented (read 2026-11-12): text with optional quick
 * replies, an attachment sent by its uploaded id, sender actions, and the messaging type —
 * `RESPONSE` inside the standard window, `MESSAGE_TAG` with `HUMAN_AGENT` for a person's
 * reply after it (up to seven days). Pure functions, tested without a network.
 */

/** At most 13 quick replies, titles up to 20 characters (both platforms). */
export const QUICK_REPLY_LIMITS = { maxOptions: 13, maxTitle: 20 } as const;

/** Messenger: 2,000 characters. Instagram: 1,000 bytes of UTF-8. */
export const TEXT_LIMITS: Record<MetaMessagingChannel, { chars: number; bytes: number | null }> = {
  messenger: { chars: 2000, bytes: null },
  instagram: { chars: 1000, bytes: 1000 },
};

/** Upload limits in bytes (Instagram's table; Messenger accepts 25 MB for every kind). */
export const MEDIA_LIMITS: Record<AttachmentKind, number> = {
  image: 8 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
};

export type MessagingType =
  | { readonly messaging_type: "RESPONSE" }
  | { readonly messaging_type: "MESSAGE_TAG"; readonly tag: "HUMAN_AGENT" };

export const RESPONSE: MessagingType = { messaging_type: "RESPONSE" };
export const HUMAN_AGENT_TAG: MessagingType = { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" };

const length = (text: string) => [...text].length;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Quick replies as plain lines under the text, for when they cannot be buttons. */
export function appendOptions(text: string, options: readonly string[]): string {
  return `${text}\n\n${options.map((option) => `• ${option}`).join("\n")}`;
}

/**
 * Cuts text to the platform's limit (characters, and bytes on Instagram), ending with an
 * ellipsis. The pipeline already splits at `maxTextLength`; this only guards the rare text
 * whose characters take more than one byte each.
 */
export function fitText(text: string, channel: MetaMessagingChannel): string {
  const limit = TEXT_LIMITS[channel];
  let chars = [...text];
  if (chars.length > limit.chars) chars = [...chars.slice(0, limit.chars - 1), "…"];
  if (limit.bytes !== null) {
    while (chars.length > 1 && bytes(chars.join("")) > limit.bytes) {
      chars = [...chars.slice(0, chars.length - 2), "…"];
    }
  }
  return chars.join("");
}

function envelope(
  recipientId: string,
  type: MessagingType,
): { recipient: { id: string } } & MessagingType {
  return { recipient: { id: recipientId }, ...type };
}

export function textBody(
  channel: MetaMessagingChannel,
  message: Extract<OutboundMessage, { kind: "text" }>,
  recipientId: string,
  type: MessagingType,
  metadata: string,
): Record<string, unknown> {
  const options = (message.quickReplies ?? [])
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  const fits =
    options.length > 0 &&
    options.length <= QUICK_REPLY_LIMITS.maxOptions &&
    new Set(options).size === options.length &&
    options.every((option) => length(option) <= QUICK_REPLY_LIMITS.maxTitle);
  const text = fitText(
    options.length > 0 && !fits ? appendOptions(message.text, options) : message.text,
    channel,
  );
  return {
    ...envelope(recipientId, type),
    message: {
      text,
      ...(fits
        ? {
            quick_replies: options.map((title, index) => ({
              content_type: "text",
              title,
              payload: `qr_${index + 1}`,
            })),
          }
        : {}),
      metadata,
    },
  };
}

/** An uploaded attachment, sent by its id. */
export function attachmentBody(
  kind: AttachmentKind,
  attachmentId: string,
  recipientId: string,
  type: MessagingType,
  metadata: string,
): Record<string, unknown> {
  return {
    ...envelope(recipientId, type),
    message: {
      attachment: { type: kind, payload: { attachment_id: attachmentId } },
      metadata,
    },
  };
}

export function senderActionBody(
  recipientId: string,
  action: "typing_on" | "typing_off" | "mark_seen",
): Record<string, unknown> {
  return { recipient: { id: recipientId }, sender_action: action };
}
