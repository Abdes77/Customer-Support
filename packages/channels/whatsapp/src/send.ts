import type { AttachmentKind, OutboundMessage } from "@repo/core";

/*
 * Request bodies of `POST /{phone-number-id}/messages`, as documented (read 2026-11-12):
 * text, interactive reply buttons and lists, media by uploaded id, templates, read receipts
 * with the typing indicator. Pure functions, so every shape is tested without a network.
 */

/** Reply buttons: at most 3, titles up to 20 characters and unique, body up to 1,024. */
export const BUTTON_LIMITS = { maxButtons: 3, maxTitle: 20, maxBody: 1024 } as const;
/** Lists: at most 10 rows, row titles 24, descriptions 72, body 4,096, button text 20. */
export const LIST_LIMITS = {
  maxRows: 10,
  maxTitle: 24,
  maxDescription: 72,
  maxBody: 4096,
} as const;
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;

/** Upload limits per kind (bytes): images 5 MB, audio and video 16 MB, documents 100 MB. */
export const MEDIA_LIMITS: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};

const MEDIA_TYPE: Record<AttachmentKind, "image" | "audio" | "video" | "document"> = {
  image: "image",
  audio: "audio",
  video: "video",
  file: "document",
};

export type Recipient = { readonly to: string } | { readonly recipient: string };

/**
 * A phone number goes in `to` (with its plus sign, so no country code is prepended); any
 * other identity is a business-scoped user id (BSUID) and goes in `recipient`.
 */
export function recipientOf(externalId: string): Recipient {
  const digits = externalId.replace(/[\s()+-]/g, "");
  return /^\d{7,15}$/.test(digits) ? { to: `+${digits}` } : { recipient: externalId };
}

function envelope(recipient: Recipient, replyTo: string | null): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipient,
    ...(replyTo === null ? {} : { context: { message_id: replyTo } }),
  };
}

function shorten(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

const length = (text: string) => [...text].length;

/** Quick replies as plain text under the message, for when no interactive shape fits. */
export function appendOptions(text: string, options: readonly string[]): string {
  return `${text}\n\n${options.map((option) => `• ${option}`).join("\n")}`;
}

export function textBody(
  message: Extract<OutboundMessage, { kind: "text" }>,
  recipient: Recipient,
  replyTo: string | null,
): Record<string, unknown> {
  const options = (message.quickReplies ?? [])
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  const body = message.text;
  const unique = new Set(options).size === options.length;

  if (
    options.length > 0 &&
    options.length <= BUTTON_LIMITS.maxButtons &&
    unique &&
    options.every((option) => length(option) <= BUTTON_LIMITS.maxTitle) &&
    length(body) <= BUTTON_LIMITS.maxBody
  ) {
    return {
      ...envelope(recipient, replyTo),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: options.map((title, index) => ({
            type: "reply",
            reply: { id: `qr_${index + 1}`, title },
          })),
        },
      },
    };
  }

  if (
    options.length > 0 &&
    options.length <= LIST_LIMITS.maxRows &&
    options.every((option) => length(option) <= LIST_LIMITS.maxDescription) &&
    length(body) <= LIST_LIMITS.maxBody
  ) {
    return {
      ...envelope(recipient, replyTo),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Options",
              rows: options.map((option, index) => {
                const fits = length(option) <= LIST_LIMITS.maxTitle;
                return {
                  id: `qr_${index + 1}`,
                  title: fits ? option : shorten(option, LIST_LIMITS.maxTitle),
                  ...(fits ? {} : { description: option }),
                };
              }),
            },
          ],
        },
      },
    };
  }

  const text = options.length > 0 ? appendOptions(body, options) : body;
  return {
    ...envelope(recipient, replyTo),
    type: "text",
    // Links in a bot reply never unfold into a preview card.
    text: { body: shorten(text, MAX_TEXT_LENGTH), preview_url: false },
  };
}

export function mediaBody(
  kind: AttachmentKind,
  mediaId: string,
  caption: string | null,
  fileName: string | null,
  recipient: Recipient,
  replyTo: string | null,
): Record<string, unknown> {
  const type = MEDIA_TYPE[kind];
  const object: Record<string, unknown> = { id: mediaId };
  // Audio takes no caption.
  if (caption !== null && caption.length > 0 && type !== "audio") {
    object["caption"] = shorten(caption, MAX_CAPTION_LENGTH);
  }
  if (type === "document" && fileName !== null) object["filename"] = fileName;
  return { ...envelope(recipient, replyTo), type, [type]: object };
}

export function templateBody(
  message: Extract<OutboundMessage, { kind: "template" }>,
  recipient: Recipient,
): Record<string, unknown> {
  const named = message.namedVariables;
  const parameters =
    named !== undefined && Object.keys(named).length > 0
      ? Object.entries(named).map(([name, text]) => ({
          type: "text",
          parameter_name: name,
          text,
        }))
      : message.variables.map((text) => ({ type: "text", text }));
  return {
    ...envelope(recipient, null),
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.languageCode },
      ...(parameters.length === 0 ? {} : { components: [{ type: "body", parameters }] }),
    },
  };
}

/** Marks a customer message read; with `typing`, also shows the typing indicator (25 s at most). */
export function readBody(messageId: string, typing: boolean): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    ...(typing ? { typing_indicator: { type: "text" } } : {}),
  };
}
