import { conversations, eq, sql } from "@repo/db";

import type { TurnGuard } from "../deps";

interface Ended {
  readonly disposition?: unknown;
}

/**
 * Keeps the bot's word after `end_conversation` (C4):
 *
 * - "stop_replying" (spam, abuse after a warning): no turn runs in this conversation until a
 *   person clears the mark. The customer's messages are still stored and shown in the inbox.
 * - "completed": the conversation had reached its end. A follow-up or a released takeover
 *   does not start it again; a new message from the customer does, and removes the mark.
 */
export const endedConversationGuard: TurnGuard = {
  name: "conversation_ended",
  async check(ctx, facts) {
    const [row] = await ctx.tx
      .select({ metadata: conversations.metadata })
      .from(conversations)
      .where(eq(conversations.id, facts.conversationId))
      .limit(1);
    const ended = row?.metadata["ended"] as Ended | null | undefined;
    if (ended === null || ended === undefined || typeof ended !== "object") return null;
    if (ended.disposition === "stop_replying") return "conversation_ended";
    if (facts.trigger !== "inbound_message") return "conversation_ended";
    await ctx.tx
      .update(conversations)
      .set({ metadata: sql`${conversations.metadata} - 'ended'` })
      .where(eq(conversations.id, facts.conversationId));
    return null;
  },
};
