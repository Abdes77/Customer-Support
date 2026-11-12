import {
  type AgencyId,
  type BusinessId,
  type IntegrationConnectionId,
  type LeadEventName,
  type LeadId,
  type TraceId,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  bookings,
  eq,
  inArray,
  integrationConnections,
  integrationEvents,
  integrationRecords,
  isNotNull,
  leads,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { clockOf, CRM_PROVIDERS, type IntegrationDeps } from "./deps";
import { ensureAgencySecret, ensureTargetConnection, webhookTargets } from "./targets";

/*
 * Planning: which CRM connections and webhook targets an event goes to, written as one
 * pending row of `integration_events` per target. The idempotency key is the event's id and
 * the connection, unique per connection: a lead event delivered twice plans nothing twice.
 */

/** The `integrations.*` setting option of each event. */
export const EVENT_OPTION: Readonly<Record<LeadEventName, string>> = {
  "lead.qualified": "lead_qualified",
  "lead.meeting_requested": "meeting_requested",
  "lead.handoff": "handoff",
  "lead.disqualified": "lead_disqualified",
  "lead.emergency": "emergency",
};

/** Events that go out whatever the score (`integrations.minimum_score` says so). */
const ALWAYS_SENT = new Set<string>(["handoff", "emergency"]);

export interface PlanInput {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  readonly traceId: TraceId;
  /** "lead.qualified" ... or "booking.confirmed" / "booking.moved" / "booking.cancelled". */
  readonly eventType: string;
  /** The setting option the event counts as. */
  readonly option: string;
  /** Stable per event: the lead event's id, or the booking and its version. */
  readonly eventKey: string;
  readonly leadId: LeadId | null;
  /** The booking id, for booking changes (the lead is read from it). */
  readonly bookingId?: string;
  readonly score: number | null;
  /** Booking changes only update a lead a CRM already has. */
  readonly updatesOnly: boolean;
}

export interface PlannedDelivery {
  readonly deliveryId: string;
  readonly connectionId: IntegrationConnectionId;
  readonly attempts: number;
}

function crmWanted(values: AppSettings, input: PlanInput): boolean {
  if (!(values["integrations.sync_events"] as readonly string[]).includes(input.option)) {
    return false;
  }
  if (ALWAYS_SENT.has(input.option) || input.score === null) return true;
  return input.score >= values["integrations.minimum_score"];
}

async function insertDeliveries(
  ctx: BusinessContext,
  input: PlanInput,
  leadId: LeadId,
  targets: readonly {
    readonly connectionId: IntegrationConnectionId;
    readonly target: string | null;
  }[],
  now: Date,
): Promise<PlannedDelivery[]> {
  if (targets.length === 0) return [];
  await ctx.tx
    .insert(integrationEvents)
    .values(
      targets.map((target) => ({
        ...ctx.tenant,
        integrationConnectionId: target.connectionId,
        leadId,
        eventType: input.eventType,
        status: "pending" as const,
        idempotencyKey: `${input.eventKey}:${target.connectionId}`,
        target: target.target,
        nextAttemptAt: now,
        request: { event: input.eventType },
      })),
    )
    .onConflictDoNothing();
  const rows = await ctx.tx
    .select({
      id: integrationEvents.id,
      connectionId: integrationEvents.integrationConnectionId,
      status: integrationEvents.status,
      attempts: integrationEvents.attempts,
    })
    .from(integrationEvents)
    .where(
      inArray(
        integrationEvents.idempotencyKey,
        targets.map((target) => `${input.eventKey}:${target.connectionId}`),
      ),
    );
  return rows
    .filter((row) => row.status === "pending")
    .map((row) => ({ deliveryId: row.id, connectionId: row.connectionId, attempts: row.attempts }));
}

/**
 * Plans the deliveries of one event and returns the pending ones (new or left over from an
 * earlier run of the same event). Agency target secrets are made first, in their own scope.
 */
export async function planDeliveries(
  deps: IntegrationDeps,
  input: PlanInput,
): Promise<PlannedDelivery[]> {
  const now = clockOf(deps)();
  const tenant = { agencyId: input.agencyId, businessId: input.businessId };
  const scope = () => deps.db.forBusiness(input.businessId, { agencyId: input.agencyId });
  const log = deps.logger.child({ businessId: input.businessId, traceId: input.traceId });

  // Agency targets need their secret before a business scope can sign with it.
  const agencyTargets = await scope().run(async (ctx) => {
    const settings = await loadSettings(ctx, tenant, { logger: log });
    return webhookTargets(settings.values)
      .filter((t) => t.scope === "agency" && t.active && t.events.includes(input.option))
      .map((t) => t.name);
  });
  for (const name of agencyTargets) await ensureAgencySecret(deps, input.agencyId, name);

  return scope().run(async (ctx) => {
    const settings = await loadSettings(ctx, tenant, { logger: log });
    const values = settings.values;
    let leadId = input.leadId;
    if (leadId === null && input.bookingId !== undefined) {
      const [booking] = await ctx.tx
        .select({ leadId: bookings.leadId })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .limit(1);
      leadId = booking?.leadId ?? null;
    }
    if (leadId === null) return [];
    const [lead] = await ctx.tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (lead === undefined) return [];

    const targets: { connectionId: IntegrationConnectionId; target: string | null }[] = [];
    if (
      crmWanted(values, input) ||
      (input.updatesOnly && values["integrations.update_on_change"])
    ) {
      const connections = await ctx.tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(
          and(
            inArray(integrationConnections.provider, [...CRM_PROVIDERS]),
            // A connection waiting for a reconnect still gets the delivery: it shows as
            // failed in the log and can be retried once connected again.
            inArray(integrationConnections.status, ["active", "error"]),
          ),
        );
      let ids = connections.map((connection) => connection.id);
      if (input.updatesOnly && ids.length > 0) {
        const known = await ctx.tx
          .select({ connectionId: integrationRecords.integrationConnectionId })
          .from(integrationRecords)
          .where(
            and(
              eq(integrationRecords.leadId, leadId),
              inArray(integrationRecords.integrationConnectionId, ids),
              isNotNull(integrationRecords.externalId),
            ),
          );
        const pushed = new Set(known.map((row) => row.connectionId));
        ids = ids.filter((id) => pushed.has(id));
      }
      for (const id of ids) targets.push({ connectionId: id, target: null });
    }
    for (const target of webhookTargets(values)) {
      if (!target.active || !target.events.includes(input.option)) continue;
      const connectionId = await ensureTargetConnection(deps, ctx, target, now);
      targets.push({ connectionId, target: `${target.scope}:${target.name}` });
    }
    const planned = await insertDeliveries(ctx, input, leadId, targets, now);
    log.info("integrations.planned", { event: input.eventType, deliveries: planned.length });
    return planned;
  });
}

/** The event that starts (or restarts) the job run of a delivery. */
export function deliveryEvent(
  input: {
    readonly agencyId: AgencyId;
    readonly businessId: BusinessId;
    readonly traceId: TraceId;
  },
  delivery: PlannedDelivery,
  idSuffix = "",
): AnyJobEvent {
  return jobEvent(
    "integrations.delivery_requested",
    `integration-delivery-${delivery.deliveryId}${idSuffix}`,
    {
      traceId: input.traceId,
      agencyId: input.agencyId,
      businessId: input.businessId,
      connectionId: delivery.connectionId,
      deliveryId: delivery.deliveryId,
    },
  );
}
