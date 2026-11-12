import type { ConversationId, TraceId } from "@repo/core";
import { type BusinessContext, conversations, eq, messages, sql } from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";

import { sendEventId } from "./event-ids";

/**
 * Stores a message the bot sends on its own, written by code rather than the engine (C12: a
 * meeting reminder), as the conversation's next outbound message with status `queued`, and
 * returns the `message.send_requested` event to emit once the caller's transaction commits.
 * From there it is an ordinary bot message: the send function orders it after earlier
 * messages, withholds it while a person holds the conversation or after an opt-out, applies
 * the channel's window rules (WhatsApp's template outside 24 hours) and retries it; a lost
 * event is re-emitted by the sweeper. Runs inside the caller's business transaction; the
 * conversation row is locked for the sequence number, as the reply's commit does.
 */
export async function enqueueBotMessage(
  ctx: BusinessContext,
  input: {
    readonly conversationId: string;
    readonly text: string;
    readonly traceId: string;
    /** Why the message exists, kept in its payload ("reminder"). */
    readonly purpose: string;
  },
): Promise<{ readonly messageId: string; readonly events: readonly AnyJobEvent[] } | null> {
  const text = input.text.trim();
  if (text.length === 0) return null;
  const conversationId = input.conversationId as ConversationId;
  const [conversation] = await ctx.tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      connectionId: conversations.channelConnectionId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update")
    .limit(1);
  if (conversation === undefined) return null;
  const [counter] = await ctx.tx
    .update(conversations)
    .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
    .where(eq(conversations.id, conversation.id))
    .returning({ sequence: conversations.messageSeq });
  const [row] = await ctx.tx
    .insert(messages)
    .values({
      ...ctx.tenant,
      conversationId: conversation.id,
      channelConnectionId: conversation.connectionId,
      direction: "outbound",
      author: "bot",
      kind: "text",
      text,
      payload: { purpose: input.purpose },
      sequence: counter!.sequence,
      status: "queued",
      traceId: input.traceId as TraceId,
    })
    .returning({ id: messages.id });
  const messageId = row!.id;
  return {
    messageId,
    events: [
      jobEvent("message.send_requested", sendEventId(messageId), {
        traceId: input.traceId as TraceId,
        agencyId: ctx.tenant.agencyId,
        businessId: ctx.tenant.businessId,
        conversationId: conversation.id,
        messageId: messageId,
        channel: conversation.channel,
      }),
    ],
  };
}
