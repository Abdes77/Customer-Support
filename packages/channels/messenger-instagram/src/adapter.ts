import { z } from "zod";

import {
  AppError,
  type AttachmentSource,
  CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelConnectionContext,
  type Logger,
  type OutboundMessage,
  type SendResult,
  type SendTarget,
  ValidationError,
  type WebhookRequest,
} from "@repo/core";
import {
  GraphApiError,
  type GraphClient,
  type MetaWebhookSecrets,
  uploadMessageAttachment,
  verifyMetaWebhook,
} from "@repo/channel-meta";

import { MetaPageConfig, MetaPageCredentials, SEND_METADATA_PREFIX } from "./credentials";
import {
  attachmentBody,
  fitText,
  HUMAN_AGENT_TAG,
  MEDIA_LIMITS,
  type MessagingType,
  RESPONSE,
  senderActionBody,
  textBody,
} from "./send";
import { type MetaMessagingChannel, parseMetaMessagingWebhook } from "./webhook";

/**
 * Reads a file of an outbound media message from our private storage. Injected by the app
 * (it knows the object store); the adapter itself never touches storage or the database.
 */
export type MediaReader = (
  connection: ChannelConnectionContext,
  storage: { readonly bucket: string; readonly path: string },
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly fileName: string }>;

export interface MetaMessagingAdapterOptions extends MetaWebhookSecrets {
  readonly graph: GraphClient;
  /**
   * Our Meta app id (`META_APP_ID`). Messenger echoes carry the id of the app that sent the
   * message: ours are skipped, any other is a person replying from Meta's inbox.
   */
  readonly appId?: string | null;
  /** Needed to send media; without it a media message fails with `media_unavailable`. */
  readonly media?: MediaReader;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  /** Largest inbound file downloaded (the pipeline stores at most 25 MB). */
  readonly maxDownloadBytes?: number;
}

export interface MetaMessagingAdapter extends ChannelAdapter {
  readonly channel: MetaMessagingChannel;
}

const HOUR_MS = 3_600_000;

/*
 * Capabilities checked against Meta's docs (2026-11-12). Messenger: text up to 2,000
 * characters. Instagram: 1,000 bytes; the pipeline splits at 900 characters and the adapter
 * trims the rare longer text in bytes. Both: up to 13 quick replies of 20 characters, typing
 * and seen indicators, images, audio, video and files out and in, delivery and read
 * statuses, a 24-hour standard window and seven days for a person's reply with the
 * HUMAN_AGENT tag.
 */
export const MESSENGER_CAPABILITIES: ChannelCapabilities = {
  ...CHANNEL_CAPABILITIES.messenger,
  outboundMedia: ["image", "audio", "video", "file"],
};
export const INSTAGRAM_CAPABILITIES: ChannelCapabilities = {
  ...CHANNEL_CAPABILITIES.instagram,
  maxTextLength: 900,
  outboundMedia: ["image", "audio", "video", "file"],
};

const SendResponse = z.object({ message_id: z.string().min(1) }).passthrough();

const DEFAULT_MAX_DOWNLOAD = 25 * 1024 * 1024;

function failure(
  code: string,
  message: string,
  extra: { retryable?: boolean; retryAfterSeconds?: number | null; windowClosed?: boolean } = {},
): SendResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: extra.retryable ?? false,
      retryAfterSeconds: extra.retryAfterSeconds ?? null,
      windowClosed: extra.windowClosed ?? false,
    },
  };
}

/** A Graph failure as the pipeline's `SendFailure` ("meta_10_2018278"). */
export function sendFailureOf(error: GraphApiError): SendResult {
  const code = error.subcode === null ? error.slug : `${error.slug}_${error.subcode}`;
  return failure(code, error.message, {
    retryable: error.classification.retryable,
    retryAfterSeconds: error.classification.retryAfterSeconds,
    windowClosed: error.classification.windowClosed,
  });
}

/**
 * The messaging type of one send. The bot always answers inside the standard window (the
 * pipeline refuses to send otherwise, invariant I6). A person's reply after the standard
 * window has closed goes out with the HUMAN_AGENT tag, which allows seven days.
 */
export function messagingTypeFor(target: SendTarget, now: Date): MessagingType {
  if (!target.sentByHuman) return RESPONSE;
  let standardOpen = target.standardWindowOpen;
  if (standardOpen === undefined) {
    const policy = CHANNEL_CAPABILITIES.messenger.messagingWindow;
    const closesAt = target.window.closesAt === null ? null : Date.parse(target.window.closesAt);
    standardOpen =
      closesAt !== null &&
      now.getTime() < closesAt - (policy.humanAgentHours - policy.hours) * HOUR_MS;
  }
  return standardOpen ? RESPONSE : HUMAN_AGENT_TAG;
}

