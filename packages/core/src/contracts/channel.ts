import { z } from "zod";

import {
  type BusinessId,
  type ChannelConnectionId,
  type ConversationId,
  IsoDateTime,
} from "../ids";

/**
 * Channel adapter contract (owner: C3; implemented by C3 "test", C8 widget, C9 WhatsApp,
 * C10 Instagram and Messenger, C11 email).
 *
 * An adapter translates between one provider and the normalized shapes below. It holds no
 * tenant state and never touches the database: the pipeline resolves the connection, decrypts
 * its credentials just in time and passes them in.
 */

export const CHANNEL_IDS = [
  "whatsapp",
  "instagram",
  "messenger",
  "widget",
  "email",
  "test",
] as const;
export const ChannelId = z.enum(CHANNEL_IDS);
export type ChannelId = z.infer<typeof ChannelId>;

export const ATTACHMENT_KINDS = ["image", "audio", "video", "file"] as const;
export const AttachmentKind = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** Where the bytes of an attachment can be fetched. Downloads happen in a job, not the webhook. */
export const AttachmentSource = z.discriminatedUnion("type", [
  /** Provider media id that needs an authenticated download (WhatsApp, Gmail, Graph). */
  z.object({ type: z.literal("provider_media"), mediaId: z.string().min(1) }),
  /** Short-lived provider URL (Messenger, Instagram). Fetch through the SSRF-safe fetcher. */
  z.object({ type: z.literal("url"), url: z.url() }),
  /** Already in our private storage (widget uploads, IMAP attachments saved at ingest). */
  z.object({ type: z.literal("storage"), bucket: z.string().min(1), path: z.string().min(1) }),
]);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

export const InboundAttachment = z.object({
  kind: AttachmentKind,
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  source: AttachmentSource,
});
export type InboundAttachment = z.infer<typeof InboundAttachment>;

export const EmailAddress = z.object({
  address: z.email(),
  name: z.string().nullable(),
});
export type EmailAddress = z.infer<typeof EmailAddress>;

/** Headers needed to thread a reply correctly (RFC 5322). Present only on the email channel. */
export const EmailEnvelope = z.object({
  messageIdHeader: z.string().min(1),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  subject: z.string(),
  from: EmailAddress,
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
});
export type EmailEnvelope = z.infer<typeof EmailEnvelope>;

export const INBOUND_MESSAGE_KINDS = [
  "text",
  "media",
  "location",
  "interactive_reply",
  "story_reply",
  "reaction",
  "unsupported",
] as const;
export const InboundMessageKind = z.enum(INBOUND_MESSAGE_KINDS);
export type InboundMessageKind = z.infer<typeof InboundMessageKind>;

/** The single inbound message shape for every channel. Adapters must produce exactly this. */
export const NormalizedInboundMessage = z.object({
  channel: ChannelId,
  /** The receiving account at the provider: phone number id, Page id, Instagram account id,
   * inbox address or widget public key. Used to find the channel connection and the tenant. */
  externalAccountId: z.string().min(1),
  /** Provider message id. Unique per connection; the idempotency key for storage. */
  externalMessageId: z.string().min(1),
  /** Provider thread key when one contact can have several threads (email), otherwise null. */
  externalThreadId: z.string().min(1).nullable(),
  sender: z.object({
    /** Stable provider identity: wa_id, PSID, IGSID, widget visitor id or lower-cased email. */
    externalId: z.string().min(1),
    displayName: z.string().nullable(),
    /** E.164 when the channel reveals it. */
    phone: z.string().nullable(),
    email: z.email().nullable(),
  }),
  /** When the customer sent it, according to the provider. */
  sentAt: IsoDateTime,
  kind: InboundMessageKind,
  /** Plain text: the body, a caption, the title of a tapped button, or the cleaned email body. */
  text: z.string().nullable(),
  attachments: z.array(InboundAttachment),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable(),
  /** A tapped button or list row: `id` is what we sent, `title` is what the customer saw. */
  interactiveReply: z.object({ id: z.string(), title: z.string() }).nullable(),
  reaction: z
    .object({
      targetExternalMessageId: z.string().min(1),
      emoji: z.string().nullable(),
      removed: z.boolean(),
    })
    .nullable(),
  replyToExternalMessageId: z.string().nullable(),
  email: EmailEnvelope.nullable(),
  /** Small channel-specific extras (ad referral, story id). Never credentials. */
  metadata: z.record(z.string(), z.unknown()),
});
export type NormalizedInboundMessage = z.infer<typeof NormalizedInboundMessage>;

