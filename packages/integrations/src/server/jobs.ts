import { randomUUID } from "node:crypto";

import type { EventPayload, LeadEventName, TraceId } from "@repo/core";
import { and, type BusinessTenant, eq, integrationEvents, isNull, lt, or } from "@repo/db";
import {
  defineCronJob,
  defineEventJob,
  type EventJobDefinition,
  type JobDefinition,
} from "@repo/jobs";

import { deliverOnce, giveUp, MAX_ATTEMPTS } from "./deliver";
import { clockOf, type IntegrationDeps } from "./deps";
import { deliveryEvent, EVENT_OPTION, planDeliveries, type PlannedDelivery } from "./plan";

/*
 * The durable functions of the integrations (ARCHITECTURE §4):
 *
 * - `integrations-lead-*` (one per lead event) and `integrations-booking-changed` plan the
 *   deliveries of an event and emit `integrations.delivery_requested` for each;
 * - `integrations-deliver` makes the attempts of one delivery, sleeping between them (1, 5,
 *   15, 60, 240 minutes, or the vendor's Retry-After), so one failing target never holds up
 *   another;
 * - `integrations-sweep` (every five minutes) restarts deliveries whose run was lost.
 */

export const INTEGRATION_FUNCTION_IDS = {
  leadQualified: "integrations-lead-qualified",
  leadMeetingRequested: "integrations-lead-meeting-requested",
  leadHandoff: "integrations-lead-handoff",
  leadDisqualified: "integrations-lead-disqualified",
  leadEmergency: "integrations-lead-emergency",
  bookingChanged: "integrations-booking-changed",
  deliver: "integrations-deliver",
  sweep: "integrations-sweep",
} as const;

/** A delivery left pending this long after its due time is restarted by the sweeper. */
const SWEEP_GRACE_MS = 10 * 60_000;
/** Loops of the deliver job: the attempts plus room for waits on a busy row. */
const MAX_LOOPS = MAX_ATTEMPTS + 4;

