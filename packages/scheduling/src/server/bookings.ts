import { randomBytes } from "node:crypto";

import {
  type ActionOutcome,
  ConfigError,
  type ConversationId,
  type IntegrationConnectionId,
  type TraceId,
} from "@repo/core";
import {
  alerts,
  and,
  type BusinessContext,
  bookings,
  eq,
  gt,
  inArray,
  integrationConnections,
  isUniqueViolation,
  leads,
  lt,
  ne,
  or,
  sql,
} from "@repo/db";
import { jobEvent } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";

import {
  busyIntervals,
  findSlot,
  freeSlots,
  type Interval,
  parsePreference,
  parseSlotId,
  pickOffers,
  searchWindow,
  type SlotRules,
  slotRules,
  zipCodeOf,
} from "../availability";
import { googleEventId } from "../calendars/google";
import type { CalendarClient } from "../calendars/types";
import { normalizeSchedulingUrl } from "../calendly/client";
import { linkWithToken } from "../calendly/webhook";
import { CalendarApiError } from "../http";
import { localMoment, meetingLabel, MINUTE_MS, minutesOf, weekdayOf } from "../time";
import {
  accessToken,
  activeConnection,
  calendarClients,
  calendarConfigOf,
  type ConnectionRow,
  markReconnectNeeded,
  type SchedulingProvider,
  type Tenant,
} from "./connections";
import { clockOf, type SchedulingDeps } from "./deps";
import { eventDraft, meetingTypeLabel, plainLine } from "./event-text";
import { type ConversationFacts, loadConversationFacts } from "./facts";

/*
 * Offering, booking, moving and cancelling meetings for one conversation. The rules:
 *
 * - Only a lead whose current routing decision is "book a meeting" is offered times or
 *   booked (contact-later, disqualified, handed-off and unverified-location leads never are),
 *   and only with the details `routing.booking_requires` names. Moving or cancelling a meeting
 *   that exists needs neither.
 * - A slot is checked again at booking time, against the calendar and every active booking.
 * - Two customers cannot take one slot: the hold is written under a per-business advisory
 *   lock after checking the business's other active bookings (buffers included). A hold whose
 *   booking never finished is ignored `STALE_HOLD_MINUTES` after it was written or last given
 *   a new time (`metadata.heldAt`, from the service's clock, the same clock that judges it:
 *   never the row's `created_at`, which is the database's clock at the start of the
 *   transaction and is not refreshed when an unfinished hold takes a new time).
 * - A repeated or retried call never books twice: one active booking per conversation (a
 *   unique index), the same slot again is the same booking, and the calendar write is
 *   idempotent per booking id.
 * - Moving a meeting holds the new time beside the booked one (`metadata.moveHold`, aged like
 *   a pending hold) and changes the booking's times only once the calendar has them, so an
 *   attempt that stops half way leaves the booking, its reminders and the calendar agreeing
 *   on the old time, and a retried call moves it again.
 * - Nothing is offered, booked, moved or cancelled while a person holds the conversation.
 */

export const STALE_HOLD_MINUTES = 15;
/** Calendly expires an unused single-use link after 90 days; a link this old is replaced. */
export const CALENDLY_LINK_MAX_AGE_DAYS = 80;

export interface BookingRequest {
  readonly tenant: Tenant;
  readonly conversationId: ConversationId;
  readonly traceId: string;
  readonly now: Date;
  readonly values: AppSettings;
  readonly mode: "live" | "dry_run";
}

interface BookingRow {
  readonly id: string;
  readonly status: string;
  readonly provider: string;
  readonly integrationConnectionId: IntegrationConnectionId | null;
  readonly externalEventId: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}

const BOOKING_COLUMNS = {
  id: bookings.id,
  status: bookings.status,
  provider: bookings.provider,
  integrationConnectionId: bookings.integrationConnectionId,
  externalEventId: bookings.externalEventId,
  startsAt: bookings.startsAt,
  endsAt: bookings.endsAt,
  createdAt: bookings.createdAt,
  metadata: bookings.metadata,
};

const applied = (message: string | null, data: unknown = null): ActionOutcome => ({
  status: "applied",
  message,
  data,
});
const rejected = (message: string, data: unknown = null): ActionOutcome => ({
  status: "rejected",
  message,
  data,
});
const failed = (message: string): ActionOutcome => ({ status: "failed", message, data: null });

function unavailable(values: AppSettings, why: string): ActionOutcome {
  return rejected(
    `Booking in chat is not possible right now (${why}). ${
      values["routing.booking_unavailable_outcome"] === "handoff"
        ? "Hand the conversation to a person, as the handoff rules describe."
        : "Tell the customer the team will contact them to find a time, as the routing rules for contact_later describe."
    }`,
  );
}

