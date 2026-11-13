import { z } from "zod";

import {
  type AttachmentKind,
  type ChannelSignal,
  type DeliveryStatusUpdate,
  type InboundAttachment,
  type NormalizedInboundMessage,
  type ParsedWebhook,
  ValidationError,
} from "@repo/core";

import { PAGE_INBOX_APP_IDS, SEND_METADATA_PREFIX } from "./credentials";

/*
 * Messenger (`object: "page"`) and Instagram Direct (`object: "instagram"`) webhooks of the
 * Messenger Platform, as documented at developers.facebook.com/documentation/
 * business-messaging/messenger-platform/webhooks and .../instagram-messaging/webhooks
 * (read 2026-11-12):
 *
 *   { object, entry: [{ id: <Page id | Instagram account id>, time, messaging: [event],
 *                       standby?: [event] }] }
 *   event = { sender: { id }, recipient: { id }, timestamp (ms), message | postback |
 *             reaction | delivery | read | policy_enforcement | ... }
 *
 * Customers are identified by their Page-scoped id (PSID) on Messenger and their
 * Instagram-scoped id (IGSID) on Instagram. Messages the business sends come back as echoes
 * (`message.is_echo`): Messenger's carry the sending app's id, Instagram's do not. Events in
 * `standby` arrive while another app controls the conversation (Conversation Routing).
 * The schemas are lenient on purpose: Meta adds fields without notice, and what cannot be
 * read is skipped, never guessed.
 */

export type MetaMessagingChannel = "messenger" | "instagram";

const OBJECT_OF: Record<MetaMessagingChannel, string> = {
  messenger: "page",
  instagram: "instagram",
};

const Str = z.string();
const OptStr = z.string().optional();
const Id = z.union([z.string(), z.number()]).transform(String);

