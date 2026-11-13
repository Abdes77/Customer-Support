import type { Logger } from "@repo/core";
import type { Database } from "@repo/db";
import {
  type CronJobDefinition,
  defineCronJob,
  describeJobError,
  type EventSender,
} from "@repo/jobs";

import { dispatchLeadEvents } from "./store/outbox";

export const OUTBOX_FUNCTION_ID = "leads-outbox";

/** Events younger than this are left to the turn that wrote them. */
export const OUTBOX_GRACE_MS = 2 * 60_000;

/**
 * `leads-outbox` (cron, every minute): sends the lead events that a turn wrote but did not
 * send, because the turn failed after an action handler ran or the process died between the
 * commit and the emit step. One step per business; one business's failure is logged and
 * the others go on (the next run tries again).
 */
export function createLeadJobs(deps: {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}): CronJobDefinition[] {
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger.child({ component: "leads-outbox" });
  return [
    defineCronJob({
      id: OUTBOX_FUNCTION_ID,
      name: "Send lead events left behind",
      retries: 1,
      trigger: { cron: "* * * * *" },
      handler: async ({ step }) => {
        const list = await step.run("businesses", () =>
          deps.db.directory.listBusinesses({
            statuses: ["onboarding", "active", "paused", "archived"],
          }),
        );
        let sent = 0;
        for (const business of list) {
          sent += await step.run(`send-${business.businessId}`, async () => {
            const now = clock();
            try {
              return await dispatchLeadEvents({
                db: deps.db,
                events: deps.events,
                tenant: business,
                before: new Date(now.getTime() - OUTBOX_GRACE_MS),
                now,
                onInvalid: (row) =>
                  logger.error("leads_outbox.invalid_event", {
                    businessId: business.businessId,
                    eventRowId: row.id,
                    name: row.name,
                  }),
              });
            } catch (error) {
              logger.error("leads_outbox.business_failed", {
                businessId: business.businessId,
                error: describeJobError(error),
              });
              return 0;
            }
          });
        }
        if (sent > 0) logger.warn("leads_outbox.recovered", { sent });
        return { sent };
      },
      onFailure: async ({ error, runId }) => {
        logger.error("leads_outbox.failed", { runId, error });
      },
    }),
  ];
}