export function createMetaMessagingAdapter(
  channel: MetaMessagingChannel,
  options: MetaMessagingAdapterOptions,
): MetaMessagingAdapter {
  const { graph } = options;
  const clock = options.clock ?? (() => new Date());
  const maxDownload = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD;
  const appId = options.appId ?? null;
  const log = options.logger?.child({ channel });

  function access(
    connection: ChannelConnectionContext,
  ): { readonly token: string; readonly pageId: string } | null {
    const credentials = MetaPageCredentials.safeParse(connection.credentials);
    if (!credentials.success) return null;
    if (channel === "messenger") {
      return { token: credentials.data.pageAccessToken, pageId: connection.externalAccountId };
    }
    const config = MetaPageConfig.safeParse(connection.config);
    if (!config.success) return null;
    return { token: credentials.data.pageAccessToken, pageId: config.data.pageId };
  }

  async function post(pageId: string, token: string, body: Record<string, unknown>) {
    return graph.request(
      { method: "POST", path: `/${pageId}/messages`, token, json: body },
      SendResponse,
    );
  }

  async function sendOne(
    message: OutboundMessage,
    target: SendTarget,
    page: { readonly token: string; readonly pageId: string },
  ): Promise<SendResult> {
    const type = messagingTypeFor(target, clock());
    const metadata = `${SEND_METADATA_PREFIX}${target.idempotencyKey}`.slice(0, 1000);
    const recipient = target.recipientExternalId;
    switch (message.kind) {
      case "text": {
        // Taken before the request: Meta's timestamp of the message (which delivery and read
        // watermarks are compared with) lies between the request and its answer.
        const sentAt = clock().toISOString();
        const response = await post(
          page.pageId,
          page.token,
          textBody(channel, message, recipient, type, metadata),
        );
        return { ok: true, externalMessageId: response.message_id, sentAt };
      }
      case "media": {
        if (options.media === undefined) {
          return failure("media_unavailable", "Media cannot be sent from this deployment.");
        }
        const file = await options.media(target.connection, message.storage);
        if (file.bytes.byteLength > MEDIA_LIMITS[message.mediaKind]) {
          return failure("media_too_large", `The file is larger than ${channel} accepts.`);
        }
        const attachmentId = await uploadMessageAttachment(graph, {
          pageId: page.pageId,
          token: page.token,
          platform: channel,
          type: message.mediaKind,
          bytes: file.bytes,
          mimeType: message.mimeType,
          fileName: file.fileName,
        });
        const sentAt = clock().toISOString();
        const response = await post(
          page.pageId,
          page.token,
          attachmentBody(message.mediaKind, attachmentId, recipient, type, metadata),
        );
        // An attachment has no caption on these platforms: the words follow as a second
        // message. The attachment went out; a failing caption must not send it again.
        const caption = message.caption?.trim() ?? "";
        if (caption.length > 0) {
          try {
            await post(
              page.pageId,
              page.token,
              textBody(
                channel,
                { kind: "text", text: fitText(caption, channel) },
                recipient,
                type,
                metadata,
              ),
            );
          } catch (error) {
            log?.warn("meta.caption_failed", {
              businessId: target.connection.businessId,
              connectionId: target.connection.connectionId,
              graphCode: error instanceof GraphApiError ? error.graphCode : null,
            });
          }
        }
        return { ok: true, externalMessageId: response.message_id, sentAt };
      }
      case "template":
        return failure("unsupported_message", `${channel} has no message templates.`);
      case "email":
        return failure("unsupported_message", `${channel} cannot send an email.`);
    }
  }

  async function senderAction(
    target: SendTarget,
    action: "typing_on" | "typing_off" | "mark_seen",
  ): Promise<void> {
    const page = access(target.connection);
    if (page === null) return;
    await graph.request({
      method: "POST",
      path: `/${page.pageId}/messages`,
      token: page.token,
      json: senderActionBody(target.recipientExternalId, action),
    });
  }

  return {
    channel,
    capabilities: channel === "messenger" ? MESSENGER_CAPABILITIES : INSTAGRAM_CAPABILITIES,

    verifyWebhook(request: WebhookRequest) {
      return Promise.resolve(verifyMetaWebhook(request, options));
    },

    async parseWebhook(request: WebhookRequest) {
      await Promise.resolve();
      return parseMetaMessagingWebhook(request.rawBody, { channel, appId, now: clock() });
    },

    async send(message, target) {
      const page = access(target.connection);
      if (page === null) {
        return failure("missing_credentials", "The connection has no stored Page token.");
      }
      try {
        return await sendOne(message, target, page);
      } catch (error) {
        if (error instanceof GraphApiError) {
          const { classification } = error;
          if (classification.authFailed || classification.threadControlled) {
            log?.warn("meta.send_refused", {
              businessId: target.connection.businessId,
              connectionId: target.connection.connectionId,
              graphCode: error.graphCode,
              subcode: error.subcode,
              threadControlled: classification.threadControlled,
            });
          }
          return sendFailureOf(error);
        }
        if (error instanceof AppError && !error.retryable) {
          return failure(error.code, error.message);
        }
        throw error;
      }
    },

    async markRead(target) {
      await senderAction(target, "mark_seen");
    },

    async sendTyping(target, state) {
      await senderAction(target, state === "on" ? "typing_on" : "typing_off");
    },

    async fetchAttachment(_connection, source: AttachmentSource) {
      if (source.type !== "url") {
        throw new ValidationError(`${channel} attachments are fetched by their link.`);
      }
      // Signed links on Meta's CDN: no token is sent, and only Meta's hosts are fetched
      // (every redirect too). An expired link is a permanent failure.
      try {
        return await graph.download(source.url, null, { maxBytes: maxDownload });
      } catch (error) {
        if (
          error instanceof GraphApiError &&
          error.httpStatus !== null &&
          error.httpStatus >= 400 &&
          error.httpStatus < 500 &&
          error.httpStatus !== 429
        ) {
          throw new AppError("not_found", "The attachment link has expired.", {
            retryable: false,
          });
        }
        throw error;
      }
    },
  };
}

export function createMessengerAdapter(options: MetaMessagingAdapterOptions): MetaMessagingAdapter {
  return createMetaMessagingAdapter("messenger", options);
}

export function createInstagramAdapter(options: MetaMessagingAdapterOptions): MetaMessagingAdapter {
  return createMetaMessagingAdapter("instagram", options);
}
