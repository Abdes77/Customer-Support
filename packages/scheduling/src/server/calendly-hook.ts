import { randomUUID } from "node:crypto";

import type { ConversationId, IntegrationConnectionId } from "@repo/core";
import {
  and,
  type BusinessContext,
  bookings,
  eq,
  integrationConnections,
  isUniqueViolation,
  leads,
  ne,
  sql,
} from "@repo/db";

import {
  type CalendlyInvitee,
  parseCalendlyDelivery,
  trackingToken,
  verifyCalendlySignature,
} from "../calendly/webhook";
import { CalendarCredentials } from "../oauth";
import { bookingChangedEvent } from "./bookings";
import { CalendlyConfig } from "./connections";
import { clockOf, type SchedulingDeps } from "./deps";
import { plainLine } from "./event-text";

/*
 * `POST /api/webhooks/calendly/{key}`: Calendly reports a booking made through one of our
 * single-use links (`invitee.created`) or a cancellation (`invitee.canceled`).
 *
 * The key in the URL names exactly one connection (a unique index), so a delivery can only
 * ever touch that connection's business; the signature is then checked over the raw body
 * with that connection's signing key (the OAuth app's, or the one we gave the subscription
 * of a personal token), in constant time and within five minutes. The booking is found by the
 * tracking token we put in the link, inside that business only. Every change is a state
 * transition that a replayed or repeated delivery leaves as it is.
 */

