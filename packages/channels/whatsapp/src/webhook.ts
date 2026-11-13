import { z } from "zod";

import {
  type AttachmentKind,
  type ChannelSignal,
  type DeliveryStatusUpdate,
  type NormalizedInboundMessage,
  type ParsedWebhook,
  ValidationError,
} from "@repo/core";

/*
 * The WhatsApp Cloud API webhook, as documented at
 * developers.facebook.com/documentation/business-messaging/whatsapp/webhooks (read 2026-11-12):
 *
 *   { object: "whatsapp_business_account",
 *     entry: [{ id: <WABA id>, changes: [{ field: "messages", value: {
 *       messaging_product: "whatsapp",
 *       metadata: { display_phone_number, phone_number_id },
 *       contacts: [{ profile: { name, username? }, wa_id?, user_id? }],
 *       messages: [{ from?, from_user_id?, id, timestamp, type, context?, referral?, <type>: {...} }],
 *       statuses: [{ id, status, timestamp, recipient_id?, recipient_user_id?, errors? }] } }] }] }
 *
 * Users are identified by their business-scoped user id (BSUID, `from_user_id`); `from` (the
 * phone number) is left out for users who adopted a username and hide their number. The
 * schemas are deliberately lenient (unknown fields pass, most fields optional): Meta adds
 * fields without notice, and a webhook we cannot fully read must still store what it can.
 */

const Str = z.string();
const OptStr = z.string().optional();

const MediaObject = z
  .object({
    id: Str.min(1),
    mime_type: OptStr,
    sha256: OptStr,
    caption: OptStr,
    filename: OptStr,
    url: OptStr,
    voice: z.boolean().optional(),
    animated: z.boolean().optional(),
  })
  .passthrough();

const ErrorObject = z
  .object({
    code: z.number().optional(),
    title: OptStr,
    message: OptStr,
    error_data: z.object({ details: OptStr }).passthrough().optional(),
  })
  .passthrough();

const ContactCard = z
  .object({
    name: z.object({ formatted_name: OptStr, first_name: OptStr }).passthrough().optional(),
    phones: z.array(z.object({ phone: OptStr, wa_id: OptStr }).passthrough()).optional(),
  })
  .passthrough();

