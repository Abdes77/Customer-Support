import type { WebhookRequest } from "@repo/core";
import { metaSignature } from "@repo/channel-meta";

/*
 * Recorded-style WhatsApp Cloud API webhooks, shaped after the examples in Meta's webhook
 * reference (developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/
 * reference, read 2026-11-12). Ids and numbers are Meta's documentation examples; the BSUID
 * format is assumed. Used by this package's tests and by apps/web's end-to-end tests.
 */

export const FIXTURE_WABA_ID = "102290129340398";
export const FIXTURE_PHONE_NUMBER_ID = "106540352242922";
export const FIXTURE_DISPLAY_NUMBER = "15550783881";
export const FIXTURE_CUSTOMER_WA_ID = "16505551234";
export const FIXTURE_CUSTOMER_BSUID = "US.13491208655302741918";
export const FIXTURE_TIMESTAMP = "1794496000"; // 2026-11-12T...Z

export interface FixtureOptions {
  readonly phoneNumberId?: string;
  readonly from?: string | null;
  readonly fromUserId?: string | null;
  readonly name?: string;
  readonly id?: string;
  readonly timestamp?: string;
}

/** The envelope Meta wraps every change in. */
export function whatsappEnvelope(
  field: string,
  value: Record<string, unknown>,
  entryId = FIXTURE_WABA_ID,
): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: entryId, changes: [{ value, field }] }],
  };
}

function metadata(phoneNumberId: string) {
  return { display_phone_number: FIXTURE_DISPLAY_NUMBER, phone_number_id: phoneNumberId };
}

/** A `messages` change carrying one customer message of the given type. */
export function inboundMessage(
  type: string,
  content: Record<string, unknown>,
  options: FixtureOptions = {},
): Record<string, unknown> {
  const from = options.from === undefined ? FIXTURE_CUSTOMER_WA_ID : options.from;
  const fromUserId = options.fromUserId === undefined ? FIXTURE_CUSTOMER_BSUID : options.fromUserId;
  return whatsappEnvelope("messages", {
    messaging_product: "whatsapp",
    metadata: metadata(options.phoneNumberId ?? FIXTURE_PHONE_NUMBER_ID),
    contacts: [
      {
        profile: { name: options.name ?? "Sheena Nelson" },
        ...(from === null ? {} : { wa_id: from }),
        ...(fromUserId === null ? {} : { user_id: fromUserId }),
      },
    ],
    messages: [
      {
        ...(from === null ? {} : { from }),
        ...(fromUserId === null ? {} : { from_user_id: fromUserId }),
        id: options.id ?? "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        timestamp: options.timestamp ?? FIXTURE_TIMESTAMP,
        type,
        ...content,
      },
    ],
  });
}

/** Every inbound type the adapter reads, by name. */
export const INBOUND_FIXTURES = {
  text: () => inboundMessage("text", { text: { body: "Hi, my roof is leaking over the kitchen" } }),
  image: () =>
    inboundMessage("image", {
      image: {
        caption: "Here is the ceiling",
        mime_type: "image/jpeg",
        sha256: "Q5S6AVZmL7qbJdo/lDpY1mVDwbM1WXu+mhpaeSzCv4o=",
        id: "1003383421387256",
        url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256",
      },
    }),
  video: () =>
    inboundMessage("video", {
      video: { mime_type: "video/mp4", sha256: "abc", id: "1171013624558431" },
    }),
  document: () =>
    inboundMessage("document", {
      document: {
        caption: "The old quote",
        filename: "quote.pdf",
        mime_type: "application/pdf",
        sha256: "abc",
        id: "1209867133895484",
      },
    }),
  sticker: () =>
    inboundMessage("sticker", {
      sticker: { mime_type: "image/webp", sha256: "abc", id: "1015203510346735", animated: false },
    }),
  audio: () =>
    inboundMessage("audio", {
      audio: {
        mime_type: "audio/ogg; codecs=opus",
        sha256: "abc",
        id: "1066587198580138",
        voice: true,
      },
    }),
  location: () =>
    inboundMessage("location", {
      location: {
        latitude: 44.97776,
        longitude: -93.26501,
        name: "Home",
        address: "100 Main St, Minneapolis, MN 55401",
      },
    }),
  buttonReply: () =>
    inboundMessage("interactive", {
      context: { from: FIXTURE_DISPLAY_NUMBER, id: "wamid.BOT-QUESTION" },
      interactive: { type: "button_reply", button_reply: { id: "qr_2", title: "This week" } },
    }),
  listReply: () =>
    inboundMessage("interactive", {
      context: { from: FIXTURE_DISPLAY_NUMBER, id: "wamid.BOT-LIST" },
      interactive: {
        type: "list_reply",
        list_reply: { id: "qr_4", title: "Tue 9:00", description: "Tuesday at 9:00 AM" },
      },
    }),
  templateButton: () =>
    inboundMessage("button", {
      context: { from: FIXTURE_DISPLAY_NUMBER, id: "wamid.TEMPLATE" },
      button: { payload: "Yes, still interested", text: "Yes, still interested" },
    }),
  reaction: () =>
    inboundMessage("reaction", {
      reaction: { message_id: "wamid.BOT-REPLY", emoji: "👍" },
    }),
  reactionRemoved: () =>
    inboundMessage("reaction", { reaction: { message_id: "wamid.BOT-REPLY" } }),
  contacts: () =>
    inboundMessage("contacts", {
      contacts: [
        {
          name: { formatted_name: "Mark Nelson", first_name: "Mark" },
          phones: [{ phone: "+1 (650) 555-9876", type: "CELL", wa_id: "16505559876" }],
        },
      ],
    }),
  unsupported: () =>
    inboundMessage("unsupported", {
      errors: [
        {
          code: 131051,
          title: "Message type unknown",
          message: "Message type unknown",
          error_data: { details: "Message type is currently not supported." },
        },
      ],
    }),
  /** A user with a username and a hidden phone number: only the BSUID. */
  usernameOnly: () =>
    inboundMessage("text", { text: { body: "Hello from a username" } }, { from: null }),
  /** An older payload without BSUIDs. */
  phoneOnly: () =>
    inboundMessage("text", { text: { body: "Hello from a phone" } }, { fromUserId: null }),
  /** Arrives when a customer changes their number; not a message. */
  system: () =>
    inboundMessage("system", {
      system: { body: "User changed number", type: "user_changed_number" },
    }),
} as const;

