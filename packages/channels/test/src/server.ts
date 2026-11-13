import type { BusinessId, ChannelConnectionId, ConversationId, MessageId } from "@repo/core";
import {
  and,
  asc,
  type BusinessContext,
  channelConnections,
  contactIdentities,
  conversations,
  type DbContext,
  desc,
  eq,
  messages,
} from "@repo/db";

import { testAccountIdFor } from "./webhook";

/**
 * The business's test-channel connection, created on first use. The test channel has no
 * provider account to prove control of: its account id is derived from the business id, so
 * creating it cannot claim anyone else's messages. Call it in the business's system scope
 * after checking that the user may act for the business.
 */
export async function ensureTestConnection(
  ctx: BusinessContext,
  now: Date = new Date(),
): Promise<{ readonly connectionId: ChannelConnectionId; readonly accountId: string }> {
  const accountId = testAccountIdFor(ctx.tenant.businessId);
  await ctx.tx
    .insert(channelConnections)
    .values({
      ...ctx.tenant,
      channel: "test",
      externalAccountId: accountId,
      displayName: "Test channel",
      status: "active",
      connectedAt: now,
    })
    .onConflictDoNothing();
  const [row] = await ctx.tx
    .select({ id: channelConnections.id, status: channelConnections.status })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, "test"),
        eq(channelConnections.externalAccountId, accountId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new Error("The test connection could not be created.");
  if (row.status !== "active") {
    await ctx.tx
      .update(channelConnections)
      .set({ status: "active", lastError: null, lastErrorAt: null })
      .where(eq(channelConnections.id, row.id));
  }
  return { connectionId: row.id, accountId };
}

export interface TestChatMessage {
  readonly id: MessageId;
  readonly author: "customer" | "bot" | "human_agent";
  readonly text: string | null;
  readonly status: string;
  readonly sequence: number;
  readonly at: string;
}

export interface TestChatView {
  readonly conversationId: ConversationId | null;
  readonly messages: readonly TestChatMessage[];
}

/**
 * The latest test-channel conversation of one visitor, for the dev chat page. Takes any
 * database context; with a user context, row-level security decides what is visible.
 */
export async function loadTestChat(
  ctx: DbContext,
  query: { readonly businessId: BusinessId; readonly visitorId: string },
): Promise<TestChatView> {
  const [identity] = await ctx.tx
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.businessId, query.businessId),
        eq(contactIdentities.channel, "test"),
        eq(contactIdentities.externalId, query.visitorId),
      ),
    )
    .limit(1);
  if (identity === undefined) return { conversationId: null, messages: [] };
  const [conversation] = await ctx.tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, query.businessId),
        eq(conversations.contactId, identity.contactId),
        eq(conversations.channel, "test"),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (conversation === undefined) return { conversationId: null, messages: [] };
  const rows = await ctx.tx
    .select({
      id: messages.id,
      author: messages.author,
      text: messages.text,
      status: messages.status,
      sequence: messages.sequence,
      createdAt: messages.createdAt,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.sequence))
    .limit(500);
  return {
    conversationId: conversation.id,
    messages: rows.map((row) => ({
      id: row.id,
      author: row.author,
      text: row.text,
      status: row.status,
      sequence: row.sequence,
      at: (row.sentAt ?? row.createdAt).toISOString(),
    })),
  };
}