export interface CalendlyWebhookRequest {
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

export interface CalendlyWebhookResponse {
  readonly status: number;
  readonly outcome: string;
}

const MAX_BODY = 256 * 1024;

function instant(value: string): Date | null {
  const date = new Date(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(date.getTime()) ? null : date;
}

interface Change {
  readonly bookingId: string;
  readonly version: number;
  readonly change: "confirmed" | "moved" | "cancelled";
}

async function findBy(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  field: "linkToken" | "inviteeUri",
  value: string,
) {
  const [row] = await ctx.tx
    .select({
      id: bookings.id,
      status: bookings.status,
      conversationId: bookings.conversationId,
      startsAt: bookings.startsAt,
      metadata: bookings.metadata,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.integrationConnectionId, connectionId),
        eq(bookings.provider, "calendly"),
        sql`(${bookings.metadata} ->> ${field}) = ${value}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

function versionOf(metadata: Record<string, unknown>): number {
  const value = metadata["version"];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

async function setLead(
  ctx: BusinessContext,
  conversationId: ConversationId | null,
  booked: boolean,
) {
  if (conversationId === null) return;
  if (booked) {
    await ctx.tx
      .update(leads)
      .set({ status: "meeting_booked" })
      .where(and(eq(leads.conversationId, conversationId), ne(leads.status, "disqualified")));
  } else {
    await ctx.tx
      .update(leads)
      .set({
        status: sql`case when ${leads.routingOutcome} = 'book_meeting' then 'meeting_requested' else 'qualified' end`,
      })
      .where(and(eq(leads.conversationId, conversationId), eq(leads.status, "meeting_booked")));
  }
}

async function created(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  invitee: CalendlyInvitee,
): Promise<Change | null | "unmatched"> {
  const token = trackingToken(invitee);
  let booking = token === null ? null : await findBy(ctx, connectionId, "linkToken", token);
  let moved = false;
  if (booking === null && invitee.old_invitee != null) {
    // Rescheduled on Calendly: the new invitee replaces the old one on the same booking.
    booking = await findBy(ctx, connectionId, "inviteeUri", invitee.old_invitee);
    moved = booking !== null;
  }
  if (booking === null) return "unmatched";
  const start = instant(invitee.scheduled_event.start_time);
  const end = instant(invitee.scheduled_event.end_time);
  if (start === null || end === null || end <= start) return null;
  const known = booking.metadata["inviteeUri"];
  // This invitee is recorded already (a replay, or Calendly retrying a delivery after the
  // meeting was cancelled or moved): nothing changes. Once a booking has an invitee, only
  // its successor (a reschedule names it as `old_invitee`) replaces it, so a late or
  // out-of-order delivery for an older invitee cannot bring an old time back.
  if (known === invitee.uri) return null;
  if (typeof known === "string" && invitee.old_invitee !== known) return null;
  const version = versionOf(booking.metadata) + 1;
  try {
    await ctx.tx.transaction(async (tx) => {
      await tx
        .update(bookings)
        .set({
          status: "confirmed",
          startsAt: start,
          endsAt: end,
          externalEventId: invitee.scheduled_event.uri,
          cancelledAt: null,
          cancelReason: null,
          metadata: {
            ...booking.metadata,
            inviteeUri: invitee.uri,
            rescheduleUrl: invitee.reschedule_url ?? null,
            cancelUrl: invitee.cancel_url ?? null,
            version,
          },
        })
        .where(eq(bookings.id, booking.id));
    });
  } catch (error) {
    // The conversation has another active booking meanwhile: keep that one.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  await setLead(ctx, booking.conversationId, true);
  return {
    bookingId: booking.id,
    version,
    change: moved || booking.startsAt !== null ? "moved" : "confirmed",
  };
}

async function canceled(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  invitee: CalendlyInvitee,
  now: Date,
): Promise<Change | null | "unmatched"> {
  // A reschedule cancels the old invitee and creates a new one: the creation moves it.
  if (invitee.rescheduled === true) return null;
  const booking = await findBy(ctx, connectionId, "inviteeUri", invitee.uri);
  if (booking === null) return "unmatched";
  if (booking.status !== "confirmed") return null;
  const version = versionOf(booking.metadata) + 1;
  await ctx.tx
    .update(bookings)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancelReason: plainLine(invitee.cancellation?.reason ?? "Cancelled in Calendly", 200),
      metadata: { ...booking.metadata, version },
    })
    .where(eq(bookings.id, booking.id));
  await setLead(ctx, booking.conversationId, false);
  return { bookingId: booking.id, version, change: "cancelled" };
}

export function createCalendlyWebhookHandler(deps: SchedulingDeps) {
  const clock = clockOf(deps);
  const log = deps.logger.child({ component: "calendly-webhook" });
  return async (request: CalendlyWebhookRequest): Promise<CalendlyWebhookResponse> => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(request.key)) return { status: 404, outcome: "unknown_key" };
    if (request.rawBody.length > MAX_BODY) return { status: 413, outcome: "too_large" };
    const ref = await deps.db.directory.findIntegrationConnectionByWebhookKey(
      "calendly",
      request.key,
    );
    if (ref === null) {
      // Acknowledged, so a subscription we no longer know stops retrying (ARCHITECTURE §2).
      log.info("calendly.unknown_key");
      return { status: 200, outcome: "unknown_key" };
    }
    const tenant = { agencyId: ref.agencyId, businessId: ref.businessId };
    const scope = deps.db.forBusiness(ref.businessId, { agencyId: ref.agencyId });

    const keys = await scope.run(async (ctx) => {
      const [row] = await ctx.tx
        .select({ config: integrationConnections.config })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, ref.connectionId))
        .limit(1);
      const config = CalendlyConfig.safeParse(row?.config);
      if (!config.success) return [];
      if (config.data.auth === "oauth") {
        return deps.calendly.webhookSigningKey === null ? [] : [deps.calendly.webhookSigningKey];
      }
      const secret = await deps.db.secrets.integration.read(
        ctx,
        ref.connectionId,
        CalendarCredentials,
      );
      return secret?.kind === "token" && secret.webhookSigningKey !== null
        ? [secret.webhookSigningKey]
        : [];
    });
    const check = verifyCalendlySignature({
      header: request.headers["calendly-webhook-signature"],
      rawBody: request.rawBody,
      keys,
      now: clock(),
    });
    if (!check.ok) {
      log.warn("calendly.signature_rejected", { businessId: ref.businessId, reason: check.reason });
      return { status: 401, outcome: `signature_${check.reason}` };
    }
    if (ref.status !== "active") return { status: 200, outcome: "connection_inactive" };

    const delivery = parseCalendlyDelivery(request.rawBody);
    if (delivery === null) return { status: 400, outcome: "unreadable" };
    if (delivery.kind === "ignored") return { status: 200, outcome: "ignored" };

    const result = await scope.run((ctx) =>
      delivery.event === "invitee.created"
        ? created(ctx, ref.connectionId, delivery.invitee)
        : canceled(ctx, ref.connectionId, delivery.invitee, clock()),
    );
    if (result === "unmatched") {
      log.info("calendly.unmatched", { businessId: ref.businessId, event: delivery.event });
      return { status: 200, outcome: "unmatched" };
    }
    if (result === null) return { status: 200, outcome: "unchanged" };
    if (deps.events !== null) {
      try {
        await deps.events.send([
          bookingChangedEvent({
            tenant,
            traceId: randomUUID(),
            bookingId: result.bookingId,
            version: result.version,
            change: result.change,
          }),
        ]);
      } catch (error) {
        // `scheduling-reminder-sweep` plans the reminders of a booking whose event was lost.
        log.warn("scheduling.event_failed", { bookingId: result.bookingId, error });
      }
    }
    log.info("calendly.booking_changed", {
      businessId: ref.businessId,
      bookingId: result.bookingId,
      change: result.change,
    });
    return { status: 200, outcome: result.change };
  };
}