export type InboundFixtureName = keyof typeof INBOUND_FIXTURES;

export function statusFixture(
  status: "sent" | "delivered" | "read" | "failed",
  messageId: string,
  options: { phoneNumberId?: string; timestamp?: string; errorCode?: number } = {},
): Record<string, unknown> {
  return whatsappEnvelope("messages", {
    messaging_product: "whatsapp",
    metadata: metadata(options.phoneNumberId ?? FIXTURE_PHONE_NUMBER_ID),
    statuses: [
      {
        id: messageId,
        status,
        timestamp: options.timestamp ?? FIXTURE_TIMESTAMP,
        recipient_id: FIXTURE_CUSTOMER_WA_ID,
        recipient_user_id: FIXTURE_CUSTOMER_BSUID,
        ...(status === "sent"
          ? {
              conversation: {
                id: "CONVERSATION_ID",
                expiration_timestamp: "1794582400",
                origin: { type: "service" },
              },
            }
          : {}),
        ...(status === "delivered"
          ? {
              pricing: {
                billable: false,
                pricing_model: "PMP",
                type: "free_customer_service",
                category: "service",
              },
            }
          : {}),
        ...(status === "failed"
          ? {
              errors: [
                {
                  code: options.errorCode ?? 131026,
                  title: "Message undeliverable",
                  message: "Message undeliverable",
                  error_data: { details: "Message could not be delivered to the recipient." },
                  href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/",
                },
              ],
            }
          : {}),
      },
    ],
  });
}

export function echoFixture(
  text: string,
  options: { id?: string; to?: string; phoneNumberId?: string } = {},
): Record<string, unknown> {
  return whatsappEnvelope("smb_message_echoes", {
    messaging_product: "whatsapp",
    metadata: metadata(options.phoneNumberId ?? FIXTURE_PHONE_NUMBER_ID),
    message_echoes: [
      {
        from: FIXTURE_DISPLAY_NUMBER,
        to: options.to ?? FIXTURE_CUSTOMER_WA_ID,
        id: options.id ?? "wamid.ECHO-1",
        timestamp: FIXTURE_TIMESTAMP,
        type: "text",
        text: { body: text },
      },
    ],
  });
}

export function templateStatusFixture(
  event: string,
  options: {
    name?: string;
    language?: string;
    templateId?: number;
    wabaId?: string;
    reason?: string | null;
  } = {},
): Record<string, unknown> {
  return whatsappEnvelope(
    "message_template_status_update",
    {
      event,
      message_template_id: options.templateId ?? 806312974732579,
      message_template_name: options.name ?? "follow_up_check_in",
      message_template_language: options.language ?? "en-US",
      reason: options.reason === undefined ? "NONE" : options.reason,
      message_template_category: "UTILITY",
    },
    options.wabaId ?? FIXTURE_WABA_ID,
  );
}

export function accountUpdateFixture(
  event: string,
  wabaId = FIXTURE_WABA_ID,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return whatsappEnvelope(
    "account_update",
    { phone_number: FIXTURE_DISPLAY_NUMBER, event, ...extra },
    wabaId,
  );
}

export function qualityFixture(event: string, wabaId = FIXTURE_WABA_ID): Record<string, unknown> {
  return whatsappEnvelope(
    "phone_number_quality_update",
    { display_phone_number: FIXTURE_DISPLAY_NUMBER, event, current_limit: "TIER_1K" },
    wabaId,
  );
}

/** A webhook request signed with the app secret, as Meta would send it. */
export function signedWhatsAppRequest(
  appSecret: string,
  body: unknown,
  url = "https://app.example.com/api/webhooks/whatsapp",
): WebhookRequest {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": metaSignature(appSecret, rawBody),
    },
    query: {},
    rawBody,
  };
}

/** The same as a fetch `Request`, for route tests. */
export function signedWhatsAppHttpRequest(
  appSecret: string,
  body: unknown,
  url = "http://localhost:3000/api/webhooks/whatsapp",
): Request {
  const signed = signedWhatsAppRequest(appSecret, body, url);
  return new Request(url, { method: "POST", headers: signed.headers, body: signed.rawBody });
}
