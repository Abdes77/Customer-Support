import type { ConversationId, LeadId } from "@repo/core";
import { alerts, and, type BusinessContext, bookings, eq, gt, inArray, lt, sql } from "@repo/db";
import { type AnyJobEvent, defineCronJob, defineEventJob, type JobDefinition } from "@repo/jobs";
import { type AppSettings, renderTemplate } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { addDays, localMoment, meetingLabel, MINUTE_MS, minutesOf, zonedInstant } from "../time";
import { bookingChangedEvent, createBookingService } from "./bookings";
import { activeConnection } from "./connections";
import { clockOf, type OutboundMessages, type SchedulingDeps } from "./deps";
import { meetingTypeLabel } from "./event-text";
import { loadConversationFacts } from "./facts";

/*
 * Durable functions of scheduling (ARCHITECTURE §4):
 * - `scheduling-reminders`: per booking change, plans the reminders of that version of the
 *   booking and sends each at its time (`sleepUntil`). A later change raises the version, so
 *   a moved or cancelled meeting's old run finds itself outdated and sends nothing.
 * - `scheduling-meeting-requested`: subscriber to `lead.meeting_requested`; an in-app alert
 *   when the team has to book by hand, or when no meeting was booked in time.
 * - `scheduling-reminder-sweep`: hourly, emits the booking event again for a confirmed
 *   booking whose reminders were never planned (the event after the booking was lost).
 */

export const REMINDERS_FUNCTION_ID = "scheduling-reminders";
export const MEETING_REQUESTED_FUNCTION_ID = "scheduling-meeting-requested";
export const REMINDER_SWEEP_FUNCTION_ID = "scheduling-reminder-sweep";

/** A reminder that would land later than this before the meeting is not worth sending. */
const LAST_USEFUL_MINUTES = 30;

export interface PlannedReminder {
  readonly at: string;
  readonly minutesBefore: number;
  readonly first: boolean;
}

/** When quiet hours end, if `at` falls inside them in `timeZone`; else null. */
export function quietHoursEnd(
  at: Date,
  timeZone: string,
  quiet: AppSettings["hours.quiet_hours"],
): Date | null {
  if (!quiet.enabled || quiet.start === quiet.end) return null;
  const local = localMoment(at, timeZone);
  const minute = minutesOf(local.time);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const date = start > end && minute >= start ? addDays(local.date, 1) : local.date;
  return zonedInstant(date, quiet.end, timeZone);
}

/**
 * The reminders of a meeting: one per `scheduling.reminder_minutes_before`, earliest first,
 * none in the past. One that falls in the customer's quiet hours waits until they end, and
 * is dropped when that is too close to the meeting (or to the next reminder).
 */
export function planReminders(input: {
  readonly start: Date;
  readonly now: Date;
  readonly values: Pick<
    AppSettings,
    "scheduling.reminders" | "scheduling.reminder_minutes_before" | "hours.quiet_hours"
  >;
  readonly customerTimeZone: string;
}): PlannedReminder[] {
  const { values } = input;
  if (!values["scheduling.reminders"]) return [];
  const latest = input.start.getTime() - LAST_USEFUL_MINUTES * MINUTE_MS;
  const out: { at: number; minutesBefore: number }[] = [];
  const minutes = [...new Set(values["scheduling.reminder_minutes_before"])].sort((a, b) => b - a);
  for (const before of minutes) {
    let at = input.start.getTime() - before * MINUTE_MS;
    if (at <= input.now.getTime()) continue;
    const quietEnd = quietHoursEnd(
      new Date(at),
      input.customerTimeZone,
      values["hours.quiet_hours"],
    );
    if (quietEnd !== null) at = quietEnd.getTime();
    if (at > latest) continue;
    const previous = out.at(-1);
    if (previous !== undefined && at - previous.at < LAST_USEFUL_MINUTES * MINUTE_MS) continue;
    out.push({ at, minutesBefore: before });
  }
  return out.map((item, index) => ({
    at: new Date(item.at).toISOString(),
    minutesBefore: item.minutesBefore,
    first: index === 0,
  }));
}

export function reminderText(input: {
  readonly values: AppSettings;
  readonly businessName: string;
  readonly when: string;
  readonly first: boolean;
}): string {
  const { values } = input;
  const main = renderTemplate(values["scheduling.reminder_message"], {
    meeting_type: meetingTypeLabel(values).toLowerCase(),
    meeting_time: input.when,
    business_name: input.businessName,
    bot_name: values["persona.bot_name"],
  }).trim();
  const ask =
    input.first && values["scheduling.reminder_asks_confirmation"]
      ? ` ${values["scheduling.reminder_confirm_message"].trim()}`
      : "";
  return `${main}${ask}`;
}

async function raiseAlert(
  ctx: BusinessContext,
  alert: {
    readonly kind: string;
    readonly conversationId: ConversationId;
    readonly leadId: LeadId;
    readonly subject: string;
    readonly dedupeKey: string;
  },
): Promise<void> {
  await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: alert.conversationId,
      leadId: alert.leadId,
      kind: alert.kind,
      severity: "warning",
      channel: "in_app",
      recipient: "agency",
      subject: alert.subject,
      payload: { conversationId: alert.conversationId, leadId: alert.leadId },
      dedupeKey: alert.dedupeKey,
    })
    .onConflictDoNothing();
}

