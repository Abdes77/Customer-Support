import type { EventPayload, Logger, SendTarget } from "@repo/core";
import { loadSettings } from "@repo/settings/server";

import { loadConnectionContext } from "../connection";
import type { PipelineContext } from "../deps";
import type { ClaimedTurn } from "./claim";

type ReceivedData = EventPayload<"message.received">;

/**
 * Read receipt and typing indicator around a turn, where the channel supports them and the
 * settings (`conversation.mark_as_read`, `conversation.typing_indicator`) want them.
 * Best effort: a failure is logged and the turn goes on.
 */
export async function showPresence(
  p: PipelineContext,
  data: ReceivedData,
  claim: ClaimedTurn,
  state: "on" | "off",
  logger: Logger,
): Promise<null> {
  const adapter = p.adapters.find(claim.channel);
  if (adapter === undefined || claim.contactExternalId === null) return null;
  try {
    const prepared = await p.db
      .forBusiness(data.businessId, { agencyId: data.agencyId })
      .run(async (ctx) => {
        const settings = await loadSettings(ctx, ctx.tenant);
        const read =
          state === "on" &&
          settings.values["conversation.mark_as_read"] &&
          adapter.capabilities.readReceipts &&
          adapter.markRead !== undefined &&
          claim.latestExternalMessageId !== null;
        const typing =
          settings.values["conversation.typing_indicator"] &&
          adapter.capabilities.typingIndicator &&
          adapter.sendTyping !== undefined;
        if (!read && !typing) return null;
        const connection = await loadConnectionContext(ctx, p.db, claim.connectionId);
        return { read, typing, connection };
      });
    if (prepared === null) return null;
    const target: SendTarget = {
      connection: prepared.connection,
      conversationId: data.conversationId,
      recipientExternalId: claim.contactExternalId,
      externalThreadId: null,
      // The customer's newest message: WhatsApp shows typing on it (C9).
      replyToExternalMessageId: claim.latestExternalMessageId,
      window: { open: true, closesAt: null },
      email: null,
      idempotencyKey: `${claim.turnId}:presence:${state}`,
      sentByHuman: false,
    };
    if (prepared.read && claim.latestExternalMessageId !== null) {
      await adapter.markRead?.(target, claim.latestExternalMessageId);
    }
    if (prepared.typing) await adapter.sendTyping?.(target, state);
  } catch (error) {
    logger.warn("turn.presence_failed", { state, error });
  }
  return null;
}
