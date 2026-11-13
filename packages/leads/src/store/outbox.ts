import {
  type BusinessTenant,
  type BusinessContext,
  type Database,
  and,
  asc,
  eq,
  inArray,
  isNull,
  leadEvents,
  lt,
  sql,
} from "@repo/db";
import type { LeadId, LeadEventName, EventPayload } from "@repo/core";
import { type AnyJobEvent, type EventSender, jobEvent } from "@repo/jobs";

/**
 * The outbox of lead events (table `lead_events`). Rows are written where the fact is
 * recorded (`recordLeadEvent`); this module turns them into job events and marks them sent.
 * The job event id is derived from the row id, so sending a row twice (a retried step, the
 * cron after a crash) starts one run: Inngest drops a repeated id for 24 hours, and every
 * subscriber is idempotent per `eventId` anyway.
 */

export const leadEventJobId = (rowId: string) => `lead-${rowId}`;

const BATCH = 200;

export interface PendingLeadEvent {
  readonly id: string;
  readonly name: LeadEventName;
  readonly payload: Record<string, unknown>;
}

/** Unsent events, oldest first: of one lead, or of the business created before `before`. */
export async function pendingLeadEvents(
  ctx: BusinessContext,
  filter: { readonly leadId?: LeadId; readonly before?: Date },
): Promise<PendingLeadEvent[]> {
  return ctx.tx
    .select({ id: leadEvents.id, name: leadEvents.name, payload: leadEvents.payload })
    .from(leadEvents)
    .where(
      and(
        isNull(leadEvents.emittedAt),
        filter.leadId === undefined ? undefined : eq(leadEvents.leadId, filter.leadId),
        filter.before === undefined ? undefined : lt(leadEvents.createdAt, filter.before),
      ),
    )
    .orderBy(asc(leadEvents.createdAt), asc(leadEvents.occurredAt), asc(leadEvents.id))
    .limit(BATCH);
}

/**
 * Outbox rows as job events. A row whose payload no longer passes the catalogue is left out
 * (and reported to `onInvalid`), so one bad row cannot stop the lead's other events, the turn
 * observer or the cron.
 */
export function toJobEvents(
  rows: readonly PendingLeadEvent[],
  onInvalid?: (row: PendingLeadEvent) => void,
): AnyJobEvent[] {
  const events: AnyJobEvent[] = [];
  for (const row of rows) {
    try {
      events.push(
        jobEvent(
          row.name,
          leadEventJobId(row.id),
          row.payload as EventPayload<typeof row.name>,
        ) as AnyJobEvent,
      );
    } catch {
      onInvalid?.(row);
    }
  }
  return events;
}

/** The outbox row ids behind job events (the lead events among them). */
export function leadEventRowIds(events: readonly AnyJobEvent[]): string[] {
  return events
    .filter((event) => event.name.startsWith("lead.") && event.id.startsWith("lead-"))
    .map((event) => event.id.slice("lead-".length));
}

export async function markLeadEventsEmitted(
  ctx: BusinessContext,
  ids: readonly string[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await ctx.tx
    .update(leadEvents)
    .set({ emittedAt: now, attempts: sql`${leadEvents.attempts} + 1` })
    .where(and(inArray(leadEvents.id, [...ids]), isNull(leadEvents.emittedAt)))
    .returning({ id: leadEvents.id });
  return rows.length;
}

/**
 * Sends the business's unsent lead events created before `before` and marks them sent.
 * Used by the `leads-outbox` cron for what a failed or crashed turn left behind.
 */
export async function dispatchLeadEvents(options: {
  readonly db: Database;
  readonly events: EventSender;
  readonly tenant: BusinessTenant;
  readonly before: Date;
  readonly now: Date;
  readonly onInvalid?: (row: PendingLeadEvent) => void;
}): Promise<number> {
  const scope = options.db.forBusiness(options.tenant.businessId, {
    agencyId: options.tenant.agencyId,
  });
  const rows = await scope.run((ctx) => pendingLeadEvents(ctx, { before: options.before }));
  const events = toJobEvents(rows, options.onInvalid);
  const sendable = new Set(leadEventRowIds(events));
  if (events.length === 0) return 0;
  try {
    await options.events.send(events);
  } catch (error) {
    await scope.run((ctx) =>
      ctx.tx
        .update(leadEvents)
        .set({ attempts: sql`${leadEvents.attempts} + 1` })
        .where(inArray(leadEvents.id, [...sendable])),
    );
    throw error;
  }
  return scope.run((ctx) => markLeadEventsEmitted(ctx, [...sendable], options.now));
}
