import { z } from "zod";

import { AgencyId, BusinessId, TraceId } from "../ids";

/**
 * Scheduling events (owner: C12). Ids and classifications only, at-least-once delivery,
 * consumers must be idempotent.
 */

export const BOOKING_CHANGES = ["confirmed", "moved", "cancelled"] as const;

/**
 * A booking was confirmed, moved or cancelled. `version` is the booking's schedule version
 * after the change: `scheduling-reminders` plans the reminders of that version and drops
 * them once a later change raised it. The event id is derived from the booking and version.
 */
export const BookingChangedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  bookingId: z.uuid(),
  version: z.number().int().min(1),
  change: z.enum(BOOKING_CHANGES),
});
export type BookingChangedEvent = z.infer<typeof BookingChangedEvent>;

export const SCHEDULING_EVENTS = {
  "scheduling.booking_changed": BookingChangedEvent,
} as const;