export function createIntegrationJobs(deps: IntegrationDeps): JobDefinition[] {
  const log = deps.logger.child({ component: "integrations-jobs" });
  const clock = clockOf(deps);

  async function emit(
    input: Parameters<typeof deliveryEvent>[0],
    planned: readonly PlannedDelivery[],
    suffix = "",
  ): Promise<void> {
    if (planned.length === 0 || deps.events === null) return;
    await deps.events.send(planned.map((delivery) => deliveryEvent(input, delivery, suffix)));
  }

  function leadJob<TName extends LeadEventName>(
    id: string,
    name: string,
    trigger: TName,
  ): EventJobDefinition<TName> {
    return defineEventJob({
      id,
      name,
      trigger: { event: trigger },
      retries: 4,
      async handler({ event, step }) {
        const data = event.data as EventPayload<LeadEventName>;
        const planned = await step.run("plan", () =>
          planDeliveries(deps, {
            agencyId: data.agencyId,
            businessId: data.businessId,
            traceId: data.traceId,
            eventType: trigger,
            option: EVENT_OPTION[trigger],
            eventKey: data.eventId,
            leadId: data.leadId,
            score: data.score,
            updatesOnly: false,
          }),
        );
        await step.run("emit", () => emit(data, planned));
        return { deliveries: planned.length };
      },
    });
  }

  const bookingChanged = defineEventJob({
    id: INTEGRATION_FUNCTION_IDS.bookingChanged,
    name: "Integrations: update the CRM and webhooks after a booking change",
    trigger: { event: "scheduling.booking_changed" },
    retries: 4,
    async handler({ event, step }) {
      const data = event.data;
      const planned = await step.run("plan", () =>
        planDeliveries(deps, {
          agencyId: data.agencyId,
          businessId: data.businessId,
          traceId: data.traceId,
          eventType: `booking.${data.change}`,
          option: "meeting_requested",
          eventKey: `booking:${data.bookingId}:v${data.version}`,
          leadId: null,
          bookingId: data.bookingId,
          score: null,
          updatesOnly: true,
        }),
      );
      await step.run("emit", () => emit(data, planned));
      return { deliveries: planned.length };
    },
  });

  const deliver = defineEventJob({
    id: INTEGRATION_FUNCTION_IDS.deliver,
    name: "Integrations: deliver a lead to a CRM or a webhook",
    trigger: { event: "integrations.delivery_requested" },
    // At most two deliveries at a time per connection: a vendor's rate limit is per account.
    concurrency: { key: "event.data.connectionId", limit: 2 },
    retries: 3,
    async handler({ event, step }) {
      const data = event.data;
      const tenant: BusinessTenant = { agencyId: data.agencyId, businessId: data.businessId };
      for (let loop = 0; loop < MAX_LOOPS; loop += 1) {
        const outcome = await step.run(`attempt-${loop}`, () =>
          deliverOnce(deps, tenant, data.deliveryId),
        );
        if (outcome.status !== "retry") return outcome;
        await step.sleep(`wait-${loop}`, outcome.waitMs);
      }
      await step.run("give-up", () =>
        giveUp(deps, tenant, data.deliveryId, "The delivery did not finish after every attempt."),
      );
      return { status: "failed" };
    },
    async onFailure({ event }) {
      const data = event.data;
      await giveUp(
        deps,
        { agencyId: data.agencyId, businessId: data.businessId },
        data.deliveryId,
        "The delivery stopped because of an internal error.",
      );
      log.error("integrations.delivery_dead", { deliveryId: data.deliveryId });
    },
  });

  const sweep = defineCronJob({
    id: INTEGRATION_FUNCTION_IDS.sweep,
    name: "Integrations: restart deliveries whose run was lost",
    trigger: { cron: "*/5 * * * *" },
    retries: 2,
    async handler({ step }) {
      const businesses = await step.run("tenants", () =>
        deps.db.directory.listBusinesses({ statuses: ["active", "onboarding", "paused"] }),
      );
      let restarted = 0;
      for (const business of businesses) {
        restarted += await step.run(`sweep-${business.businessId}`, async () => {
          const now = clock();
          const before = new Date(now.getTime() - SWEEP_GRACE_MS);
          const rows = await deps.db
            .forBusiness(business.businessId, { agencyId: business.agencyId })
            .run((ctx) =>
              ctx.tx
                .select({
                  id: integrationEvents.id,
                  connectionId: integrationEvents.integrationConnectionId,
                  attempts: integrationEvents.attempts,
                })
                .from(integrationEvents)
                .where(
                  and(
                    eq(integrationEvents.status, "pending"),
                    lt(integrationEvents.nextAttemptAt, before),
                    or(
                      isNull(integrationEvents.lockedUntil),
                      lt(integrationEvents.lockedUntil, now),
                    ),
                  ),
                )
                .limit(50),
            );
          // One event id per delivery and five-minute window: a restart is not dropped as a
          // duplicate of the event that started the lost run.
          const window = Math.floor(now.getTime() / (5 * 60_000));
          await emit(
            {
              agencyId: business.agencyId,
              businessId: business.businessId,
              traceId: randomUUID() as TraceId,
            },
            rows.map((row) => ({
              deliveryId: row.id,
              connectionId: row.connectionId,
              attempts: row.attempts,
            })),
            `-sweep-${window}`,
          );
          return rows.length;
        });
      }
      if (restarted > 0) log.info("integrations.sweep_restarted", { restarted });
      return { restarted };
    },
  });

  return [
    leadJob(
      INTEGRATION_FUNCTION_IDS.leadQualified,
      "Integrations: a qualified lead",
      "lead.qualified",
    ),
    leadJob(
      INTEGRATION_FUNCTION_IDS.leadMeetingRequested,
      "Integrations: a meeting request",
      "lead.meeting_requested",
    ),
    leadJob(INTEGRATION_FUNCTION_IDS.leadHandoff, "Integrations: a handoff", "lead.handoff"),
    leadJob(
      INTEGRATION_FUNCTION_IDS.leadDisqualified,
      "Integrations: a disqualified lead",
      "lead.disqualified",
    ),
    leadJob(INTEGRATION_FUNCTION_IDS.leadEmergency, "Integrations: an emergency", "lead.emergency"),
    bookingChanged,
    deliver,
    sweep,
  ] as JobDefinition[];
}
