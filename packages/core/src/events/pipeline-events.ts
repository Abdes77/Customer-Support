import { z } from "zod";

import { ChannelId } from "../contracts/channel";
import {
  AgencyId,
  BusinessId,
  ConversationId,
  IsoDateTime,
  MessageId,
  TraceId,
  UserId,
} from "../ids";

/**
 * Message pipeline events (owner: C3). Same rules as lead events: ids only, at-least-once
 * delivery, consumers must be idempotent.
 */
const PipelineEventBase = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  conversationId: ConversationId,
});

/** An inbound customer message was stored. Triggers the debounced reply function. */
export const MessageReceivedEvent = PipelineEventBase.extend({
  messageId: MessageId,
  channel: ChannelId,
  receivedAt: IsoDateTime,
});
export type MessageReceivedEvent = z.infer<typeof MessageReceivedEvent>;

/** An outbound message is stored with status "queued" and must be sent. */
export const MessageSendRequestedEvent = PipelineEventBase.extend({
  messageId: MessageId,
  channel: ChannelId,
});
export type MessageSendRequestedEvent = z.infer<typeof MessageSendRequestedEvent>;

/** Sending failed after every retry. Raises an alert and shows in the admin panel. */
export const MessageSendFailedEvent = PipelineEventBase.extend({
  messageId: MessageId,
  channel: ChannelId,
  errorCode: z.string().min(1),
});
export type MessageSendFailedEvent = z.infer<typeof MessageSendFailedEvent>;

/** A person took over the conversation. The bot stays silent until release. */
export const ConversationTakeoverStartedEvent = PipelineEventBase.extend({
  /** Null when the takeover was detected from the provider's own inbox. */
  userId: UserId.nullable(),
  source: z.enum(["admin_panel", "provider_inbox", "rule"]),
});
export type ConversationTakeoverStartedEvent = z.infer<typeof ConversationTakeoverStartedEvent>;

/** The conversation was given back to the bot. */
export const ConversationTakeoverReleasedEvent = PipelineEventBase.extend({
  userId: UserId.nullable(),
  source: z.enum(["manual", "idle_timeout"]),
});
export type ConversationTakeoverReleasedEvent = z.infer<typeof ConversationTakeoverReleasedEvent>;

export const PIPELINE_EVENTS = {
  "message.received": MessageReceivedEvent,
  "message.send_requested": MessageSendRequestedEvent,
  "message.send_failed": MessageSendFailedEvent,
  "conversation.takeover_started": ConversationTakeoverStartedEvent,
  "conversation.takeover_released": ConversationTakeoverReleasedEvent,
} as const;