const Attachment = z
  .object({
    type: Str,
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    payload: z
      .object({
        url: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        sticker_id: Id.optional(),
        id: Id.optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type Attachment = z.infer<typeof Attachment>;

const Message = z
  .object({
    mid: OptStr,
    text: OptStr,
    is_echo: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
    is_unsupported: z.boolean().optional(),
    is_self: z.boolean().optional(),
    app_id: Id.optional(),
    metadata: OptStr,
    quick_reply: z.object({ payload: Id.optional() }).passthrough().optional(),
    reply_to: z
      .object({
        mid: OptStr,
        story: z.object({ url: OptStr, id: Id.optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    attachments: z.array(z.unknown()).optional(),
    referral: z.record(z.string(), z.unknown()).optional(),
    admin_text: OptStr,
  })
  .passthrough();
type Message = z.infer<typeof Message>;

const Party = z.object({ id: Id.optional(), user_ref: OptStr }).passthrough();

const Event = z
  .object({
    sender: Party.optional(),
    recipient: Party.optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
    message: z.unknown().optional(),
    postback: z
      .object({ mid: OptStr, title: OptStr, payload: OptStr, referral: z.unknown().optional() })
      .passthrough()
      .optional(),
    reaction: z
      .object({ mid: Str.min(1), action: OptStr, reaction: OptStr, emoji: OptStr })
      .passthrough()
      .optional(),
    delivery: z
      .object({
        mids: z.array(Str).optional(),
        watermark: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
    read: z
      .object({ mid: OptStr, watermark: z.union([z.number(), z.string()]).optional() })
      .passthrough()
      .optional(),
    policy_enforcement: z.object({ action: Str, reason: OptStr }).passthrough().optional(),
  })
  .passthrough();
type Event = z.infer<typeof Event>;

const Envelope = z.object({
  object: Str,
  entry: z.array(
    z
      .object({
        id: Id,
        time: z.union([z.number(), z.string()]).optional(),
        messaging: z.array(z.unknown()).optional(),
        standby: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  ),
});

/**
 * Meta's timestamps are milliseconds (seconds in a few older payloads, and strings in the
 * postback reference). A bad value becomes the receiving time.
 */
export function isoFromMetaTime(value: string | number | undefined, fallback: Date): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback.toISOString();
  const ms = number < 1e12 ? number * 1000 : number;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/** Thumbs-up stickers (Messenger's "like" button sends one of these). */
const LIKE_STICKERS = new Set(["369239263222822", "369239343222814", "369239383222810"]);

const MEDIA_KINDS: Partial<Record<string, AttachmentKind>> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
  sticker: "image",
};

/** Shared content: a link, a post, a reel. Recorded as metadata, never downloaded. */
const SHARE_TYPES = new Set([
  "fallback",
  "share",
  "post",
  "ig_post",
  "reel",
  "ig_reel",
  "template",
  "media",
]);

function httpsUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.length === 0 || raw.length > 4000) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function referralOf(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const referral = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ["ref", "ad_id", "source", "type"]) {
    const value = referral[key];
    if (typeof value === "string" || typeof value === "number") {
      picked[key] = String(value).slice(0, 300);
    }
  }
  const context = referral["ads_context_data"];
  if (context !== null && typeof context === "object") {
    const title = (context as Record<string, unknown>)["ad_title"];
    if (typeof title === "string") picked["ad_title"] = title.slice(0, 300);
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

interface ReadAttachments {
  readonly attachments: InboundAttachment[];
  readonly shares: { type: string; url: string | null; title: string | null }[];
  readonly likeSticker: boolean;
  readonly sticker: boolean;
  readonly storyMention: string | null;
  readonly ephemeral: boolean;
}

function readAttachments(raw: readonly unknown[]): ReadAttachments {
  const parsed = raw
    .map((item) => Attachment.safeParse(item))
    .filter((item) => item.success)
    .map((item) => item.data);
  // Until the sticker transition ends, a sticker comes as both `sticker` and `image`.
  const stickerIds = new Set(
    parsed
      .filter((item) => item.type === "sticker")
      .map((item) => item.payload?.sticker_id)
      .filter((id): id is string => id !== undefined),
  );
  const result: ReadAttachments = {
    attachments: [],
    shares: [],
    likeSticker: false,
    sticker: false,
    storyMention: null,
    ephemeral: false,
  };
  const mutable = result as {
    -readonly [K in keyof ReadAttachments]: ReadAttachments[K];
  };
  for (const item of parsed.slice(0, 10)) {
    const url = httpsUrl(item.payload?.url ?? item.url);
    const stickerId = item.payload?.sticker_id;
    if (item.type === "image" && stickerId !== undefined && stickerIds.has(stickerId)) continue;
    if (stickerId !== undefined && LIKE_STICKERS.has(stickerId)) {
      mutable.likeSticker = true;
      continue;
    }
    if (item.type === "ephemeral") {
      mutable.ephemeral = true;
      continue;
    }
    if (item.type === "story_mention" || item.type === "story" || item.type === "ig_story") {
      mutable.storyMention = url;
      if (url !== null) addMedia(result.attachments, "image", url);
      continue;
    }
    const kind = MEDIA_KINDS[item.type];
    if (kind !== undefined && url !== null) {
      if (item.type === "sticker" || stickerId !== undefined) mutable.sticker = true;
      addMedia(result.attachments, kind, url);
      continue;
    }
    if (SHARE_TYPES.has(item.type) || kind !== undefined) {
      result.shares.push({
        type: item.type,
        url: url === null ? null : url.slice(0, 500),
        title: (item.payload?.title ?? item.title ?? null)?.slice(0, 200) ?? null,
      });
    }
  }
  return result;
}

function addMedia(list: InboundAttachment[], kind: AttachmentKind, url: string): void {
  list.push({
    kind,
    mimeType: null,
    fileName: null,
    sizeBytes: null,
    source: { type: "url", url },
  });
}

interface ParseContext {
  readonly channel: MetaMessagingChannel;
  /** Our Meta app id (`META_APP_ID`): echoes with it are our own sends. */
  readonly appId: string | null;
  readonly now: Date;
}

interface Collected {
  messages: NormalizedInboundMessage[];
  statuses: DeliveryStatusUpdate[];
  signals: ChannelSignal[];
}

function baseMessage(
  ctx: ParseContext,
  accountId: string,
  senderId: string,
  externalMessageId: string,
  sentAt: string,
  metadata: Record<string, unknown>,
): NormalizedInboundMessage {
  return {
    channel: ctx.channel,
    externalAccountId: accountId,
    externalMessageId,
    externalThreadId: null,
    sender: { externalId: senderId, displayName: null, phone: null, email: null },
    sentAt,
    kind: "text",
    text: null,
    attachments: [],
    location: null,
    interactiveReply: null,
    reaction: null,
    replyToExternalMessageId: null,
    email: null,
    metadata: compact(metadata),
  };
}

/** An echo of a message the business sent: ours, or a person's reply from Meta's inbox. */
function readEcho(
  ctx: ParseContext,
  accountId: string,
  event: Event,
  message: Message,
  occurredAt: string,
  out: Collected,
): void {
  const contact = event.recipient?.id;
  const mid = message.mid;
  if (contact === undefined || contact.length === 0 || mid === undefined || mid.length === 0) {
    return;
  }
  const appId = message.app_id ?? null;
  const ourMetadata = message.metadata?.startsWith(SEND_METADATA_PREFIX) === true;
  // Our own send: the app id says so, or our marker came back and no app id contradicts it.
  if (appId !== null && ctx.appId !== null && appId === ctx.appId) return;
  if (ourMetadata && (appId === null || ctx.appId === null)) return;
  // Another app's id (the Page inbox, Meta Business Suite) is a person at the business.
  // Without any app id (Instagram) the pipeline matches the echo against what it sent.
  const attribution: "external" | "unverified" =
    appId !== null && (ctx.appId !== null || PAGE_INBOX_APP_IDS.has(appId))
      ? "external"
      : "unverified";
  out.signals.push({
    type: "human_agent_replied",
    channel: ctx.channel,
    externalAccountId: accountId,
    contactExternalId: contact,
    externalMessageId: mid,
    text: message.text !== undefined && message.text.length > 0 ? message.text : null,
    occurredAt,
    attribution,
  });
}

function readMessage(
  ctx: ParseContext,
  accountId: string,
  event: Event,
  standby: boolean,
  out: Collected,
): void {
  const parsed = Message.safeParse(event.message);
  if (!parsed.success) return;
  const message = parsed.data;
  const occurredAt = isoFromMetaTime(event.timestamp, ctx.now);
  if (message.is_echo === true) {
    readEcho(ctx, accountId, event, message, occurredAt, out);
    return;
  }
  const senderId = event.sender?.id;
  const mid = message.mid;
  // A handoff notice (admin_text only), a deleted message or a test message to oneself is
  // not something a customer said.
  if (
    senderId === undefined ||
    senderId.length === 0 ||
    mid === undefined ||
    mid.length === 0 ||
    message.is_deleted === true ||
    message.is_self === true ||
    senderId === accountId
  ) {
    return;
  }
  const read = readAttachments(message.attachments ?? []);
  const text = message.text !== undefined && message.text.trim().length > 0 ? message.text : null;
  const story = message.reply_to?.story;
  const base = baseMessage(ctx, accountId, senderId, mid, occurredAt, {
    standby: standby ? true : undefined,
    referral: referralOf(message.referral),
    shares: read.shares.length > 0 ? read.shares : undefined,
    sticker: read.sticker || read.likeSticker ? true : undefined,
    story:
      story !== undefined
        ? compact({ reply: true, id: story.id })
        : read.storyMention !== null
          ? { mention: true }
          : undefined,
  });
  const replyTo = message.reply_to?.mid ?? null;
  const withReply = { ...base, replyToExternalMessageId: replyTo };

  if (message.quick_reply !== undefined && text !== null) {
    const payload = message.quick_reply.payload ?? text;
    withReply.kind = "interactive_reply";
    withReply.text = text;
    withReply.interactiveReply = { id: payload.slice(0, 1000), title: text.slice(0, 200) };
    out.messages.push(withReply);
    return;
  }
  if (story !== undefined || read.storyMention !== null) {
    out.messages.push({
      ...withReply,
      kind: "story_reply",
      text,
      attachments: read.attachments,
    });
    return;
  }
  if (read.attachments.length > 0) {
    out.messages.push({ ...withReply, kind: "media", text, attachments: read.attachments });
    return;
  }
  if (text !== null) {
    out.messages.push({ ...withReply, kind: "text", text });
    return;
  }
  if (read.likeSticker) {
    out.messages.push({ ...withReply, kind: "text", text: "👍" });
    return;
  }
  // A share without words, disappearing media, or something the API cannot show: stored and
  // shown in the inbox, and the bot can ask the customer to describe it.
  out.messages.push({
    ...withReply,
    kind: "unsupported",
    metadata: compact({
      ...withReply.metadata,
      ephemeral: read.ephemeral ? true : undefined,
      unsupported: message.is_unsupported === true ? true : undefined,
    }),
  });
}

function readEvent(
  ctx: ParseContext,
  accountId: string,
  raw: unknown,
  standby: boolean,
  out: Collected,
): void {
  const checked = Event.safeParse(raw);
  if (!checked.success) return;
  const event = checked.data;
  const occurredAt = isoFromMetaTime(event.timestamp, ctx.now);
  const customer = event.sender?.id;

  if (event.message !== undefined) {
    readMessage(ctx, accountId, event, standby, out);
    return;
  }
  if (event.postback !== undefined) {
    // A Get Started button, a persistent menu item or an ice breaker. Without a sender id
    // (a `user_ref` from a plugin) there is nobody to answer.
    if (customer === undefined || customer === accountId) return;
    const title = event.postback.title ?? event.postback.payload ?? "";
    if (title.length === 0) return;
    const mid = event.postback.mid ?? `postback:${customer}:${String(event.timestamp ?? "")}`;
    const message = baseMessage(ctx, accountId, customer, mid, occurredAt, {
      standby: standby ? true : undefined,
      postback: true,
      referral: referralOf(event.postback.referral),
    });
    out.messages.push({
      ...message,
      kind: "interactive_reply",
      text: title.slice(0, 1000),
      interactiveReply: {
        id: (event.postback.payload ?? title).slice(0, 1000),
        title: title.slice(0, 200),
      },
    });
    return;
  }
  if (event.reaction !== undefined) {
    if (customer === undefined || customer === accountId) return;
    const removed = event.reaction.action === "unreact";
    const emoji = event.reaction.emoji ?? null;
    // A reaction has no id of its own: one per message, person, time and action.
    const id = `reaction:${event.reaction.mid}:${customer}:${String(event.timestamp ?? "")}:${removed ? "u" : "r"}`;
    const message = baseMessage(ctx, accountId, customer, id.slice(0, 500), occurredAt, {
      standby: standby ? true : undefined,
      reaction: event.reaction.reaction,
    });
    out.messages.push({
      ...message,
      kind: "reaction",
      reaction: {
        targetExternalMessageId: event.reaction.mid,
        emoji: removed || emoji === null || emoji.length === 0 ? null : emoji,
        removed,
      },
    });
    return;
  }
  if (event.delivery !== undefined) {
    for (const mid of event.delivery.mids ?? []) {
      if (mid.length === 0) continue;
      out.statuses.push({
        channel: ctx.channel,
        externalAccountId: accountId,
        externalMessageId: mid,
        status: "delivered",
        occurredAt,
        error: null,
      });
    }
    if (customer !== undefined && event.delivery.watermark !== undefined) {
      out.signals.push({
        type: "delivery_watermark",
        channel: ctx.channel,
        externalAccountId: accountId,
        contactExternalId: customer,
        status: "delivered",
        watermark: isoFromMetaTime(event.delivery.watermark, ctx.now),
        occurredAt,
      });
    }
    return;
  }
  if (event.read !== undefined) {
    if (event.read.mid !== undefined && event.read.mid.length > 0) {
      // Instagram's messaging_seen names the message.
      out.statuses.push({
        channel: ctx.channel,
        externalAccountId: accountId,
        externalMessageId: event.read.mid,
        status: "read",
        occurredAt,
        error: null,
      });
    }
    if (customer !== undefined && event.read.watermark !== undefined) {
      out.signals.push({
        type: "delivery_watermark",
        channel: ctx.channel,
        externalAccountId: accountId,
        contactExternalId: customer,
        status: "read",
        watermark: isoFromMetaTime(event.read.watermark, ctx.now),
        occurredAt,
      });
    }
    return;
  }
  if (event.policy_enforcement !== undefined) {
    out.signals.push({
      type: "provider_event",
      channel: ctx.channel,
      externalAccountId: accountId,
      event: "policy_enforcement",
      data: compact({
        action: event.policy_enforcement.action.slice(0, 50),
        reason: event.policy_enforcement.reason?.slice(0, 500),
      }),
      occurredAt,
    });
  }
  // Referrals without a message, opt-ins, handovers, edits: nothing for the bot to do.
}

/**
 * Parses a verified webhook body for one channel. Throws a `ValidationError` for a body that
 * is not a Messenger Platform webhook at all (400); a webhook for the other platform's
 * object, or entries this code cannot read, are acknowledged and skipped.
 */
export function parseMetaMessagingWebhook(
  rawBody: string,
  options: {
    readonly channel: MetaMessagingChannel;
    readonly appId?: string | null;
    readonly now: Date;
  },
): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ValidationError("The webhook body is not JSON.");
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    throw new ValidationError("The webhook body is not a Messenger Platform webhook.");
  }
  const out: Collected = { messages: [], statuses: [], signals: [] };
  if (envelope.data.object !== OBJECT_OF[options.channel]) return out;
  const ctx: ParseContext = {
    channel: options.channel,
    appId: options.appId ?? null,
    now: options.now,
  };
  for (const entry of envelope.data.entry) {
    for (const event of entry.messaging ?? []) readEvent(ctx, entry.id, event, false, out);
    for (const event of entry.standby ?? []) readEvent(ctx, entry.id, event, true, out);
  }
  return out;
}