function versionOf(row: Pick<BookingRow, "metadata">): number {
  const value = row.metadata["version"];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/** The new time a confirmed meeting is being moved to, while the calendar is being changed. */
function moveHoldOf(row: Pick<BookingRow, "metadata">): { start: Date; end: Date } | null {
  const hold = row.metadata["moveHold"];
  if (hold === null || typeof hold !== "object") return null;
  const { startsAt, endsAt } = hold as { startsAt?: unknown; endsAt?: unknown };
  if (typeof startsAt !== "string" || typeof endsAt !== "string") return null;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
}

const TAKEN_OVER: ActionOutcome = {
  status: "rejected",
  message:
    "A person from the team is handling this conversation now. Offer, book, move or cancel nothing; tell the customer the team will take care of it.",
  data: null,
};

/** The business's own active bookings as busy spans, with the buffers around each. */
function ownBusy(rows: readonly BookingRow[], rules: SlotRules): Interval[] {
  return rows
    .filter((row) => row.startsAt !== null && row.endsAt !== null)
    .map((row) => ({
      start: row.startsAt!.getTime() - rules.bufferBeforeMinutes * MINUTE_MS,
      end: row.endsAt!.getTime() + rules.bufferAfterMinutes * MINUTE_MS,
    }));
}

function perDay(rows: readonly BookingRow[], timeZone: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.startsAt === null) continue;
    const date = localMoment(row.startsAt, timeZone).date;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

const CONTACT_WORDS: Readonly<Record<string, string>> = {
  name: "name",
  phone: "phone number",
  email: "email address",
  address: "street address of the job",
};

function missingDetails(facts: ConversationFacts, values: AppSettings): string[] {
  const have: Readonly<Record<string, string | null>> = {
    name: facts.customer.name,
    phone: facts.customer.phone,
    email: facts.customer.email,
    address: facts.customer.address,
  };
  return values["routing.booking_requires"]
    .filter((detail) => (have[detail] ?? null) === null)
    .map((detail) => CONTACT_WORDS[detail] ?? detail);
}

/** The settings that rule booking out before anything is read. */
export function settingsGate(values: AppSettings): ActionOutcome | null {
  if (values["routing.mode"] === "always_contact_later") {
    return rejected(
      "This business does not book meetings in chat. Tell the customer the team will be in touch, as the routing rules for contact_later describe.",
    );
  }
  const provider = values["scheduling.provider"];
  if (provider === "none") return unavailable(values, "no calendar is connected");
  if (provider === "calendly" && values["scheduling.calendly_event_type"] === null) {
    return unavailable(values, "no scheduling page is set");
  }
  return null;
}

/** Whether this conversation's lead may be offered times or booked. */
function leadGate(facts: ConversationFacts, values: AppSettings): ActionOutcome | null {
  if (facts.takeover) return TAKEN_OVER;
  const lead = facts.lead;
  if (
    lead?.routingOutcome !== "book_meeting" ||
    lead.status === "disqualified" ||
    lead.status === "handed_off"
  ) {
    return rejected(
      "The routing decision for this lead is not to book a meeting. Follow the routing decision in the turn context instead of offering times.",
    );
  }
  const missing = missingDetails(facts, values);
  if (missing.length > 0) {
    return rejected(
      `Before booking, ask the customer for their ${missing.join(" and ")} and record it with update_lead_fields. Then get times again.`,
    );
  }
  return null;
}

async function activeBookingOf(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<BookingRow | null> {
  const [row] = await ctx.tx
    .select(BOOKING_COLUMNS)
    .from(bookings)
    .where(
      and(
        eq(bookings.conversationId, conversationId),
        inArray(bookings.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Active bookings of the business in a span, other than this conversation's. `now` is the
 * service's clock: a pending hold counts while it is younger than `STALE_HOLD_MINUTES` by
 * the time it was held (`metadata.heldAt`, written from the same clock; `created_at` only
 * for a row written without it).
 */
async function otherBookings(
  ctx: BusinessContext,
  conversationId: ConversationId,
  span: Interval,
  now: Date,
): Promise<BookingRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_HOLD_MINUTES * MINUTE_MS).toISOString();
  const notThis = or(
    sql`${bookings.conversationId} is null`,
    ne(bookings.conversationId, conversationId),
  );
  const rows = await ctx.tx
    .select(BOOKING_COLUMNS)
    .from(bookings)
    .where(
      and(
        or(
          eq(bookings.status, "confirmed"),
          and(
            eq(bookings.status, "pending"),
            sql`coalesce((${bookings.metadata} ->> 'heldAt')::timestamptz, ${bookings.createdAt}) > ${staleBefore}::timestamptz`,
          ),
        ),
        notThis,
        lt(bookings.startsAt, new Date(span.end)),
        gt(bookings.endsAt, new Date(span.start)),
      ),
    );
  // A meeting being moved also holds its new time until the calendar has it (or the hold
  // ages out like any other).
  const moving = await ctx.tx
    .select(BOOKING_COLUMNS)
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "confirmed"),
        notThis,
        sql`(${bookings.metadata} -> 'moveHold' ->> 'heldAt')::timestamptz > ${staleBefore}::timestamptz`,
        sql`(${bookings.metadata} -> 'moveHold' ->> 'startsAt')::timestamptz < ${new Date(span.end).toISOString()}::timestamptz`,
        sql`(${bookings.metadata} -> 'moveHold' ->> 'endsAt')::timestamptz > ${new Date(span.start).toISOString()}::timestamptz`,
      ),
    );
  return [
    ...rows,
    ...moving.flatMap((row) => {
      const hold = moveHoldOf(row);
      return hold === null ? [] : [{ ...row, startsAt: hold.start, endsAt: hold.end }];
    }),
  ];
}

async function setLeadBooked(
  ctx: BusinessContext,
  conversationId: ConversationId,
  booked: boolean,
): Promise<void> {
  if (booked) {
    await ctx.tx
      .update(leads)
      .set({ status: "meeting_booked" })
      .where(and(eq(leads.conversationId, conversationId), ne(leads.status, "disqualified")));
    return;
  }
  // A cancelled meeting gives the lead back to its routing: book again, or contact later.
  await ctx.tx
    .update(leads)
    .set({
      status: sql`case when ${leads.routingOutcome} = 'book_meeting' then 'meeting_requested' else 'qualified' end`,
    })
    .where(and(eq(leads.conversationId, conversationId), eq(leads.status, "meeting_booked")));
}

export function bookingChangedEvent(input: {
  readonly tenant: Tenant;
  readonly traceId: string;
  readonly bookingId: string;
  readonly version: number;
  readonly change: "confirmed" | "moved" | "cancelled";
}) {
  return jobEvent("scheduling.booking_changed", `booking-${input.bookingId}-v${input.version}`, {
    traceId: input.traceId as TraceId,
    agencyId: input.tenant.agencyId,
    businessId: input.tenant.businessId,
    bookingId: input.bookingId,
    version: input.version,
    change: input.change,
  });
}

/**
 * What a dry run may know: the verdict of the settings alone, with no conversation, no
 * database and no calendar (invariant I8). Null when the settings allow the action.
 */
export function dryRunVerdict(
  type: "offer_times" | "book_meeting" | "cancel_meeting",
  values: AppSettings,
): ActionOutcome | null {
  if (type === "cancel_meeting") {
    return values["scheduling.allow_cancel"]
      ? null
      : rejected(
          "This business does not cancel meetings in chat. Tell the customer the team will take care of it, and hand the conversation to a person.",
        );
  }
  const gate = settingsGate(values);
  if (gate !== null) return gate;
  if (type === "book_meeting" && values["scheduling.provider"] === "calendly") {
    return rejected(
      "With this business the customer books through the scheduling link from offer_times. Send the link instead.",
    );
  }
  return null;
}

export interface BookingService {
  offerTimes(
    request: BookingRequest & { readonly preference: string | null; readonly count: number },
  ): Promise<ActionOutcome>;
  book(request: BookingRequest & { readonly slotId: string }): Promise<ActionOutcome>;
  cancel(request: BookingRequest & { readonly reason: string }): Promise<ActionOutcome>;
  /**
   * Holds that never finished (C17): a booking attempt that stopped after its calendar event
   * was created and was never retried left a `pending` hold and an event in the calendar.
   * Holds an hour old are released (cancelled); Google's event, whose id comes from the
   * booking, is deleted; an event whose id we never learned (Outlook) is named in an in-app
   * alert for the team to delete. A move that never finished is alerted the same way.
   */
  releaseAbandonedHolds(tenant: Tenant): Promise<{
    readonly released: number;
    readonly eventsRemoved: number;
    readonly alerted: number;
  }>;
}

/** A hold older than this cannot belong to a turn still running (the lease is minutes). */
export const ABANDONED_HOLD_MS = 60 * MINUTE_MS;

export function createBookingService(deps: SchedulingDeps): BookingService {
  const clients = calendarClients(deps);
  const clock = clockOf(deps);
  const scope = (tenant: Tenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  function calendarClient(provider: SchedulingProvider): CalendarClient {
    return provider === "outlook_calendar" ? clients.microsoft : clients.google;
  }

  async function emit(event: ReturnType<typeof bookingChangedEvent>): Promise<void> {
    if (deps.events === null) return;
    try {
      await deps.events.send([event]);
    } catch (error) {
      // `scheduling-reminder-sweep` plans the reminders of a booking whose event was lost.
      deps.logger.warn("scheduling.event_failed", { eventId: event.id, error });
    }
  }

  async function vendorFailure(
    request: BookingRequest,
    connection: ConnectionRow,
    error: unknown,
  ): Promise<void> {
    if (error instanceof CalendarApiError && error.authFailed) {
      await scope(request.tenant).run((ctx) =>
        markReconnectNeeded(deps, ctx, connection.id, error.message),
      );
    }
    deps.logger.warn("scheduling.calendar_write_failed", {
      traceId: request.traceId,
      businessId: request.tenant.businessId,
      connectionId: connection.id,
      error,
    });
  }

  /**
   * `prepare`, with a calendar that refused our token (the connection is marked for
   * reconnecting) or a deployment without the provider's app read as "not connected".
   */
  async function prepareOrUnconnected(request: BookingRequest) {
    try {
      return await prepare(request);
    } catch (error) {
      if ((error instanceof CalendarApiError && error.authFailed) || error instanceof ConfigError) {
        deps.logger.warn("scheduling.calendar_unavailable", {
          traceId: request.traceId,
          businessId: request.tenant.businessId,
          error,
        });
        return { kind: "unconnected" as const };
      }
      throw error;
    }
  }

  /** Reads what a calendar offer or booking needs, in one transaction. */
  async function prepare(request: BookingRequest) {
    const provider = request.values["scheduling.provider"] as SchedulingProvider;
    return scope(request.tenant).run(async (ctx) => {
      const facts = await loadConversationFacts(ctx, request.conversationId);
      if (facts === null) return { kind: "missing" as const };
      const existing = await activeBookingOf(ctx, request.conversationId);
      const connection = await activeConnection(ctx, provider);
      if (connection === null) return { kind: "unconnected" as const, facts, existing };
      const token = await accessToken(deps, ctx, connection);
      const rules = slotRules(request.values, { zip: zipCodeOf(facts.customer.location) });
      const window = searchWindow(rules, facts.business.timeZone, request.now);
      const others = await otherBookings(ctx, request.conversationId, window, clock());
      return { kind: "ready" as const, facts, existing, connection, token, rules, window, others };
    });
  }

  /** Free slots now, from the calendar and the business's bookings. */
  async function searchFor(
    request: BookingRequest,
    ready: Extract<Awaited<ReturnType<typeof prepare>>, { kind: "ready" }>,
  ) {
    const { facts, connection, token, rules, window, others, existing } = ready;
    const config = calendarConfigOf(connection);
    const client = calendarClient(connection.provider);
    const events = (
      await Promise.all(
        config.calendarIds.map((calendarId) =>
          client.events(token, {
            calendarId,
            from: new Date(window.start),
            to: new Date(window.end),
            timeZone: facts.business.timeZone,
          }),
        ),
      )
    ).flat();
    let busy = busyIntervals(events, request.values, facts.business.timeZone);
    // The customer's own meeting (being moved) does not block the times around it, at its
    // booked time or at the time an unfinished move may already have given its event.
    if (existing?.startsAt != null && existing.endsAt !== null) {
      const hold = existing.status === "confirmed" ? moveHoldOf(existing) : null;
      const own = [
        { start: existing.startsAt.getTime(), end: existing.endsAt.getTime() },
        ...(hold === null ? [] : [{ start: hold.start.getTime(), end: hold.end.getTime() }]),
      ];
      busy = busy.filter(
        (item) => !own.some((span) => item.start === span.start && item.end === span.end),
      );
    }
    return {
      rules,
      timeZone: facts.business.timeZone,
      now: request.now,
      busy: [...busy, ...ownBusy(others, rules)],
      bookingsPerDay: perDay(others, facts.business.timeZone),
    };
  }

  function label(facts: ConversationFacts, values: AppSettings, start: Date): string {
    return meetingLabel({
      start,
      arrivalWindowMinutes: values["scheduling.arrival_window_minutes"],
      timeZone: facts.customer.timeZone,
      businessTimeZone: facts.business.timeZone,
    });
  }

  function changeGate(
    values: AppSettings,
    existing: BookingRow,
    now: Date,
    what: "move" | "cancel",
  ): ActionOutcome | null {
    const allowed =
      what === "move" ? values["scheduling.allow_reschedule"] : values["scheduling.allow_cancel"];
    if (!allowed) {
      return rejected(
        what === "move"
          ? "This business does not move meetings in chat. Tell the customer a person will help with a new time, and hand the conversation to a person."
          : "This business does not cancel meetings in chat. Tell the customer the team will take care of it, and hand the conversation to a person.",
      );
    }
    const cutoff = values["scheduling.change_cutoff_hours"];
    if (
      existing.startsAt !== null &&
      existing.startsAt.getTime() - now.getTime() < cutoff * 3_600_000
    ) {
      return rejected(
        `The meeting is less than ${cutoff} hours away, too late to ${what === "move" ? "move" : "cancel"} it in chat. Tell the customer the team will call them about it, and hand the conversation to a person.`,
      );
    }
    return null;
  }

  // --- Calendly ---------------------------------------------------------------------------

  /** A pending Calendly link that still works; false for an old link or a calendar hold. */
  function isLiveLink(row: BookingRow): boolean {
    if (row.provider !== "calendly" || typeof row.metadata["linkUrl"] !== "string") return false;
    const made = row.metadata["linkCreatedAt"];
    const at = typeof made === "string" ? Date.parse(made) : row.createdAt.getTime();
    return Number.isNaN(at) || clock().getTime() - at < CALENDLY_LINK_MAX_AGE_DAYS * 86_400_000;
  }

  async function offerCalendlyLink(request: BookingRequest): Promise<ActionOutcome> {
    const { values } = request;
    const result = await scope(request.tenant).run(async (ctx) => {
      const facts = await loadConversationFacts(ctx, request.conversationId);
      if (facts === null) return rejected("There is no conversation to book for.");
      if (facts.takeover) return TAKEN_OVER;
      let existing = await activeBookingOf(ctx, request.conversationId);
      if (existing?.status === "confirmed") {
        const gate = changeGate(values, existing, request.now, "move");
        if (gate !== null) return gate;
        const reschedule = existing.metadata["rescheduleUrl"];
        if (typeof reschedule === "string" && reschedule.startsWith("https://calendly.com/")) {
          return applied(
            `The customer moves their meeting with this link, which shows the free times: ${reschedule}`,
            {
              link: reschedule,
              currentMeeting:
                existing.startsAt === null ? null : label(facts, values, existing.startsAt),
            },
          );
        }
        return unavailable(values, "the meeting cannot be moved online");
      }
      const gate = leadGate(facts, values);
      if (gate !== null) return gate;
      if (existing !== null && !isLiveLink(existing)) {
        // A link Calendly has expired (or soon will), or an unfinished calendar hold from
        // before the business switched to Calendly: withdrawn, and a new link is made.
        if (request.mode === "dry_run") {
          return applied("A scheduling link would be sent.", { link: null });
        }
        await ctx.tx
          .update(bookings)
          .set({
            status: "cancelled",
            cancelledAt: clock(),
            cancelReason: "Replaced by a new scheduling link.",
          })
          .where(and(eq(bookings.id, existing.id), eq(bookings.status, "pending")));
        existing = null;
      }
      const link = existing?.metadata["linkUrl"];
      if (typeof link === "string") {
        return applied(`Send the customer this link to pick a time: ${link}`, {
          link,
          meeting: meetingTypeLabel(values),
        });
      }
      const connection = await activeConnection(ctx, "calendly");
      if (connection === null) return unavailable(values, "Calendly is not connected");
      if (request.mode === "dry_run") {
        return applied("A scheduling link would be sent.", { link: null });
      }
      const token = await accessToken(deps, ctx, connection);
      const eventTypeUri = await resolveEventType(ctx, connection, token, values);
      if (eventTypeUri === null)
        return unavailable(values, "the scheduling page was not found in Calendly");
      const bookingUrl = await clients.calendly.createSchedulingLink(token, eventTypeUri);
      const linkToken = randomBytes(18).toString("base64url");
      const url = linkWithToken(bookingUrl, linkToken);
      try {
        await ctx.tx.transaction(async (tx) => {
          await tx.insert(bookings).values({
            ...ctx.tenant,
            contactId: facts.contactId,
            conversationId: request.conversationId,
            leadId: facts.lead?.id ?? null,
            integrationConnectionId: connection.id,
            provider: "calendly",
            status: "pending",
            timezone: facts.business.timeZone,
            title: meetingTypeLabel(values),
            metadata: { linkToken, linkUrl: url, linkCreatedAt: clock().toISOString(), version: 0 },
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another attempt of this turn sent a link first: send that one.
        const again = await activeBookingOf(ctx, request.conversationId);
        const first = again?.metadata["linkUrl"];
        if (typeof first === "string") {
          return applied(`Send the customer this link to pick a time: ${first}`, { link: first });
        }
        throw error;
      }
      return applied(
        `Send the customer this link to pick a time: ${url} It works once; the booking reaches the team by itself.`,
        { link: url, meeting: meetingTypeLabel(values) },
      );
    });
    return result;
  }

  async function resolveEventType(
    ctx: BusinessContext,
    connection: ConnectionRow,
    token: string,
    values: AppSettings,
  ): Promise<string | null> {
    const wanted = normalizeSchedulingUrl(values["scheduling.calendly_event_type"] ?? "");
    if (wanted === null) return null;
    const cached = connection.state["eventType"] as { url?: unknown; uri?: unknown } | undefined;
    if (cached?.url === wanted && typeof cached.uri === "string") return cached.uri;
    const userUri = connection.config["userUri"];
    if (typeof userUri !== "string") return null;
    const types = await clients.calendly.eventTypes(token, userUri);
    const match = types.find(
      (type) => type.active && normalizeSchedulingUrl(type.schedulingUrl) === wanted,
    );
    if (match === undefined) return null;
    await ctx.tx
      .update(integrationConnections)
      .set({ state: { ...connection.state, eventType: { url: wanted, uri: match.uri } } })
      .where(eq(integrationConnections.id, connection.id));
    return match.uri;
  }

  // --- the service ------------------------------------------------------------------------

  return {
    async offerTimes(request) {
      const { values } = request;
      const gate = settingsGate(values);
      if (gate !== null) return gate;
      if (values["scheduling.provider"] === "calendly") return offerCalendlyLink(request);
      if (request.mode === "dry_run") return applied("Times would be offered.", { slots: [] });

      const ready = await prepareOrUnconnected(request);
      if (ready.kind === "missing") return rejected("There is no conversation to book for.");
      if (ready.kind === "unconnected") return unavailable(values, "the calendar is not connected");
      const { facts, existing } = ready;
      if (facts.takeover) return TAKEN_OVER;
      if (existing?.status === "confirmed") {
        const change = changeGate(values, existing, request.now, "move");
        if (change !== null) return change;
      } else {
        const lead = leadGate(facts, values);
        if (lead !== null) return lead;
      }
      let search;
      try {
        search = await searchFor(request, ready);
      } catch (error) {
        await vendorFailure(request, ready.connection, error);
        return unavailable(values, "the calendar could not be read");
      }
      // A customer moving their meeting is not offered the time they already have.
      const current = existing?.status === "confirmed" ? existing.startsAt?.getTime() : undefined;
      const slots = freeSlots(search).filter((slot) => Date.parse(slot.start) !== current);
      if (slots.length === 0) {
        return unavailable(
          values,
          `no free time in the next ${values["scheduling.max_days_ahead"]} days`,
        );
      }
      // The customer's words ("tomorrow", "after 3", "Tuesday") mean their own clock and
      // calendar: read them in the customer's time zone, as the offered times are labelled.
      const customerZone = facts.customer.timeZone;
      const today = localMoment(request.now, customerZone).date;
      const wanted = parsePreference(request.preference, today);
      const count = Math.min(request.count, values["scheduling.slots_to_offer"]);
      const { offers, matchedPreference } = pickOffers(slots, {
        count,
        spread: values["scheduling.spread_offers"],
        preference: {
          understood: wanted.understood,
          matches: (slot) => {
            const local = localMoment(new Date(slot.start), customerZone);
            return wanted.matches({
              date: local.date,
              weekday: weekdayOf(local.date),
              minutes: minutesOf(local.time),
            });
          },
        },
      });
      const meeting = meetingTypeLabel(values);
      return applied(
        [
          `Offer these times as written (the customer's local time), and nothing else.`,
          matchedPreference
            ? null
            : "None matched what the customer asked for; say so and offer these instead.",
          existing?.status === "confirmed" && existing.startsAt !== null
            ? `The customer's current meeting is ${label(facts, values, existing.startsAt)}; booking one of these moves it.`
            : null,
        ]
          .filter((line) => line !== null)
          .join(" "),
        {
          meeting,
          minutes: values["scheduling.slot_minutes"],
          slots: offers.map((slot) => ({
            id: slot.id,
            label: label(facts, values, new Date(slot.start)),
          })),
        },
      );
    },

    async book(request) {
      const { values } = request;
      const gate = settingsGate(values);
      if (gate !== null) return gate;
      if (values["scheduling.provider"] === "calendly") {
        return rejected(
          "With this business the customer books through the scheduling link from offer_times. Send the link instead.",
        );
      }
      const start = parseSlotId(request.slotId);
      if (start === null) {
        return rejected(
          "That is not a slot id from offer_times. Get times with offer_times and use one of their ids.",
        );
      }
      if (request.mode === "dry_run")
        return applied("The meeting would be booked.", { slotId: request.slotId });

      const ready = await prepareOrUnconnected(request);
      if (ready.kind === "missing") return rejected("There is no conversation to book for.");
      if (ready.kind === "unconnected") return unavailable(values, "the calendar is not connected");
      const { facts, existing, connection, token, rules } = ready;
      if (facts.takeover) return TAKEN_OVER;

      // The same slot again: the booking that exists (a repeated or retried tool call).
      if (existing?.status === "confirmed" && existing.startsAt?.getTime() === start.getTime()) {
        return applied(`Already booked: ${label(facts, values, start)}.`, {
          booked: label(facts, values, start),
          meeting: meetingTypeLabel(values),
        });
      }
      const moving = existing?.status === "confirmed" ? existing : null;
      if (moving !== null) {
        const change = changeGate(values, moving, request.now, "move");
        if (change !== null) return change;
      } else {
        const lead = leadGate(facts, values);
        if (lead !== null) return lead;
      }

      let slot;
      try {
        slot = findSlot(await searchFor(request, ready), start);
      } catch (error) {
        await vendorFailure(request, connection, error);
        return unavailable(values, "the calendar could not be read");
      }
      if (slot === null) {
        return rejected(
          "That time is no longer free. Get new times with offer_times and offer those; do not confirm this one.",
        );
      }
      const end = new Date(slot.end);

      // Hold the slot: under the business's lock, check the other bookings once more and
      // write the hold (a new pending booking, or the new times of the meeting being moved).
      const hold = await scope(request.tenant).run(async (ctx) => {
        await ctx.tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`scheduling:${ctx.tenant.businessId}`}, 0))`,
        );
        const span = {
          start: start.getTime() - rules.bufferBeforeMinutes * MINUTE_MS,
          end: end.getTime() + rules.bufferAfterMinutes * MINUTE_MS,
        };
        // The service's clock, read under the lock: it ages the other holds, and stamps ours.
        const heldAt = clock();
        const others = await otherBookings(ctx, request.conversationId, span, heldAt);
        const clash = ownBusy(others, rules).some(
          (item) => item.start < span.end && span.start < item.end,
        );
        const dayCount =
          perDay(
            await otherBookings(
              ctx,
              request.conversationId,
              { start: start.getTime() - 86_400_000, end: start.getTime() + 86_400_000 },
              heldAt,
            ),
            facts.business.timeZone,
          ).get(slot.date) ?? 0;
        if (clash || (rules.maxPerDay !== null && dayCount >= rules.maxPerDay))
          return { kind: "taken" as const };
        const current = await activeBookingOf(ctx, request.conversationId);
        if (current?.status === "confirmed") {
          if (current.id !== moving?.id) return { kind: "changed" as const };
          // The booked time stands until the calendar has the new one; the new time is held
          // beside it meanwhile.
          const moveHold = {
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            slotId: slot.id,
            heldAt: heldAt.toISOString(),
          };
          await ctx.tx
            .update(bookings)
            .set({
              metadata: sql`${bookings.metadata} || ${JSON.stringify({ moveHold })}::jsonb`,
            })
            .where(eq(bookings.id, current.id));
          return { kind: "move" as const, booking: current };
        }
        if (moving !== null) return { kind: "changed" as const };
        if (current !== null) {
          // A hold of an earlier attempt that did not finish: take the new time on the same
          // booking, held from now (an old `heldAt` would let others take it at once). Its
          // calendar event may exist already at the earlier time (the attempt stopped after
          // creating it), so a different time is set on the event afterwards.
          await ctx.tx
            .update(bookings)
            .set({
              startsAt: start,
              endsAt: end,
              // A Calendly link left from before the business switched to a calendar becomes
              // this calendar's booking (no Calendly delivery can match it any more).
              provider: connection.provider,
              integrationConnectionId: connection.id,
              metadata: { ...current.metadata, slotId: slot.id, heldAt: heldAt.toISOString() },
            })
            .where(eq(bookings.id, current.id));
          return {
            kind: "new" as const,
            bookingId: current.id,
            version: versionOf(current),
            retime: current.metadata["slotId"] !== slot.id,
          };
        }
        const [row] = await ctx.tx
          .insert(bookings)
          .values({
            ...ctx.tenant,
            contactId: facts.contactId,
            conversationId: request.conversationId,
            leadId: facts.lead?.id ?? null,
            integrationConnectionId: connection.id,
            provider: connection.provider,
            status: "pending",
            startsAt: start,
            endsAt: end,
            timezone: facts.business.timeZone,
            title: meetingTypeLabel(values),
            metadata: { slotId: slot.id, version: 0, heldAt: heldAt.toISOString() },
          })
          .returning({ id: bookings.id });
        return { kind: "new" as const, bookingId: row!.id, version: 0, retime: false };
      });
      if (hold.kind === "taken") {
        return rejected(
          "Someone else just took that time. Get new times with offer_times and offer those; do not confirm this one.",
        );
      }
      if (hold.kind === "changed") {
        return rejected(
          "This customer's meeting changed while booking. Get times again with offer_times; do not confirm this one.",
        );
      }

      const config = calendarConfigOf(connection);
      const client = calendarClient(connection.provider);
      const draft = eventDraft({
        facts,
        values,
        start,
        end,
        appUrl: deps.appUrl,
        botName: values["persona.bot_name"],
      });
      const booked = label(facts, values, start);

      if (hold.kind === "move") {
        const booking = hold.booking;
        try {
          if (booking.externalEventId === null)
            throw new Error("The booking has no calendar event.");
          await client.moveEvent(token, {
            calendarId: config.bookingCalendarId,
            eventId: booking.externalEventId,
            start,
            end,
            timeZone: facts.business.timeZone,
            notifyAttendees: draft.attendees.length > 0,
          });
        } catch (error) {
          await vendorFailure(request, connection, error);
          await scope(request.tenant).run((ctx) =>
            ctx.tx
              .update(bookings)
              .set({ metadata: sql`${bookings.metadata} - 'moveHold'` })
              .where(eq(bookings.id, booking.id)),
          );
          return failed(
            "The meeting could not be moved in the calendar. The current time stands; do not confirm a new one. Tell the customer the team will be in touch about it.",
          );
        }
        const version = versionOf(booking) + 1;
        const moved = {
          version,
          slotId: slot.id,
          movedAt: clock().toISOString(),
          previous: {
            startsAt: booking.startsAt?.toISOString() ?? null,
            endsAt: booking.endsAt?.toISOString() ?? null,
          },
        };
        await scope(request.tenant).run((ctx) =>
          ctx.tx
            .update(bookings)
            .set({
              startsAt: start,
              endsAt: end,
              metadata: sql`(${bookings.metadata} - 'moveHold') || ${JSON.stringify(moved)}::jsonb`,
            })
            .where(eq(bookings.id, booking.id)),
        );
        await emit(
          bookingChangedEvent({
            tenant: request.tenant,
            traceId: request.traceId,
            bookingId: booking.id,
            version,
            change: "moved",
          }),
        );
        deps.logger.info("scheduling.moved", {
          traceId: request.traceId,
          businessId: request.tenant.businessId,
          bookingId: booking.id,
        });
        return applied(`Moved. The meeting is now ${booked}.`, {
          booked,
          previous: booking.startsAt === null ? null : label(facts, values, booking.startsAt),
          meeting: meetingTypeLabel(values),
        });
      }

      let created;
      try {
        created = await client.createEvent(token, {
          calendarId: config.bookingCalendarId,
          bookingId: hold.bookingId,
          event: draft,
          notifyAttendees: draft.attendees.length > 0,
        });
        if (hold.retime) {
          await client.moveEvent(token, {
            calendarId: config.bookingCalendarId,
            eventId: created.id,
            start,
            end,
            timeZone: facts.business.timeZone,
            notifyAttendees: draft.attendees.length > 0,
          });
        }
      } catch (error) {
        await vendorFailure(request, connection, error);
        await scope(request.tenant).run((ctx) =>
          ctx.tx
            .update(bookings)
            .set({
              status: "cancelled",
              cancelledAt: clock(),
              cancelReason: "The calendar could not be updated.",
            })
            .where(and(eq(bookings.id, hold.bookingId), eq(bookings.status, "pending"))),
        );
        return failed(
          "The meeting could not be put in the calendar. Do not confirm a time; tell the customer the team will contact them to confirm one.",
        );
      }
      const version = hold.version + 1;
      const confirmed = await scope(request.tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .update(bookings)
          .set({
            status: "confirmed",
            externalEventId: created.id,
            externalUrl: created.url,
            title: plainLine(draft.title, 200),
            location: draft.location,
            metadata: { slotId: slot.id, version, bookedAt: clock().toISOString() },
          })
          .where(and(eq(bookings.id, hold.bookingId), eq(bookings.status, "pending")))
          .returning({ id: bookings.id });
        if (rows.length === 0) return false;
        await setLeadBooked(ctx, request.conversationId, true);
        return true;
      });
      if (!confirmed) {
        // The hold was withdrawn meanwhile (the meeting was cancelled in another turn): the
        // event just made does not stand.
        await client
          .cancelEvent(token, {
            calendarId: config.bookingCalendarId,
            eventId: created.id,
            notifyAttendees: draft.attendees.length > 0,
          })
          .catch((error: unknown) => vendorFailure(request, connection, error));
        return failed(
          "The booking was withdrawn while it was being made. Do not confirm a time; get times again with offer_times if the customer still wants a meeting.",
        );
      }
      await emit(
        bookingChangedEvent({
          tenant: request.tenant,
          traceId: request.traceId,
          bookingId: hold.bookingId,
          version,
          change: "confirmed",
        }),
      );
      deps.logger.info("scheduling.booked", {
        traceId: request.traceId,
        businessId: request.tenant.businessId,
        bookingId: hold.bookingId,
        provider: connection.provider,
      });
      return applied(`Booked: ${booked}.`, {
        booked,
        meeting: meetingTypeLabel(values),
        minutes: values["scheduling.slot_minutes"],
        invited: draft.attendees.length > 0,
      });
    },

    async cancel(request) {
      const { values } = request;
      if (!values["scheduling.allow_cancel"]) {
        return rejected(
          "This business does not cancel meetings in chat. Tell the customer the team will take care of it, and hand the conversation to a person.",
        );
      }
      let found;
      try {
        found = await scope(request.tenant).run(async (ctx) => {
          const facts = await loadConversationFacts(ctx, request.conversationId);
          const existing = await activeBookingOf(ctx, request.conversationId);
          if (facts === null || existing === null) return null;
          if (facts.takeover) return "takeover" as const;
          const connection =
            existing.integrationConnectionId === null
              ? null
              : await activeConnection(ctx, existing.provider as SchedulingProvider);
          const token =
            connection !== null &&
            connection.id === existing.integrationConnectionId &&
            existing.status === "confirmed"
              ? await accessToken(deps, ctx, connection)
              : null;
          return { facts, existing, connection, token };
        });
      } catch (error) {
        if (
          (error instanceof CalendarApiError && error.authFailed) ||
          error instanceof ConfigError
        ) {
          return unavailable(
            values,
            "the calendar is not connected, so the meeting cannot be cancelled in chat",
          );
        }
        throw error;
      }
      if (found === null) {
        return rejected(
          "This customer has no booked meeting in this conversation. Ask which meeting they mean, or hand the conversation to a person if it was booked another way.",
        );
      }
      if (found === "takeover") return TAKEN_OVER;
      const { facts, existing, connection, token } = found;
      if (existing.status !== "confirmed" || existing.startsAt === null) {
        // A Calendly link that was never used, or a time held by a booking that never
        // finished: withdraw it. No meeting exists.
        if (request.mode === "live") {
          await scope(request.tenant).run((ctx) =>
            ctx.tx
              .update(bookings)
              .set({
                status: "cancelled",
                cancelledAt: clock(),
                cancelReason: plainLine(request.reason, 200),
              })
              .where(and(eq(bookings.id, existing.id), eq(bookings.status, "pending"))),
          );
        }
        return applied(
          existing.startsAt === null
            ? "No meeting was booked yet; the scheduling link is withdrawn."
            : "No meeting was booked yet, so there is nothing to cancel.",
          { cancelled: null },
        );
      }
      const gate = changeGate(values, existing, request.now, "cancel");
      if (gate !== null) return gate;
      const when = label(facts, values, existing.startsAt);
      if (request.mode === "dry_run")
        return applied("The meeting would be cancelled.", { cancelled: when });
      if (connection === null || token === null || existing.externalEventId === null) {
        return unavailable(
          values,
          "the calendar is not connected, so the meeting cannot be cancelled in chat",
        );
      }
      try {
        if (existing.provider === "calendly") {
          await clients.calendly.cancelEvent(token, existing.externalEventId, request.reason);
        } else {
          await calendarClient(connection.provider).cancelEvent(token, {
            calendarId: calendarConfigOf(connection).bookingCalendarId,
            eventId: existing.externalEventId,
            notifyAttendees: true,
          });
        }
      } catch (error) {
        await vendorFailure(request, connection, error);
        return failed(
          "The meeting could not be cancelled in the calendar. It still stands; tell the customer the team will take care of it.",
        );
      }
      const version = versionOf(existing) + 1;
      await scope(request.tenant).run(async (ctx) => {
        await ctx.tx
          .update(bookings)
          .set({
            status: "cancelled",
            cancelledAt: clock(),
            cancelReason: plainLine(request.reason, 200),
            metadata: { ...existing.metadata, version },
          })
          .where(eq(bookings.id, existing.id));
        await setLeadBooked(ctx, request.conversationId, false);
      });
      await emit(
        bookingChangedEvent({
          tenant: request.tenant,
          traceId: request.traceId,
          bookingId: existing.id,
          version,
          change: "cancelled",
        }),
      );
      deps.logger.info("scheduling.cancelled", {
        traceId: request.traceId,
        businessId: request.tenant.businessId,
        bookingId: existing.id,
      });
      return applied(`Cancelled: the meeting on ${when} is off.`, { cancelled: when });
    },

    async releaseAbandonedHolds(tenant) {
      const now = clock();
      const before = new Date(now.getTime() - ABANDONED_HOLD_MS).toISOString();
      const stale = await scope(tenant).run((ctx) =>
        ctx.tx
          .update(bookings)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelReason: "The booking did not finish; its hold was released.",
          })
          .where(
            and(
              eq(bookings.status, "pending"),
              inArray(bookings.provider, ["google_calendar", "outlook_calendar"]),
              sql`coalesce((${bookings.metadata} ->> 'heldAt')::timestamptz, ${bookings.createdAt}) < ${before}::timestamptz`,
            ),
          )
          .returning({
            id: bookings.id,
            provider: bookings.provider,
            startsAt: bookings.startsAt,
            conversationId: bookings.conversationId,
            externalEventId: bookings.externalEventId,
          }),
      );
      const moves = await scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select({ id: bookings.id, conversationId: bookings.conversationId })
          .from(bookings)
          .where(
            and(
              eq(bookings.status, "confirmed"),
              sql`(${bookings.metadata} -> 'moveHold' ->> 'heldAt')::timestamptz < ${before}::timestamptz`,
            ),
          );
        for (const row of rows) {
          await ctx.tx
            .update(bookings)
            .set({ metadata: sql`${bookings.metadata} - 'moveHold'` })
            .where(eq(bookings.id, row.id));
        }
        return rows;
      });

      let eventsRemoved = 0;
      let alerted = 0;
      const alert = (
        bookingId: string,
        conversationId: string | null,
        subject: string,
        startsAt: Date | null,
      ) =>
        scope(tenant).run(async (ctx) => {
          await ctx.tx
            .insert(alerts)
            .values({
              ...ctx.tenant,
              conversationId: conversationId as never,
              kind: "calendar_hold_abandoned",
              severity: "warning",
              channel: "in_app",
              recipient: "agency",
              subject,
              payload: { bookingId, startsAt: startsAt?.toISOString() ?? null },
              dedupeKey: `calendar_hold_abandoned:${bookingId}`,
            })
            .onConflictDoNothing();
          alerted += 1;
        });

      for (const hold of stale) {
        const provider = hold.provider as SchedulingProvider;
        const eventId =
          provider === "google_calendar" ? googleEventId(hold.id) : hold.externalEventId;
        let removed = false;
        if (eventId !== null) {
          try {
            const ready = await scope(tenant).run(async (ctx) => {
              const connection = await activeConnection(ctx, provider);
              if (connection === null) return null;
              return { connection, token: await accessToken(deps, ctx, connection) };
            });
            if (ready !== null) {
              // Deleting an event that was never made is "already gone": done.
              await calendarClient(provider).cancelEvent(ready.token, {
                calendarId: calendarConfigOf(ready.connection).bookingCalendarId,
                eventId,
                notifyAttendees: true,
              });
              removed = true;
              eventsRemoved += 1;
            }
          } catch (error) {
            deps.logger.warn("scheduling.abandoned_hold_cleanup_failed", {
              businessId: tenant.businessId,
              bookingId: hold.id,
              error,
            });
          }
        }
        if (!removed) {
          await alert(
            hold.id,
            hold.conversationId,
            "A booking did not finish. Check the calendar for an event at this time and delete it if it is there.",
            hold.startsAt,
          );
        }
      }
      for (const move of moves) {
        await alert(
          move.id,
          move.conversationId,
          "Moving a meeting did not finish. Check that the calendar event is at the time the conversation shows.",
          null,
        );
      }
      if (stale.length > 0 || moves.length > 0) {
        deps.logger.warn("scheduling.abandoned_holds", {
          businessId: tenant.businessId,
          released: stale.length,
          eventsRemoved,
          movesAlerted: moves.length,
        });
      }
      return { released: stale.length, eventsRemoved, alerted };
    },
  };
}