export const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"] as const;
export const DeliveryStatus = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const DeliveryStatusUpdate = z.object({
  channel: ChannelId,
  externalAccountId: z.string().min(1),
  externalMessageId: z.string().min(1),
  status: DeliveryStatus,
  occurredAt: IsoDateTime,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type DeliveryStatusUpdate = z.infer<typeof DeliveryStatusUpdate>;

/** Provider events that are not customer messages but change conversation or connection state. */
export const ChannelSignal = z.discriminatedUnion("type", [
  /** A person at the business replied from the provider's own inbox: the bot must hand over. */
  z.object({
    type: z.literal("human_agent_replied"),
    channel: ChannelId,
    externalAccountId: z.string().min(1),
    contactExternalId: z.string().min(1),
    externalMessageId: z.string().min(1),
    text: z.string().nullable(),
    occurredAt: IsoDateTime,
  }),
  /** The business removed our access (deauthorized app, revoked token, deleted inbox). */
  z.object({
    type: z.literal("connection_revoked"),
    channel: ChannelId,
    externalAccountId: z.string().min(1),
    reason: z.string(),
    occurredAt: IsoDateTime,
  }),
]);
export type ChannelSignal = z.infer<typeof ChannelSignal>;

export const ParsedWebhook = z.object({
  messages: z.array(NormalizedInboundMessage),
  statuses: z.array(DeliveryStatusUpdate),
  signals: z.array(ChannelSignal),
});
export type ParsedWebhook = z.infer<typeof ParsedWebhook>;

/** Framework-free view of an HTTP request so adapters can be tested with recorded fixtures. */
export interface WebhookRequest {
  readonly method: "GET" | "POST";
  /** Full request URL; some providers sign it. */
  readonly url: string;
  /** Header names are lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** The exact body text. Signatures are computed over this, never over re-serialized JSON. */
  readonly rawBody: string;
}

export type WebhookVerification =
  | { readonly outcome: "verified" }
  /** Subscription handshake: answer with this response and do nothing else. */
  | {
      readonly outcome: "challenge";
      readonly status: number;
      readonly contentType: string;
      readonly body: string;
    }
  /** Bad signature, stale timestamp or wrong verify token. The route answers 401. */
  | { readonly outcome: "rejected"; readonly reason: string };

export type MessagingWindowPolicy =
  | { readonly type: "none" }
  | {
      readonly type: "rolling";
      /** Free-form replies are allowed for this long after the customer's last message. */
      readonly hours: number;
      /** What is possible once the window has closed. */
      readonly outside: "template_only" | "human_agent_tag" | "blocked";
      /** Extended window for tagged human-agent replies, when the platform has one. */
      readonly humanAgentHours: number | null;
    };

export interface ChannelCapabilities {
  /** Drives formatting: short chat messages or a proper email. */
  readonly format: "chat" | "email";
  /** Longest text the provider accepts in one message; the pipeline splits longer replies. */
  readonly maxTextLength: number;
  readonly richText: "none" | "whatsapp_markdown" | "html";
  readonly inboundMedia: readonly AttachmentKind[];
  readonly outboundMedia: readonly AttachmentKind[];
  readonly quickReplies: { readonly maxOptions: number; readonly maxTitleLength: number } | null;
  readonly typingIndicator: boolean;
  readonly readReceipts: boolean;
  readonly deliveryStatus: boolean;
  readonly messagingWindow: MessagingWindowPolicy;
  /** "threads" when one contact can hold several separate conversations (email). */
  readonly threading: "single" | "threads";
}

/**
 * Baseline capabilities per channel, used by the engine and the evaluation harness without
 * importing an adapter. Adapters export their own `capabilities` built from these; C8 to C11
 * verify every number against the vendor's current documentation.
 */
export const CHANNEL_CAPABILITIES = {
  whatsapp: {
    format: "chat",
    maxTextLength: 4096,
    richText: "whatsapp_markdown",
    inboundMedia: ["image", "audio", "video", "file"],
    outboundMedia: ["image", "audio", "video", "file"],
    quickReplies: { maxOptions: 3, maxTitleLength: 20 },
    typingIndicator: true,
    readReceipts: true,
    deliveryStatus: true,
    messagingWindow: {
      type: "rolling",
      hours: 24,
      outside: "template_only",
      humanAgentHours: null,
    },
    threading: "single",
  },
  instagram: {
    format: "chat",
    maxTextLength: 1000,
    richText: "none",
    inboundMedia: ["image", "audio", "video", "file"],
    outboundMedia: ["image"],
    quickReplies: { maxOptions: 13, maxTitleLength: 20 },
    typingIndicator: true,
    readReceipts: true,
    deliveryStatus: true,
    messagingWindow: {
      type: "rolling",
      hours: 24,
      outside: "human_agent_tag",
      humanAgentHours: 168,
    },
    threading: "single",
  },
  messenger: {
    format: "chat",
    maxTextLength: 2000,
    richText: "none",
    inboundMedia: ["image", "audio", "video", "file"],
    outboundMedia: ["image", "file"],
    quickReplies: { maxOptions: 13, maxTitleLength: 20 },
    typingIndicator: true,
    readReceipts: true,
    deliveryStatus: true,
    messagingWindow: {
      type: "rolling",
      hours: 24,
      outside: "human_agent_tag",
      humanAgentHours: 168,
    },
    threading: "single",
  },
  widget: {
    format: "chat",
    maxTextLength: 2000,
    richText: "none",
    inboundMedia: ["image"],
    outboundMedia: ["image"],
    quickReplies: { maxOptions: 4, maxTitleLength: 40 },
    typingIndicator: true,
    readReceipts: false,
    deliveryStatus: false,
    messagingWindow: { type: "none" },
    threading: "single",
  },
  email: {
    format: "email",
    maxTextLength: 100_000,
    richText: "html",
    inboundMedia: ["image", "audio", "video", "file"],
    outboundMedia: ["image", "file"],
    quickReplies: null,
    typingIndicator: false,
    readReceipts: false,
    deliveryStatus: false,
    messagingWindow: { type: "none" },
    threading: "threads",
  },
  test: {
    format: "chat",
    maxTextLength: 2000,
    richText: "none",
    inboundMedia: ["image"],
    outboundMedia: ["image"],
    quickReplies: { maxOptions: 4, maxTitleLength: 40 },
    typingIndicator: true,
    readReceipts: true,
    deliveryStatus: true,
    messagingWindow: { type: "none" },
    threading: "single",
  },
} as const satisfies Record<ChannelId, ChannelCapabilities>;

/** Whether free-form sending is allowed right now, computed by the pipeline per conversation. */
export interface MessagingWindowState {
  readonly open: boolean;
  /** Null when the channel has no window. */
  readonly closesAt: IsoDateTime | null;
}

/** A stored channel connection with its secrets decrypted for the duration of one call. */
export interface ChannelConnectionContext<TCredentials = unknown, TConfig = unknown> {
  readonly connectionId: ChannelConnectionId;
  readonly businessId: BusinessId;
  readonly externalAccountId: string;
  /** Decrypted secrets. Never log, never return to a browser, never put in a job payload. */
  readonly credentials: TCredentials;
  readonly config: TConfig;
}

export type OutboundMessage =
  | {
      readonly kind: "text";
      readonly text: string;
      /** Rendered as buttons where the channel supports them, otherwise appended as text. */
      readonly quickReplies?: readonly string[];
    }
  | {
      readonly kind: "media";
      readonly mediaKind: AttachmentKind;
      /** Location in our private storage; the adapter uploads or signs a URL as needed. */
      readonly storage: { readonly bucket: string; readonly path: string };
      readonly mimeType: string;
      readonly caption: string | null;
    }
  | {
      /** Pre-approved template, used when the messaging window is closed (WhatsApp). */
      readonly kind: "template";
      readonly templateName: string;
      readonly languageCode: string;
      readonly variables: readonly string[];
    }
  | {
      readonly kind: "email";
      readonly subject: string;
      readonly text: string;
      readonly html: string;
    };

export interface SendTarget {
  readonly connection: ChannelConnectionContext;
  readonly conversationId: ConversationId;
  /** The customer's identity at the provider (same value as `sender.externalId` inbound). */
  readonly recipientExternalId: string;
  readonly externalThreadId: string | null;
  readonly replyToExternalMessageId: string | null;
  readonly window: MessagingWindowState;
  /** Threading headers for replies on the email channel. */
  readonly email: Pick<EmailEnvelope, "inReplyTo" | "references" | "subject"> | null;
  /** Our outbound message id. Pass it to providers that accept an idempotency key. */
  readonly idempotencyKey: string;
  /** True when a person, not the bot, wrote the message (enables the human-agent tag). */
  readonly sentByHuman: boolean;
}

export interface SendFailure {
  /** Provider error code when there is one, otherwise a short stable slug. */
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  /** True when the provider refused because the messaging window is closed. */
  readonly windowClosed: boolean;
}

export type SendResult =
  | { readonly ok: true; readonly externalMessageId: string; readonly sentAt: IsoDateTime }
  | { readonly ok: false; readonly error: SendFailure };

export interface ChannelAdapter {
  readonly channel: ChannelId;
  readonly capabilities: ChannelCapabilities;

  /**
   * Checks the signature or handshake. Must use a constant-time comparison. A bad request is
   * answered with `rejected` (the route returns 401), never by throwing.
   */
  verifyWebhook(request: WebhookRequest): Promise<WebhookVerification>;

  /**
   * Turns a verified payload into normalized messages, delivery statuses and signals. Throws
   * a `ValidationError` for a payload it cannot read (400); anything else thrown is a 500,
   * so the provider retries.
   */
  parseWebhook(request: WebhookRequest): Promise<ParsedWebhook>;

  /**
   * Sends exactly one provider message. Splitting long text is the pipeline's job. Report
   * failures in the `SendResult`; anything thrown is treated as a retryable failure.
   */
  send(message: OutboundMessage, target: SendTarget): Promise<SendResult>;

  /** Shows or hides the typing indicator, where the channel has one. */
  sendTyping?(target: SendTarget, state: "on" | "off"): Promise<void>;

  /** Marks a customer message as read, where the channel has read receipts. */
  markRead?(target: SendTarget, externalMessageId: string): Promise<void>;

  /** Downloads an inbound attachment that is not yet in our storage. */
  fetchAttachment?(
    connection: ChannelConnectionContext,
    source: AttachmentSource,
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
}
