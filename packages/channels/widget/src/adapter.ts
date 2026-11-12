import {
  CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type ChannelCapabilities,
  type Logger,
  type SendTarget,
  ValidationError,
} from "@repo/core";

import { type WidgetNotifier, type WidgetPokeEvent, visitorTopic } from "./realtime";
import { assertWidgetSecret } from "./token";

export interface WidgetAdapterOptions {
  /** WIDGET_SESSION_SECRET: derives each visitor's broadcast topic. */
  readonly secret: string;
  /** Tells a visitor's browser that something changed. Silent when Realtime is not set up. */
  readonly notifier: WidgetNotifier;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * The website chat channel. Visitors reach the pipeline through the widget API, which calls
 * `ingest()` itself, so there are no webhooks. Sending is a no-op towards any provider: the
 * outbound message is already stored, and the visitor's browser reads it through the API.
 * `send` only pokes the browser so it fetches at once, and reports success (a failed poke
 * costs a few seconds, until the browser's next poll, never the message).
 */
export function createWidgetAdapter(options: WidgetAdapterOptions): ChannelAdapter {
  assertWidgetSecret(options.secret);
  const now = options.now ?? (() => new Date());
  const capabilities: ChannelCapabilities = CHANNEL_CAPABILITIES.widget;

  async function poke(target: SendTarget, event: WidgetPokeEvent): Promise<void> {
    try {
      await options.notifier.notify(
        visitorTopic(options.secret, target.connection.connectionId, target.recipientExternalId),
        event,
      );
    } catch (error) {
      options.logger?.warn("widget.poke_failed", {
        businessId: target.connection.businessId,
        conversationId: target.conversationId,
        event,
        error,
      });
    }
  }

  return {
    channel: "widget",
    capabilities,

    async verifyWebhook() {
      return { outcome: "rejected", reason: "the website chat has no webhooks" };
    },

    async parseWebhook() {
      throw new ValidationError("The website chat has no webhooks.");
    },

    async send(message, target) {
      if (message.kind === "template" || message.kind === "email") {
        return {
          ok: false,
          error: {
            code: "unsupported_kind",
            message: `The website chat cannot send a ${message.kind} message.`,
            retryable: false,
            retryAfterSeconds: null,
            windowClosed: false,
          },
        };
      }
      await poke(target, "message");
      return {
        ok: true,
        // The idempotency key is our own message id and part number: stable across retries.
        externalMessageId: `widget:${target.idempotencyKey}`,
        sentAt: now().toISOString(),
      };
    },

    async sendTyping(target) {
      await poke(target, "typing");
    },
  };
}
