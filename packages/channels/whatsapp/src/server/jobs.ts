import { and, channelConnections, eq, inArray } from "@repo/db";
import { type CronJobDefinition, defineCronJob } from "@repo/jobs";

import type { WhatsAppServerDeps } from "./deps";
import { createTemplateService } from "./templates";

export const TEMPLATE_SYNC_FUNCTION_ID = "whatsapp-template-sync";

/**
 * `whatsapp-template-sync`: every six hours, re-reads the templates of every connected
 * number, in case a status webhook was missed (Meta retries webhooks for seven days, but a
 * template edited in WhatsApp Manager sends none). One step per number; a failing number is
 * logged and the others go on.
 */
export function createWhatsAppJobs(deps: WhatsAppServerDeps): CronJobDefinition[] {
  const templates = createTemplateService(deps);
  const log = deps.logger.child({ component: "whatsapp-jobs" });
  return [
    defineCronJob({
      id: TEMPLATE_SYNC_FUNCTION_ID,
      name: "Sync WhatsApp templates",
      retries: 1,
      trigger: { cron: "17 */6 * * *" },
      handler: async ({ step }) => {
        const list = await step.run("businesses", () => deps.db.directory.listBusinesses());
        let synced = 0;
        for (const business of list) {
          const connections = await step.run(`connections-${business.businessId}`, () =>
            deps.db.forBusiness(business.businessId, { agencyId: business.agencyId }).run((ctx) =>
              ctx.tx
                .select({ id: channelConnections.id })
                .from(channelConnections)
                .where(
                  and(
                    eq(channelConnections.channel, "whatsapp"),
                    inArray(channelConnections.status, ["active", "error"]),
                  ),
                ),
            ),
          );
          for (const connection of connections) {
            synced += await step.run(`sync-${connection.id}`, async () => {
              try {
                return (await templates.sync(business, connection.id)).synced;
              } catch (error) {
                log.warn("whatsapp.template_sync_failed", {
                  businessId: business.businessId,
                  connectionId: connection.id,
                  error,
                });
                return 0;
              }
            });
          }
        }
        return { synced };
      },
    }),
  ];
}
