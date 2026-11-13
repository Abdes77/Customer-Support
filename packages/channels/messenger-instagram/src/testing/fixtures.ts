import type { WebhookRequest } from "@repo/core";
import { metaSignature } from "@repo/channel-meta";

import type { MetaMessagingChannel } from "../webhook";

/*
 * Recorded-style Messenger and Instagram webhooks, shaped after the examples in Meta's
 * webhook references (developers.facebook.com/documentation/business-messaging/
 * messenger-platform/webhooks/webhook-events/* and .../instagram-messaging/webhooks, read
 * 2026-11-12). Ids are made up in Meta's formats. Used by this package's tests and by
 * apps/web's end-to-end tests.
 */

export const FIXTURE_APP_ID = "1517776481860111";
export const FIXTURE_PAGE_ID = "682498171943165";
export const FIXTURE_PAGE_NAME = "Summit Roofing";
export const FIXTURE_IG_ACCOUNT_ID = "17841405822304914";
export const FIXTURE_IG_USERNAME = "summitroofing";
export const FIXTURE_PSID = "1254459154682919";
export const FIXTURE_IGSID = "6152458451469113";
/** 2026-11-12T10:00:00.000Z in milliseconds, as Meta sends it. */
export const FIXTURE_TIME_MS = 1_794_477_600_000;
export const PAGE_INBOX_APP_ID = "263902037430900";

export interface EventOptions {
  readonly channel?: MetaMessagingChannel;
  /** The customer (PSID or IGSID). */
  readonly from?: string;
  readonly timestamp?: number;
  readonly accountId?: string;
  /** Put the event in `standby` (another app controls the conversation). */
  readonly standby?: boolean;
}

function accountOf(options: EventOptions): string {
  return (
    options.accountId ?? (options.channel === "instagram" ? FIXTURE_IG_ACCOUNT_ID : FIXTURE_PAGE_ID)
  );
}

function customerOf(options: EventOptions): string {
  return options.from ?? (options.channel === "instagram" ? FIXTURE_IGSID : FIXTURE_PSID);
}

/** The envelope Meta wraps events in: `object`, then one entry per Page or account. */
export function metaEnvelope(
  events: readonly Record<string, unknown>[],
  options: EventOptions = {},
): Record<string, unknown> {
  const account = accountOf(options);
  return {
    object: options.channel === "instagram" ? "instagram" : "page",
    entry: [
      {
        id: account,
        time: (options.timestamp ?? FIXTURE_TIME_MS) + 200,
        [options.standby === true ? "standby" : "messaging"]: events,
      },
    ],
  };
}

/** One customer event (`message`, `postback`, `reaction`, `delivery`, `read`...). */
export function customerEvent(
  content: Record<string, unknown>,
  options: EventOptions = {},
): Record<string, unknown> {
  return {
    sender: { id: customerOf(options) },
    recipient: { id: accountOf(options) },
    timestamp: options.timestamp ?? FIXTURE_TIME_MS,
    ...content,
  };
}

/** A webhook with one customer message. */
export function inboundMessage(
  message: Record<string, unknown>,
  options: EventOptions = {},
): Record<string, unknown> {
  return metaEnvelope([customerEvent({ message }, options)], options);
}

/** A webhook with one echo: a message the business sent, from our app or another. */
export function echoMessage(
  message: { mid: string; text?: string; app_id?: string | number; metadata?: string },
  options: EventOptions = {},
): Record<string, unknown> {
  return metaEnvelope(
    [
      {
        sender: { id: accountOf(options) },
        recipient: { id: customerOf(options) },
        timestamp: options.timestamp ?? FIXTURE_TIME_MS,
        message: { is_echo: true, ...message },
      },
    ],
    options,
  );
}