function versionOf(metadata: Record<string, unknown>): number {
  const value = metadata["version"];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export interface SchedulingJobOptions {
  /** Days ahead the sweep looks for bookings without planned reminders. */
  readonly sweepDaysAhead?: number;
}

export function createSchedulingJobs(
  deps: SchedulingDeps & { readonly outbound: OutboundMessages },
  options: SchedulingJobOptions = {},
): JobDefinition[] {
  const clock = clockOf(deps);
  const log = deps.logger.child({ component: "scheduling-jobs" });
  const holds = createBookingService(deps);

  const reminders = defineEventJob({
    id: REMINDERS_FUNCTION_ID,
    name: "Scheduling: meeting reminders",
    trigger: { event: "scheduling.booking_changed" },
    concurrency: { key: "event.data.bookingId", limit: 1 },
    retries: 4,
    async handler({ event, step }) {
      const { agencyId, businessId, bookingId, version } = event.data;
      const scope = deps.db.forBusiness(businessId, { agencyId });
      const plan = await step.run("plan", () =>
        scope.run(async (ctx) => {
          const [booking] = await ctx.tx
            .select({
              status: bookings.status,
              startsAt: bookings.startsAt,
              conversationId: bookings.conversationId,
              metadata: bookings.metadata,
            })
            .from(bookings)
            .where(eq(bookings.id, bookingId))
            .limit(1);
          if (
            booking?.status !== "confirmed" ||
            booking.startsAt === null ||
            booking.conversationId === null ||
            versionOf(booking.metadata) !== version
          ) {
            return { reminders: [] as PlannedReminder[], reason: "outdated" };
          }
          const settings = await loadSettings(ctx, { agencyId, businessId }, { logger: log });
          const facts = await loadConversationFacts(ctx, booking.conversationId);
          const planned = planReminders({
            start: booking.startsAt,
            now: clock(),
            values: settings.values,
            customerTimeZone: facts?.customer.timeZone ?? "America/New_York",
          });
          await ctx.tx
            .update(bookings)
            .set({
              metadata: sql`${bookings.metadata} || ${JSON.stringify({ remindersPlanned: version })}::jsonb`,
            })
            .where(eq(bookings.id, bookingId));
          return { reminders: planned, reason: planned.length === 0 ? "none_due" : "planned" };
        }),
      );
      let sent = 0;
      for (const reminder of plan.reminders) {
        await step.sleepUntil(`wait-${reminder.minutesBefore}`, new Date(reminder.at));
        const delivered = await step.run(`remind-${reminder.minutesBefore}`, async () => {
          const events = await scope.run(async (ctx): Promise<AnyJobEvent[] | null> => {
            const [booking] = await ctx.tx
              .select({
                status: bookings.status,
                startsAt: bookings.startsAt,
                conversationId: bookings.conversationId,
                metadata: bookings.metadata,
              })
              .from(bookings)
              .where(eq(bookings.id, bookingId))
              .for("update")
              .limit(1);
            const key = `${version}:${reminder.minutesBefore}`;
            const already = Array.isArray(booking?.metadata["remindersSent"])
              ? (booking.metadata["remindersSent"] as unknown[])
              : [];
            if (
              booking?.status !== "confirmed" ||
              booking.startsAt === null ||
              booking.conversationId === null ||
              versionOf(booking.metadata) !== version ||
              already.includes(key)
            ) {
              return null;
            }
            const settings = await loadSettings(ctx, { agencyId, businessId }, { logger: log });
            if (!settings.values["scheduling.reminders"]) return null;
            const facts = await loadConversationFacts(ctx, booking.conversationId);
            if (facts === null) return null;
            // Woken late (a delayed run, a retried step): a reminder at the meeting or after
            // it, or inside the customer's quiet hours, is not sent.
            const now = clock();
            if (
              booking.startsAt.getTime() - now.getTime() < (LAST_USEFUL_MINUTES / 2) * MINUTE_MS ||
              quietHoursEnd(now, facts.customer.timeZone, settings.values["hours.quiet_hours"]) !==
                null
            ) {
              return null;
            }
            const text = reminderText({
              values: settings.values,
              businessName: facts.business.name,
              when: meetingLabel({
                start: booking.startsAt,
                arrivalWindowMinutes: settings.values["scheduling.arrival_window_minutes"],
                timeZone: facts.customer.timeZone,
                businessTimeZone: facts.business.timeZone,
              }),
              first: reminder.first,
            });
            const queued = await deps.outbound.enqueue(ctx, {
              conversationId: booking.conversationId,
              text,
              traceId: event.data.traceId,
              purpose: "reminder",
            });
            await ctx.tx
              .update(bookings)
              .set({ metadata: { ...booking.metadata, remindersSent: [...already, key] } })
              .where(eq(bookings.id, bookingId));
            return queued === null ? [] : [...queued.events];
          });
          // A lost send event is re-emitted by the pipeline's sweeper (the message is queued).
          if (events !== null && events.length > 0) await deps.events?.send(events);
          return events !== null;
        });
        if (delivered) sent += 1;
      }
      return { planned: plan.reminders.length, sent, reason: plan.reason };
    },
    async onFailure({ event, error }) {
      log.error("scheduling.reminders_failed", {
        businessId: event.data.businessId,
        bookingId: event.data.bookingId,
        error: error.message,
      });
    },
  });

  const meetingRequested = defineEventJob({
    id: MEETING_REQUESTED_FUNCTION_ID,
    name: "Scheduling: follow a meeting request",
    trigger: { event: "lead.meeting_requested" },
    retries: 4,
    async handler({ event, step }) {
      const { agencyId, businessId, conversationId, leadId, bookingMode } = event.data;
      const scope = deps.db.forBusiness(businessId, { agencyId });
      const first = await step.run("check", () =>
        scope.run(async (ctx) => {
          const settings = await loadSettings(ctx, { agencyId, businessId }, { logger: log });
          const hours = settings.values["scheduling.unbooked_alert_hours"];
          if (hours === null) return { waitUntil: null, alerted: false };
          const provider = settings.values["scheduling.provider"];
          const connected = provider !== "none" && (await activeConnection(ctx, provider)) !== null;
          if (bookingMode === "manual" || provider === "none" || !connected) {
            await raiseAlert(ctx, {
              kind: "meeting_to_book",
              conversationId,
              leadId,
              subject:
                provider === "none" || bookingMode === "manual"
                  ? "A lead wants a meeting: book it with them (no calendar is connected)."
                  : "A lead wants a meeting, but the calendar is not connected: book it with them.",
              dedupeKey: `meeting_to_book:${leadId}`,
            });
            return { waitUntil: null, alerted: true };
          }
          return {
            waitUntil: new Date(clock().getTime() + hours * 3_600_000).toISOString(),
            alerted: false,
          };
        }),
      );
      if (first.waitUntil === null) return { alerted: first.alerted };
      await step.sleepUntil("wait-for-booking", new Date(first.waitUntil));
      const alerted = await step.run("verify", () =>
        scope.run(async (ctx) => {
          const [booking] = await ctx.tx
            .select({ id: bookings.id })
            .from(bookings)
            .where(
              and(eq(bookings.conversationId, conversationId), eq(bookings.status, "confirmed")),
            )
            .limit(1);
          if (booking !== undefined) return false;
          await raiseAlert(ctx, {
            kind: "meeting_not_booked",
            conversationId,
            leadId,
            subject: "A lead who should be booked has no meeting yet: follow up with them.",
            dedupeKey: `meeting_not_booked:${leadId}`,
          });
          return true;
        }),
      );
      return { alerted };
    },
    async onFailure({ event, error }) {
      log.error("scheduling.meeting_requested_failed", {
        businessId: event.data.businessId,
        leadId: event.data.leadId,
        error: error.message,
      });
    },
  });

  const sweep = defineCronJob({
    id: REMINDER_SWEEP_FUNCTION_ID,
    name: "Scheduling: plan missing reminders",
    trigger: { cron: "23 * * * *" },
    retries: 2,
    async handler({ step }) {
      const businesses = await step.run("businesses", () => deps.db.directory.listBusinesses());
      let emitted = 0;
      let released = 0;
      for (const business of businesses) {
        const events = await step.run(`sweep-${business.businessId}`, () =>
          deps.db
            .forBusiness(business.businessId, { agencyId: business.agencyId })
            .run(async (ctx) => {
              const now = clock();
              const rows = await ctx.tx
                .select({ id: bookings.id, metadata: bookings.metadata })
                .from(bookings)
                .where(
                  and(
                    inArray(bookings.status, ["confirmed"]),
                    gt(bookings.startsAt, now),
                    lt(
                      bookings.startsAt,
                      new Date(now.getTime() + (options.sweepDaysAhead ?? 30) * 86_400_000),
                    ),
                    sql`coalesce((${bookings.metadata} ->> 'remindersPlanned')::int, -1) <> coalesce((${bookings.metadata} ->> 'version')::int, 0)`,
                  ),
                )
                .limit(200);
              return rows.map((row) =>
                bookingChangedEvent({
                  tenant: business,
                  traceId: crypto.randomUUID(),
                  bookingId: row.id,
                  version: versionOf(row.metadata),
                  change: "confirmed",
                }),
              );
            }),
        );
        if (events.length > 0 && deps.events !== null) {
          await step.run(`emit-${business.businessId}`, async () => {
            await deps.events?.send(events);
            return events.length;
          });
          emitted += events.length;
        }
        // Holds of booking attempts that stopped and were never retried (C17).
        released += await step.run(`holds-${business.businessId}`, async () => {
          try {
            return (await holds.releaseAbandonedHolds(business)).released;
          } catch (error) {
            deps.logger.error("scheduling.abandoned_holds_failed", {
              businessId: business.businessId,
              error,
            });
            return 0;
          }
        });
      }
      return { emitted, released };
    },
  });

  return [reminders, meetingRequested, sweep];
}
