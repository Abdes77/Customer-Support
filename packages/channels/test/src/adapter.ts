import {
  CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type ChannelCapabilities,
  type NormalizedInboundMessage,
  type ParsedWebhook,
  ValidationError,
} from "@repo/core";

import { MemoryTestTransport, type TestChannelTransport } from "./transport";
import { TestWebhookBody, verifyTestWebhook } from "./webhook";

export interface TestChannelAdapterOptions {
  /**
   * Signs and verifies webhooks. The adapter receives it at construction: adapters never read
   * the environment at call time (ARCHITECTURE §7).
   */
  readonly secret: string;
  readonly transport?: TestChannelTransport;
  readonly now?: () => Date;
}

export interface TestChannelAdapter extends ChannelAdapter {
  readonly transport: TestChannelTransport;
}

function emptyMessage(
  accountId: string,
  fields: Pick<NormalizedInboundMessage, "externalMessageId" | "sender" | "sentAt" | "kind">,
): NormalizedInboundMessage {
  return {
    channel: "test",
    externalAccountId: accountId,
    externalThreadId: null,
    text: null,
    attachments: [],
    location: null,
    interactiveReply: null,
    reaction: null,
    replyToExternalMessageId: null,
    email: null,
    metadata: {},
    ...fields,
  };
}

/**
 * The "test" channel: a real adapter with no provider behind it. It backs the dev chat page,
 * the onboarding wizard's test chat (C15) and the pipeline tests, and goes through exactly
 * the same webhook, storage, reply and send path as every other channel.
 */
export function createTestChannelAdapter(options: TestChannelAdapterOptions): TestChannelAdapter {
  if (options.secret.length < 16) {
    throw new ValidationError("The test channel secret must be at least 16 characters.");
  }
  const now = options.now ?? (() => new Date());
  const transport = options.transport ?? new MemoryTestTransport(now);
  const capabilities: ChannelCapabilities = CHANNEL_CAPABILITIES.test;

  return {
    channel: "test",
    capabilities,
    transport,

    async verifyWebhook(request) {
      return verifyTestWebhook(request, options.secret, now());
    },

    async parseWebhook(request): Promise<ParsedWebhook> {
      let json: unknown;
      try {
        json = JSON.parse(request.rawBody);
      } catch {
        throw new ValidationError("The test webhook body is not JSON.");
      }
      const parsed = TestWebhookBody.safeParse(json);
      if (!parsed.success) {
        throw new ValidationError("The test webhook body does not match its schema.", {
          details: { paths: parsed.error.issues.map((issue) => issue.path.join(".")) },
        });
      }
      const { accountId, events } = parsed.data;
      const result: {
        messages: NormalizedInboundMessage[];
        statuses: ParsedWebhook["statuses"][number][];
        signals: ParsedWebhook["signals"][number][];
      } = { messages: [], statuses: [], signals: [] };

      for (const event of events) {
        switch (event.type) {
          case "message": {
            const hasText = event.text !== null && event.text.trim().length > 0;
            result.messages.push({
              ...emptyMessage(accountId, {
                externalMessageId: event.id,
                sender: {
                  externalId: event.from.id,
                  displayName: event.from.name,
                  phone: event.from.phone,
                  email: event.from.email,
                },
                sentAt: event.sentAt,
                kind: event.attachments.length > 0 && !hasText ? "media" : "text",
              }),
              text: event.text,
              attachments: event.attachments,
              replyToExternalMessageId: event.replyTo,
            });
            break;
          }
          case "reaction":
            result.messages.push({
              ...emptyMessage(accountId, {
                externalMessageId: event.id,
                sender: {
                  externalId: event.from.id,
                  displayName: event.from.name,
                  phone: event.from.phone,
                  email: event.from.email,
                },
                sentAt: event.sentAt,
                kind: "reaction",
              }),
              reaction: {
                targetExternalMessageId: event.targetMessageId,
                emoji: event.emoji,
                removed: event.removed,
              },
            });
            break;
          case "status":
            result.statuses.push({
              channel: "test",
              externalAccountId: accountId,
              externalMessageId: event.messageId,
              status: event.status,
              occurredAt: event.occurredAt,
              error: event.error,
            });
            break;
          case "human_reply":
            result.signals.push({
              type: "human_agent_replied",
              channel: "test",
              externalAccountId: accountId,
              contactExternalId: event.contactId,
              externalMessageId: event.messageId,
              text: event.text,
              occurredAt: event.occurredAt,
            });
            break;
          case "revoked":
            result.signals.push({
              type: "connection_revoked",
              channel: "test",
              externalAccountId: accountId,
              reason: event.reason,
              occurredAt: event.occurredAt,
            });
            break;
        }
      }
      return result;
    },

    async send(message, target) {
      return transport.deliver({
        connectionId: target.connection.connectionId,
        conversationId: target.conversationId,
        recipientExternalId: target.recipientExternalId,
        message,
        idempotencyKey: target.idempotencyKey,
        sentByHuman: target.sentByHuman,
      });
    },

    async sendTyping(target, state) {
      await transport.signal({
        type: state === "on" ? "typing_on" : "typing_off",
        conversationId: target.conversationId,
        externalMessageId: null,
        at: now().toISOString(),
      });
    },

    async markRead(target, externalMessageId) {
      await transport.signal({
        type: "read",
        conversationId: target.conversationId,
        externalMessageId,
        at: now().toISOString(),
      });
    },

    async fetchAttachment(_connection, source) {
      if (source.type !== "provider_media") {
        throw new ValidationError(`The test channel cannot download a "${source.type}" source.`);
      }
      return transport.fetchMedia(source.mediaId);
    },
  };
}