let counter = 0;
/** A fresh message id in Meta's format. */
export function mid(prefix = "m"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}AG5Hz2Uq7tuwNEhXfYYKj8mJEM`;
}

/** Every inbound kind both platforms send, keyed by name. */
export const INBOUND_FIXTURES = {
  text: (text = "Hi, my roof is leaking over the kitchen", options: EventOptions = {}) =>
    inboundMessage({ mid: mid(), text }, options),
  quickReply: (options: EventOptions = {}) =>
    inboundMessage({ mid: mid(), text: "This week", quick_reply: { payload: "qr_1" } }, options),
  image: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        attachments: [
          {
            type: "image",
            payload: { url: "https://scontent.xx.fbcdn.net/v/t1.15752-9/roof.jpg?oh=1" },
          },
        ],
      },
      options,
    ),
  video: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        attachments: [
          { type: "video", payload: { url: "https://video.xx.fbcdn.net/v/t42.3356-2/leak.mp4" } },
        ],
      },
      options,
    ),
  audio: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        attachments: [
          { type: "audio", payload: { url: "https://cdn.fbsbx.com/v/t59.3654-21/a.mp4" } },
        ],
      },
      options,
    ),
  file: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        attachments: [
          { type: "file", payload: { url: "https://cdn.fbsbx.com/v/t59.2708-21/quote.pdf" } },
        ],
      },
      options,
    ),
  /** Messenger's like button during the sticker transition: both shapes. */
  likeSticker: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        attachments: [
          {
            type: "sticker",
            payload: { url: "https://scontent.xx.fbcdn.net/like.png", sticker_id: 369239263222822 },
          },
          {
            type: "image",
            payload: { url: "https://scontent.xx.fbcdn.net/like.png", sticker_id: 369239263222822 },
          },
        ],
      },
      options,
    ),
  share: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        text: "This is the kind of roof I want: https://example.com/roof",
        attachments: [
          { type: "fallback", payload: { url: "https://example.com/roof", title: "Slate roofs" } },
        ],
      },
      options,
    ),
  inlineReply: (replyTo: string, options: EventOptions = {}) =>
    inboundMessage({ mid: mid(), text: "Yes, that one", reply_to: { mid: replyTo } }, options),
  adReferral: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid(),
        text: "Is this offer still available?",
        referral: {
          ref: "spring-roof",
          ad_id: "6045246247433",
          source: "ADS",
          type: "OPEN_THREAD",
          ads_context_data: { ad_title: "Spring roof check", photo_url: "https://x.example/p.jpg" },
        },
      },
      options,
    ),
  storyReply: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid("aWdf"),
        text: "How much was this one?",
        reply_to: {
          story: {
            url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
            id: "17920370216031394",
          },
        },
      },
      { channel: "instagram", ...options },
    ),
  storyMention: (options: EventOptions = {}) =>
    inboundMessage(
      {
        mid: mid("aWdf"),
        attachments: [
          {
            type: "story_mention",
            payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2" },
          },
        ],
      },
      { channel: "instagram", ...options },
    ),
  ephemeral: (options: EventOptions = {}) =>
    inboundMessage(
      { mid: mid("aWdf"), attachments: [{ type: "ephemeral" }] },
      { channel: "instagram", ...options },
    ),
  unsupported: (options: EventOptions = {}) =>
    inboundMessage(
      { mid: mid("aWdf"), is_unsupported: true },
      { channel: "instagram", ...options },
    ),
  deleted: (options: EventOptions = {}) =>
    inboundMessage({ mid: mid("aWdf"), is_deleted: true }, { channel: "instagram", ...options }),
  adminText: (options: EventOptions = {}) =>
    inboundMessage(
      { admin_text: "The customer asked for a person", handoff_reason: "human_requested" },
      options,
    ),
  postback: (options: EventOptions = {}) =>
    metaEnvelope(
      [
        customerEvent(
          { postback: { mid: mid(), title: "Get Started", payload: "GET_STARTED" } },
          options,
        ),
      ],
      options,
    ),
  reaction: (target: string, options: EventOptions = {}) =>
    metaEnvelope(
      [
        customerEvent(
          { reaction: { mid: target, action: "react", reaction: "love", emoji: "❤️" } },
          options,
        ),
      ],
      options,
    ),
  unreaction: (target: string, options: EventOptions = {}) =>
    metaEnvelope(
      [customerEvent({ reaction: { mid: target, action: "unreact" } }, options)],
      options,
    ),
} as const;

/** `message_deliveries`: delivered message ids and a watermark (ms). */
export function deliveryFixture(
  mids: readonly string[] | null,
  watermark: number,
  options: EventOptions = {},
): Record<string, unknown> {
  return metaEnvelope(
    [customerEvent({ delivery: { ...(mids === null ? {} : { mids }), watermark } }, options)],
    options,
  );
}

/** `message_reads` (Messenger, watermark) or `messaging_seen` (Instagram, message id). */
export function readFixture(
  read: { mid?: string; watermark?: number },
  options: EventOptions = {},
): Record<string, unknown> {
  return metaEnvelope([customerEvent({ read }, options)], options);
}

export function policyFixture(
  action: "warning" | "block" | "unblock",
  options: EventOptions & { timestamp?: number } = {},
): Record<string, unknown> {
  return metaEnvelope(
    [
      {
        recipient: { id: accountOf(options) },
        timestamp: options.timestamp ?? FIXTURE_TIME_MS,
        policy_enforcement: {
          action,
          ...(action === "unblock" ? {} : { reason: "The bot violated our Platform Policies." }),
        },
      },
    ],
    options,
  );
}

/** A signed request as the adapter sees it. */
export function signedMetaRequest(
  appSecret: string,
  body: unknown,
  url = "http://localhost:3000/api/webhooks/messenger",
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

/** The same, as an HTTP request for the app's webhook route. */
export function signedMetaHttpRequest(
  appSecret: string,
  body: unknown,
  channel: MetaMessagingChannel = "messenger",
): Request {
  const url = `http://localhost:3000/api/webhooks/${channel}`;
  const signed = signedMetaRequest(appSecret, body, url);
  return new Request(url, { method: "POST", headers: signed.headers, body: signed.rawBody });
}
