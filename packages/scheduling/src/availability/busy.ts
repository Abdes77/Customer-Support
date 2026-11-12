import type { AppSettings } from "@repo/settings";

import { startOfLocalDay } from "../time";

/** A span of time in epoch milliseconds, end exclusive. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * One event of a connected calendar, as the providers report it. Nothing about the event's
 * content (title, people, place) is read: only when it is and whether it blocks time.
 */
export type CalendarEvent =
  | {
      readonly allDay: false;
      readonly start: string;
      readonly end: string;
      /** busy, tentative (not yet accepted, or shown as tentative), free. */
      readonly status: CalendarEventStatus;
    }
  | {
      readonly allDay: true;
      /** "YYYY-MM-DD", the first day. */
      readonly startDate: string;
      /** "YYYY-MM-DD", the day after the last day (exclusive, as both providers report it). */
      readonly endDate: string;
      readonly status: CalendarEventStatus;
    };

export type CalendarEventStatus = "busy" | "tentative" | "free";

/**
 * The spans a calendar's events keep from being offered. A free event (Google
 * "transparent", Outlook "free" or "working elsewhere", an invitation the owner declined)
 * blocks nothing; a tentative one blocks per `scheduling.tentative_events`; an all-day one
 * blocks its whole days (in the business's time zone) per `scheduling.all_day_events`.
 */
export function busyIntervals(
  events: readonly CalendarEvent[],
  values: Pick<AppSettings, "scheduling.tentative_events" | "scheduling.all_day_events">,
  timeZone: string,
): Interval[] {
  const out: Interval[] = [];
  const blocks = (status: CalendarEventStatus) =>
    status === "busy" ||
    (status === "tentative" && values["scheduling.tentative_events"] === "busy");
  for (const event of events) {
    if (event.allDay) {
      const mode = values["scheduling.all_day_events"];
      if (mode === "ignore") continue;
      if (mode === "as_marked" && !blocks(event.status)) continue;
      const start = startOfLocalDay(event.startDate, timeZone).getTime();
      const end = startOfLocalDay(event.endDate, timeZone).getTime();
      if (end > start) out.push({ start, end });
      continue;
    }
    if (!blocks(event.status)) continue;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function overlaps(busy: readonly Interval[], span: Interval): boolean {
  return busy.some((item) => item.start < span.end && span.start < item.end);
}
