import type { ChannelSignal } from "@repo/core";
import { and, channelConnections, eq, isNull, lte, or, sql } from "@repo/db";

import type { MetaMessagingChannel } from "../webhook";
import type { MetaPagesServerDeps } from "./deps";

type ProviderEvent = Extract<ChannelSignal, { type: "provider_event" }>;

/** The marker a Meta block leaves in `last_error`, so an unblock clears only its own. */
export const POLICY_BLOCK_PREFIX = "Meta blocked messaging for this account";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Handles the account-level events of Messenger or Instagram (`messaging_policy_enforcement`,
 * read 2026-11-12: `warning`, `block`, `unblock`). The event names one Page or account and
 * only the connection of that account changes: a block marks it `error` with Meta's reason
 * for the admin panel (messages are still stored), an unblock clears what a block set, a
 * warning is kept in `state`. An event from before the connection was (re)connected is
 * ignored: Meta redelivers webhooks for a long time. Matches the pipeline's
 * `ProviderEventHandler`.
 */
export function createMetaPagesEventHandler(
  deps: MetaPagesServerDeps,
  channel: MetaMessagingChannel,
) {
  const log = deps.logger.child({ component: "meta-pages-events", channel });

  return {
    channel,
    async handle(signal: ProviderEvent): Promise<boolean> {
      if (signal.event !== "policy_enforcement") return false;
      const action = text(signal.data["action"]);
      if (action === null) return false;
      const ref = await deps.db.directory.findChannelConnection(channel, signal.externalAccountId);
      if (ref === null) {
        log.info("meta_pages.event_unknown_account", { event: signal.event });
        return false;
      }
      const at = new Date(signal.occurredAt);
      const notStale = or(
        isNull(channelConnections.connectedAt),
        lte(channelConnections.connectedAt, at),
      );
      const policy = JSON.stringify({ policy: { action, at: signal.occurredAt } });
      const changed = await deps.db
        .forBusiness(ref.businessId, { agencyId: ref.agencyId })
        .run(async (ctx) => {
          const base = and(eq(channelConnections.id, ref.connectionId), notStale);
          if (action === "block") {
            const reason = text(signal.data["reason"]);
            return ctx.tx
              .update(channelConnections)
              .set({
                status: "error",
                lastError: `${POLICY_BLOCK_PREFIX}${reason === null ? "." : `: ${reason}`}`.slice(
                  0,
                  500,
                ),
                lastErrorAt: at,
                state: sql`${channelConnections.state} || ${policy}::jsonb`,
              })
              .where(and(base, eq(channelConnections.status, "active")))
              .returning({ id: channelConnections.id });
          }
          if (action === "unblock") {
            return ctx.tx
              .update(channelConnections)
              .set({
                status: "active",
                lastError: null,
                lastErrorAt: null,
                state: sql`${channelConnections.state} || ${policy}::jsonb`,
              })
              .where(
                and(
                  base,
                  eq(channelConnections.status, "error"),
                  sql`${channelConnections.lastError} like ${`${POLICY_BLOCK_PREFIX}%`}`,
                ),
              )
              .returning({ id: channelConnections.id });
          }
          return ctx.tx
            .update(channelConnections)
            .set({ state: sql`${channelConnections.state} || ${policy}::jsonb` })
            .where(base)
            .returning({ id: channelConnections.id });
        });
      if (changed.length === 0) {
        log.info("meta_pages.event_not_applied", { businessId: ref.businessId, action });
        return false;
      }
      log.warn("meta_pages.policy_enforcement", {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        action,
      });
      return true;
    },
  };
}