export const WhatsAppMessage = z
  .object({
    from: OptStr,
    from_user_id: OptStr,
    id: Str.min(1),
    timestamp: Str,
    type: Str,
    context: z
      .object({
        from: OptStr,
        id: OptStr,
        forwarded: z.boolean().optional(),
        frequently_forwarded: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    referral: z.record(z.string(), z.unknown()).optional(),
    text: z.object({ body: Str }).passthrough().optional(),
    image: MediaObject.optional(),
    video: MediaObject.optional(),
    audio: MediaObject.optional(),
    document: MediaObject.optional(),
    sticker: MediaObject.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: OptStr,
        address: OptStr,
        url: OptStr,
      })
      .passthrough()
      .optional(),
    interactive: z
      .object({
        type: Str,
        button_reply: z.object({ id: Str, title: Str }).passthrough().optional(),
        list_reply: z.object({ id: Str, title: Str, description: OptStr }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    button: z.object({ payload: OptStr, text: OptStr }).passthrough().optional(),
    reaction: z.object({ message_id: Str, emoji: OptStr }).passthrough().optional(),
    contacts: z.array(ContactCard).optional(),
    errors: z.array(ErrorObject).optional(),
  })
  .passthrough();
export type WhatsAppMessage = z.infer<typeof WhatsAppMessage>;

const WhatsAppStatus = z
  .object({
    id: Str.min(1),
    status: Str,
    timestamp: Str,
    recipient_id: OptStr,
    recipient_user_id: OptStr,
    errors: z.array(ErrorObject).optional(),
  })
  .passthrough();

const Echo = z
  .object({
    from: OptStr,
    to: OptStr,
    to_user_id: OptStr,
    id: Str.min(1),
    timestamp: Str,
    type: OptStr,
    text: z.object({ body: Str }).passthrough().optional(),
  })
  .passthrough();

const ContactProfile = z
  .object({
    profile: z.object({ name: OptStr, username: OptStr }).passthrough().optional(),
    wa_id: OptStr,
    user_id: OptStr,
  })
  .passthrough();

const MessagesValue = z
  .object({
    metadata: z.object({ phone_number_id: Str.min(1), display_phone_number: OptStr }).passthrough(),
    contacts: z.array(ContactProfile).optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
    message_echoes: z.array(z.unknown()).optional(),
    errors: z.array(ErrorObject).optional(),
  })
  .passthrough();

const TemplateStatusValue = z
  .object({
    event: Str,
    message_template_id: z.union([z.number(), z.string()]),
    message_template_name: Str,
    message_template_language: Str,
    message_template_category: OptStr,
    reason: z.string().nullable().optional(),
  })
  .passthrough();

const AccountUpdateValue = z
  .object({
    event: Str,
    phone_number: OptStr,
    // DISABLED_UPDATE: DISABLE, SCHEDULE_FOR_DISABLE or REINSTATE.
    ban_info: z.object({ waba_ban_state: OptStr }).passthrough().optional(),
  })
  .passthrough();

const QualityValue = z
  .object({ event: Str, display_phone_number: OptStr, current_limit: OptStr })
  .passthrough();

const Envelope = z.object({
  object: Str,
  entry: z.array(
    z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        time: z.number().optional(),
        changes: z.array(z.object({ field: Str, value: z.unknown() }).passthrough()).default([]),
      })
      .passthrough(),
  ),
});

/** Seconds since the epoch as an ISO date; a bad value becomes the receiving time. */
function isoFromSeconds(value: string | number | undefined, fallback: Date): string {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback.toISOString();
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/** "16505551234" → "+16505551234"; anything that is not a phone number → null. */
export function e164(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const digits = raw.replace(/[\s()+-]/g, "");
  return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
}

/** Template languages arrive as "en-US" in webhooks and "en_US" in the API. */
export function normalizeLanguage(code: string): string {
  return code.replace("-", "_");
}

const MEDIA_KINDS: Record<string, AttachmentKind> = {
  image: "image",
  sticker: "image",
  video: "video",
  audio: "audio",
  document: "file",
};

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function contactCardText(cards: z.infer<typeof ContactCard>[]): string {
  const lines = cards.slice(0, 5).map((card) => {
    const name = card.name?.formatted_name ?? card.name?.first_name ?? "Contact";
    const phones = (card.phones ?? [])
      .map((phone) => phone.phone)
      .filter((phone): phone is string => typeof phone === "string" && phone.length > 0)
      .slice(0, 3);
    return phones.length > 0 ? `${name}: ${phones.join(", ")}` : name;
  });
  return `Shared ${cards.length === 1 ? "a contact" : "contacts"}: ${lines.join("; ")}`.slice(
    0,
    1000,
  );
}

function referralOf(
  referral: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (referral === undefined) return undefined;
  const keep = [
    "source_url",
    "source_id",
    "source_type",
    "headline",
    "body",
    "media_type",
    "ctwa_clid",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of keep) {
    const value = referral[key];
    if (typeof value === "string") picked[key] = value.slice(0, 500);
  }
  return picked;
}

/**
 * One customer message → the normalized shape. Returns null for what is not a customer
 * message (a `system` notice) or carries no sender.
 */
export function normalizeMessage(
  raw: WhatsAppMessage,
  phoneNumberId: string,
  contacts: readonly z.infer<typeof ContactProfile>[],
  now: Date,
): NormalizedInboundMessage | null {
  const senderId = raw.from_user_id ?? raw.from;
  if (senderId === undefined || senderId.length === 0 || raw.type === "system") return null;
  const profile =
    contacts.find(
      (contact) =>
        (raw.from_user_id !== undefined && contact.user_id === raw.from_user_id) ||
        (raw.from !== undefined && contact.wa_id === raw.from),
    ) ?? (contacts.length === 1 ? contacts[0] : undefined);
  const forwarded = raw.context?.forwarded === true || raw.context?.frequently_forwarded === true;

  const base: NormalizedInboundMessage = {
    channel: "whatsapp",
    externalAccountId: phoneNumberId,
    externalMessageId: raw.id,
    externalThreadId: null,
    sender: {
      externalId: senderId,
      displayName: profile?.profile?.name ?? null,
      phone: e164(raw.from ?? profile?.wa_id),
      email: null,
    },
    sentAt: isoFromSeconds(raw.timestamp, now),
    kind: "text",
    text: null,
    attachments: [],
    location: null,
    interactiveReply: null,
    reaction: null,
    // A forwarded message also has a context, without the id of one of our messages.
    replyToExternalMessageId: raw.context?.id ?? null,
    email: null,
    metadata: compact({
      type: raw.type,
      forwarded: forwarded ? true : undefined,
      frequentlyForwarded: raw.context?.frequently_forwarded === true ? true : undefined,
      referral: referralOf(raw.referral),
      username: profile?.profile?.username,
      errorCode: raw.errors?.[0]?.code,
    }),
  };

  const mediaKind = MEDIA_KINDS[raw.type];
  if (mediaKind !== undefined) {
    const media = raw[raw.type as "image" | "video" | "audio" | "document" | "sticker"];
    if (media === undefined) return { ...base, kind: "unsupported" };
    return {
      ...base,
      kind: "media",
      text: media.caption !== undefined && media.caption.length > 0 ? media.caption : null,
      attachments: [
        {
          kind: mediaKind,
          mimeType: media.mime_type?.split(";")[0]?.trim() ?? null,
          fileName: media.filename ?? null,
          sizeBytes: null,
          source: { type: "provider_media", mediaId: media.id },
        },
      ],
      metadata: compact({
        ...base.metadata,
        voice: raw.type === "audio" && media.voice === true ? true : undefined,
        sticker: raw.type === "sticker" ? true : undefined,
      }),
    };
  }

  switch (raw.type) {
    case "text":
      return { ...base, kind: "text", text: raw.text?.body ?? null };
    case "location": {
      const location = raw.location;
      if (location === undefined) return { ...base, kind: "unsupported" };
      const latitude = Math.max(-90, Math.min(90, location.latitude));
      const longitude = Math.max(-180, Math.min(180, location.longitude));
      return {
        ...base,
        kind: "location",
        location: {
          latitude,
          longitude,
          name: location.name ?? null,
          address: location.address ?? null,
        },
      };
    }
    case "interactive": {
      const choice = raw.interactive?.button_reply ?? raw.interactive?.list_reply;
      if (choice === undefined) return { ...base, kind: "unsupported" };
      return {
        ...base,
        kind: "interactive_reply",
        text: choice.title,
        interactiveReply: { id: choice.id, title: choice.title },
      };
    }
    case "button": {
      // A quick-reply button of a template: `payload` is what we set, `text` what they saw.
      const title = raw.button?.text ?? raw.button?.payload ?? "";
      return {
        ...base,
        kind: "interactive_reply",
        text: title.length > 0 ? title : null,
        interactiveReply: { id: raw.button?.payload ?? title, title },
      };
    }
    case "reaction": {
      if (raw.reaction === undefined) return { ...base, kind: "unsupported" };
      const emoji = raw.reaction.emoji ?? "";
      return {
        ...base,
        kind: "reaction",
        reaction: {
          targetExternalMessageId: raw.reaction.message_id,
          emoji: emoji.length > 0 ? emoji : null,
          removed: emoji.length === 0,
        },
      };
    }
    case "contacts":
      return {
        ...base,
        kind: "text",
        text:
          raw.contacts !== undefined && raw.contacts.length > 0
            ? contactCardText(raw.contacts)
            : null,
      };
    default:
      // "unsupported", "order", "unknown" and anything Meta adds later: stored and shown,
      // and the bot can ask the customer to describe it in words.
      return { ...base, kind: "unsupported" };
  }
}

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/**
 * Parses a verified webhook body. Throws a `ValidationError` for a body that is not a
 * WhatsApp webhook at all (400); entries it cannot read are skipped, never guessed.
 */
export function parseWhatsAppWebhook(rawBody: string, now: Date): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ValidationError("The webhook body is not JSON.");
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) throw new ValidationError("The webhook body is not a WhatsApp webhook.");
  const result: {
    messages: NormalizedInboundMessage[];
    statuses: DeliveryStatusUpdate[];
    signals: ChannelSignal[];
  } = { messages: [], statuses: [], signals: [] };
  if (envelope.data.object !== "whatsapp_business_account") return result;

  for (const entry of envelope.data.entry) {
    const occurredAt = isoFromSeconds(entry.time, now);
    for (const change of entry.changes) {
      switch (change.field) {
        case "messages":
        case "smb_message_echoes": {
          const value = MessagesValue.safeParse(change.value);
          if (!value.success) continue;
          const phoneNumberId = value.data.metadata.phone_number_id;
          const contacts = value.data.contacts ?? [];
          for (const item of value.data.messages ?? []) {
            const message = WhatsAppMessage.safeParse(item);
            if (!message.success) continue;
            const normalized = normalizeMessage(message.data, phoneNumberId, contacts, now);
            if (normalized !== null) result.messages.push(normalized);
          }
          for (const item of value.data.statuses ?? []) {
            const status = WhatsAppStatus.safeParse(item);
            if (!status.success || !STATUSES.has(status.data.status)) continue;
            const error = status.data.errors?.[0];
            result.statuses.push({
              channel: "whatsapp",
              externalAccountId: phoneNumberId,
              externalMessageId: status.data.id,
              status: status.data.status as DeliveryStatusUpdate["status"],
              occurredAt: isoFromSeconds(status.data.timestamp, now),
              error:
                status.data.status === "failed"
                  ? {
                      code: error?.code === undefined ? "provider_failed" : `meta_${error.code}`,
                      message: (
                        error?.error_data?.details ??
                        error?.message ??
                        error?.title ??
                        "The message could not be delivered."
                      ).slice(0, 500),
                    }
                  : null,
            });
          }
          // Coexistence: a person at the business answered from the WhatsApp Business app.
          for (const item of value.data.message_echoes ?? []) {
            const echo = Echo.safeParse(item);
            if (!echo.success) continue;
            const contact = echo.data.to_user_id ?? echo.data.to;
            if (contact === undefined || contact.length === 0) continue;
            result.signals.push({
              type: "human_agent_replied",
              channel: "whatsapp",
              externalAccountId: phoneNumberId,
              contactExternalId: contact,
              externalMessageId: echo.data.id,
              text: echo.data.text?.body ?? null,
              occurredAt: isoFromSeconds(echo.data.timestamp, now),
            });
          }
          break;
        }
        case "message_template_status_update": {
          const value = TemplateStatusValue.safeParse(change.value);
          if (!value.success) continue;
          result.signals.push({
            type: "provider_event",
            channel: "whatsapp",
            externalAccountId: entry.id,
            event: "template_status",
            data: compact({
              templateId: String(value.data.message_template_id),
              name: value.data.message_template_name,
              language: normalizeLanguage(value.data.message_template_language),
              status: value.data.event,
              reason: value.data.reason ?? undefined,
              category: value.data.message_template_category,
            }),
            occurredAt,
          });
          break;
        }
        case "account_update": {
          const value = AccountUpdateValue.safeParse(change.value);
          if (!value.success) continue;
          result.signals.push({
            type: "provider_event",
            channel: "whatsapp",
            externalAccountId: entry.id,
            event: "account_update",
            data: compact({
              event: value.data.event,
              phoneNumber: value.data.phone_number,
              banState: value.data.ban_info?.waba_ban_state,
            }),
            occurredAt,
          });
          break;
        }
        case "phone_number_quality_update": {
          const value = QualityValue.safeParse(change.value);
          if (!value.success) continue;
          result.signals.push({
            type: "provider_event",
            channel: "whatsapp",
            externalAccountId: entry.id,
            event: "phone_quality",
            data: compact({
              event: value.data.event,
              displayPhoneNumber: value.data.display_phone_number,
              currentLimit: value.data.current_limit,
            }),
            occurredAt,
          });
          break;
        }
        default:
          break;
      }
    }
  }
  return result;
}
