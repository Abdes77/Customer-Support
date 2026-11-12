import type { ChannelId, ConversationId } from "@repo/core";
import { and, type BusinessContext, conversations, eq, gt, messages, ne } from "@repo/db";
import type { AppResolvedSettings } from "@repo/settings";

/** What the guard reads of a turn (a subset of the pipeline's `TurnFacts`). */
export interface MetaTurnFacts {
  readonly conversationId: ConversationId;
  readonly channel: ChannelId;
  readonly trigger: string;
  readonly settings: AppResolvedSettings;
}

function isStandby(payload: Record<string, unknown>): boolean {
  const metadata = payload["metadata"];
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)["standby"] === true
  );
}

/**
 * Keeps the bot quiet on Messenger and Instagram when every message waiting for an answer is
 * one it should leave alone (matches the pipeline's `TurnGuard`, registered by apps/web):
 *
 * - `story_reply_ignored`: replies to and mentions of the business's Instagram stories, when
 *   `channels.instagram.story_replies` is "ignore" (the team answers them);
 * - `another_app_in_control`: messages Meta delivered on the `standby` channel, because
 *   another app (or Meta's own assistant) controls the conversation and ours may not send.
 *
 * A message among them that asks for an answer in its own right lets the turn run. Only
 * customer messages (not reactions) the conversation has not handled yet are considered.
 */
export const metaChannelGuard = {
  name: "meta_channel",
  async check(ctx: BusinessContext, facts: MetaTurnFacts): Promise<string | null> {
    if (facts.channel !== "instagram" && facts.channel !== "messenger") return null;
    if (facts.trigger !== "inbound_message") return null;
    const [conversation] = await ctx.tx
      .select({ handled: conversations.handledThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, facts.conversationId))
      .limit(1);
    if (conversation === undefined) return null;
    const pending = await ctx.tx
      .select({ kind: messages.kind, payload: messages.payload })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, facts.conversationId),
          eq(messages.direction, "inbound"),
          ne(messages.kind, "reaction"),
          gt(messages.sequence, conversation.handled),
        ),
      );
    if (pending.length === 0) return null;
    if (pending.every((row) => isStandby(row.payload))) return "another_app_in_control";
    const ignoreStories =
      facts.channel === "instagram" &&
      facts.settings.values["channels.instagram.story_replies"] === "ignore";
    if (
      ignoreStories &&
      pending.every((row) => row.kind === "story_reply" || isStandby(row.payload))
    ) {
      return "story_reply_ignored";
    }
    return null;
  },
};
