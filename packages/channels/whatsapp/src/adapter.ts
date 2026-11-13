import { z } from "zod";

import {
  AppError,
  type AttachmentKind,
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
  downloadMedia,
  GraphApiError,
  type GraphClient,
  type MetaWebhookSecrets,
  uploadMedia,
  verifyMetaWebhook,
} from "@repo/channel-meta";

import { WhatsAppCredentials } from "./credentials";
import { mediaBody, MEDIA_LIMITS, readBody, recipientOf, templateBody, textBody } from "./send";
import { parseWhatsAppWebhook } from "./webhook";

/**
 * Reads a file of an outbound media message from our private storage. Injected by the app
 * (it knows the object store); the adapter itself never touches storage or the database.
 */
export type MediaReader = (
  connection: ChannelConnectionContext,
  storage: { readonly bucket: string; readonly path: string },
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly fileName: string }>;

export interface WhatsAppAdapterOptions extends MetaWebhookSecrets {
  readonly graph: GraphClient;
  /** Needed to send media; without it a media message fails with `media_unavailable`. */
  readonly media?: MediaReader;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  /** Largest inbound file downloaded (the pipeline stores at most 25 MB). */
  readonly maxDownloadBytes?: number;
}

export interface WhatsAppAdapter extends ChannelAdapter {
  readonly channel: "whatsapp";
}

/**
 * The capabilities checked against Meta's docs (2026-11-12): text up to 4,096 characters;
 * three reply buttons of 20 characters (lists of ten rows are used by the adapter when more
 * options come); typing indicator and read receipts; delivery statuses; the 24-hour
 * customer-service window, after which only approved templates may be sent.
 */
export const WHATSAPP_CAPABILITIES: ChannelCapabilities = CHANNEL_CAPABILITIES.whatsapp;

const SendResponse = z.object({
  messages: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1),
});

const DEFAULT_MAX_DOWNLOAD = 25 * 1024 * 1024;

function credentialsOf(connection: ChannelConnectionContext): WhatsAppCredentials | null {
  const parsed = WhatsAppCredentials.safeParse(connection.credentials);
  return parsed.success ? parsed.data : null;
}

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

/** A Graph failure as the pipeline's `SendFailure`. */
export function sendFailureOf(error: GraphApiError): SendResult {
  return failure(error.slug, error.message, {
    retryable: error.classification.retryable,
    retryAfterSeconds: error.classification.retryAfterSeconds,
    windowClosed: error.classification.windowClosed,
  });
}

export function createWhatsAppAdapter(options: WhatsAppAdapterOptions): WhatsAppAdapter {
  const { graph } = options;
  const clock = options.clock ?? (() => new Date());
  const maxDownload = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD;

  async function post(
    target: SendTarget,
    token: string,
    body: Record<string, unknown>,
  ): Promise<SendResult> {
    const response = await graph.request(
      {
        method: "POST",
        path: `/${target.connection.externalAccountId}/messages`,
        token,
        json: body,
      },
      SendResponse,
    );
    return { ok: true, externalMessageId: response.messages[0]!.id, sentAt: clock().toISOString() };
  }

  async function bodyFor(
    message: OutboundMessage,
    target: SendTarget,
    token: string,
  ): Promise<Record<string, unknown> | SendResult> {
    const recipient = recipientOf(target.recipientExternalId);
    const replyTo = target.replyToExternalMessageId;
    switch (message.kind) {
      case "text":
        return textBody(message, recipient, replyTo);
      case "template":
        return templateBody(message, recipient);
      case "media": {
        if (options.media === undefined) {
          return failure("media_unavailable", "Media cannot be sent from this deployment.");
        }
        const file = await options.media(target.connection, message.storage);
        const kind: AttachmentKind = message.mediaKind;
        if (file.bytes.byteLength > MEDIA_LIMITS[kind]) {
          return failure(
            "media_too_large",
            `The file is larger than WhatsApp accepts for ${kind}.`,
          );
        }
        const mediaId = await uploadMedia(graph, {
          phoneNumberId: target.connection.externalAccountId,
          token,
          bytes: file.bytes,
          mimeType: message.mimeType,
          fileName: file.fileName,
        });
        return mediaBody(kind, mediaId, message.caption, file.fileName, recipient, replyTo);
      }
      case "email":
        return failure("unsupported_message", "WhatsApp cannot send an email.");
    }
  }

  return {
    channel: "whatsapp",
    capabilities: WHATSAPP_CAPABILITIES,

    verifyWebhook(request: WebhookRequest) {
      return Promise.resolve(verifyMetaWebhook(request, options));
    },

    async parseWebhook(request: WebhookRequest) {
      await Promise.resolve();
      return parseWhatsAppWebhook(request.rawBody, clock());
    },

    async send(message, target) {
      const credentials = credentialsOf(target.connection);
      if (credentials === null) {
        return failure("missing_credentials", "The WhatsApp number has no stored token.");
      }
      try {
        const body = await bodyFor(message, target, credentials.accessToken);
        if ("ok" in body) return body as SendResult;
        return await post(target, credentials.accessToken, body);
      } catch (error) {
        if (error instanceof GraphApiError) {
          if (error.classification.authFailed) {
            options.logger?.warn("whatsapp.auth_failed", {
              businessId: target.connection.businessId,
              connectionId: target.connection.connectionId,
              graphCode: error.graphCode,
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

    async markRead(target, externalMessageId) {
      const credentials = credentialsOf(target.connection);
      if (credentials === null) return;
      await graph.request({
        method: "POST",
        path: `/${target.connection.externalAccountId}/messages`,
        token: credentials.accessToken,
        json: readBody(externalMessageId, false),
      });
    },

    async sendTyping(target, state) {
      // The indicator is tied to the customer's newest message and stops by itself when the
      // reply is sent (or after 25 seconds); there is nothing to switch off.
      const messageId = target.replyToExternalMessageId;
      const credentials = credentialsOf(target.connection);
      if (state === "off" || messageId === null || credentials === null) return;
      await graph.request({
        method: "POST",
        path: `/${target.connection.externalAccountId}/messages`,
        token: credentials.accessToken,
        json: readBody(messageId, true),
      });
    },

    async fetchAttachment(connection, source: AttachmentSource) {
      if (source.type !== "provider_media") {
        throw new ValidationError("WhatsApp attachments are fetched by media id.");
      }
      const credentials = credentialsOf(connection);
      if (credentials === null) {
        throw new AppError("config_missing", "The WhatsApp number has no stored token.", {
          retryable: false,
        });
      }
      return downloadMedia(graph, {
        mediaId: source.mediaId,
        token: credentials.accessToken,
        maxBytes: maxDownload,
        phoneNumberId: connection.externalAccountId,
      });
    },
  };
}
