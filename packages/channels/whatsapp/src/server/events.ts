import type { ChannelSignal } from "@repo/core";
import { and, channelConnections, eq, isNull, lte, or, sql } from "@repo/db";

import { WhatsAppConfig } from "../credentials";
import type { WhatsAppServerDeps } from "./deps";
import { createTemplateService } from "./templates";

type ProviderEvent = Extract<ChannelSignal, { type: "provider_event" }>;

/**
 * Account events that mean the business took our access away or the account is gone
 * (account_update reference, read 2026-11-12). DISABLED_UPDATE counts only when its
 * `ban_info.waba_ban_state` is DISABLE: the same event also announces SCHEDULE_FOR_DISABLE
 * and REINSTATE.
 */
const REVOKING_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_DELETED", "PARTNER_APP_UNINSTALLED"]);

export function revokesAccess(event: string, banState: string | null): boolean {
  if (REVOKING_EVENTS.has(event)) return true;
  return event === "DISABLED_UPDATE" && banState === "DISABLE";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** "+1 555-010-0000" and "15550100000" alike, for comparing display numbers. */
function digitsOf(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Handles WhatsApp's account-level webhooks, which name the WhatsApp Business Account
 * rather than a number: template status changes (kept on every connection of the account),
 * the business removing the app (every connection revoked) and quality rating changes (kept
 * on the connection for the admin panel). Matches the pipeline's `ProviderEventHandler`.
 */
export function createWhatsAppEventHandler(deps: WhatsAppServerDeps) {
  const templates = createTemplateService(deps);
  const log = deps.logger.child({ component: "whatsapp-events" });

  return {
    channel: "whatsapp" as const,
    async handle(signal: ProviderEvent): Promise<boolean> {
      const connections = await deps.db.directory.findChannelConnectionsByBusinessAccount(
        "whatsapp",
        signal.externalAccountId,
      );
      if (connections.length === 0) {
        log.info("whatsapp.event_unknown_account", { event: signal.event });
        return false;
      }
      let changed = false;
      for (const ref of connections) {
        const scope = deps.db.forBusiness(ref.businessId, { agencyId: ref.agencyId });
        switch (signal.event) {
          case "template_status": {
            const name = text(signal.data["name"]);
            const language = text(signal.data["language"]);
            const status = text(signal.data["status"]);
            if (name === null || language === null || status === null) break;
            const updated = await scope.run((ctx) =>
              templates.applyStatus(ctx, ref.connectionId, {
                templateId: text(signal.data["templateId"]),
                name,
                language,
                status,
                reason: text(signal.data["reason"]),
              }),
            );
            changed ||= updated;
            break;
          }
          case "account_update": {
            const event = text(signal.data["event"]);
            if (event === null || !revokesAccess(event, text(signal.data["banState"]))) break;
            const at = new Date(signal.occurredAt);
            const revoked = await scope.run(async (ctx) =>
              ctx.tx
                .update(channelConnections)
                .set({
                  status: "revoked",
                  lastError: `WhatsApp reported ${event}: the business removed access.`,
                  lastErrorAt: at,
                })
                .where(
                  and(
                    eq(channelConnections.id, ref.connectionId),
                    // Meta redelivers webhooks for days: a removal from before the number was
                    // (re)connected must not switch the new connection off.
                    or(
                      isNull(channelConnections.connectedAt),
                      lte(channelConnections.connectedAt, at),
                    ),
                  ),
                )
                .returning({ id: channelConnections.id }),
            );
            if (revoked.length === 0) {
              log.info("whatsapp.stale_account_event", { businessId: ref.businessId, event });
              break;
            }
            log.warn("channel.connection_revoked", {
              businessId: ref.businessId,
              connectionId: ref.connectionId,
              channel: "whatsapp",
              event,
            });
            changed = true;
            break;
          }
          case "phone_quality": {
            const event = text(signal.data["event"]);
            if (event === null) break;
            const quality = JSON.stringify({
              qualityEvent: event,
              qualityEventAt: signal.occurredAt,
              ...(text(signal.data["currentLimit"]) === null
                ? {}
                : { messagingLimit: text(signal.data["currentLimit"]) }),
            });
            // The event names one number of the account; an account can hold numbers of
            // several businesses, so only the connection of that number takes it.
            const named = digitsOf(text(signal.data["displayPhoneNumber"]));
            const updated = await scope.run(async (ctx) => {
              const [row] = await ctx.tx
                .select({ config: channelConnections.config })
                .from(channelConnections)
                .where(eq(channelConnections.id, ref.connectionId))
                .limit(1);
              const config = WhatsAppConfig.safeParse(row?.config);
              const own = config.success ? digitsOf(config.data.displayPhoneNumber) : null;
              if (named !== null && own !== named) return false;
              await ctx.tx
                .update(channelConnections)
                .set({ state: sql`${channelConnections.state} || ${quality}::jsonb` })
                .where(eq(channelConnections.id, ref.connectionId));
              return true;
            });
            changed ||= updated;
            break;
          }
          default:
            break;
        }
      }
      return changed;
    },
  };
}
