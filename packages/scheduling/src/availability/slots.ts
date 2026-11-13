import {
  addDays,
  HOUR_MS,
  localMoment,
  MINUTE_MS,
  minutesOf,
  timeOf,
  wallClockInstant,
  weekdayOf,
  zonedInstant,
} from "../time";
import { type Interval, overlaps } from "./busy";
import type { Preference, SlotMoment } from "./preference";
import type { SlotRules } from "./rules";

/**
 * Free meeting times: every start on the step grid of each meeting-hours interval of each
 * local date from today to `max_days_ahead`, that starts after the minimum lead time, fits
 * inside the interval with its arrival window and meeting, keeps its buffers clear of every
 * busy span (the calendar's events and the business's own bookings), and falls on a day with
 * room left under `max_meetings_per_day` and allowed by the customer's travel rule.
 */

export interface Slot extends SlotMoment {
  /** Stable id the model passes back to `book_meeting`: the start in UTC, "2026-11-17T15:00Z". */
  readonly id: string;
  /** Start of the meeting (or of the arrival window), ISO 8601 UTC. */
  readonly start: string;
  /** End of the time the booking holds, ISO 8601 UTC. */
  readonly end: string;
}

export function slotIdOf(start: Date): string {
  return `${start.toISOString().slice(0, 16)}Z`;
}

/** The start instant of a slot id, or null when the id is not one. */
export function parseSlotId(id: string): Date | null {
  const match = /^(?:slot[-_:])?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/.exec(id.trim());
  if (match === null) return null;
  const instant = new Date(`${match[1]}:00.000Z`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

export interface SlotSearch {
  readonly rules: SlotRules;
  readonly timeZone: string;
  readonly now: Date;
  /** Calendar events and the business's own active bookings, as busy spans. */
  readonly busy: readonly Interval[];
  /** The business's active bookings per local date, for `max_meetings_per_day`. */
  readonly bookingsPerDay: ReadonlyMap<string, number>;
}

/** The latest local date a meeting may fall on. */
export function lastBookableDate(rules: SlotRules, timeZone: string, now: Date): string {
  return addDays(localMoment(now, timeZone).date, rules.maxDaysAhead);
}

/** The span from `now` that a slot search reads from the calendar. */
export function searchWindow(rules: SlotRules, timeZone: string, now: Date): Interval {
  const lastDate = addDays(lastBookableDate(rules, timeZone, now), 1);
  // A day before and after, for buffers and all-day events around the edges.
  return {
    start: now.getTime() - 24 * HOUR_MS,
    // `zonedInstant`, not `wallClockInstant`: in a zone whose clocks change at midnight that
    // midnight does not exist, and the window must still reach the last bookable day.
    end: zonedInstant(lastDate, "00:00", timeZone).getTime() + 48 * HOUR_MS,
  };
}

function free(search: SlotSearch, start: Date, end: Date): boolean {
  const { rules } = search;
  return !overlaps(search.busy, {
    start: start.getTime() - rules.bufferBeforeMinutes * MINUTE_MS,
    end: end.getTime() + rules.bufferAfterMinutes * MINUTE_MS,
  });
}

/** Every free slot, in time order. */
export function freeSlots(search: SlotSearch): Slot[] {
  const { rules, timeZone, now } = search;
  const today = localMoment(now, timeZone).date;
  const lastDate = lastBookableDate(rules, timeZone, now);
  const earliest = now.getTime() + rules.minLeadHours * HOUR_MS;
  const out: Slot[] = [];
  for (let date = today; date <= lastDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    if (rules.travel !== null && !rules.travel.days.includes(weekday)) continue;
    if (rules.maxPerDay !== null && (search.bookingsPerDay.get(date) ?? 0) >= rules.maxPerDay) {
      continue;
    }
    for (const interval of rules.meetingHours(date)) {
      const open = minutesOf(interval.open);
      const close = minutesOf(interval.close);
      for (
        let minute = open;
        minute + rules.occupiedMinutes <= close;
        minute += rules.stepMinutes
      ) {
        const start = wallClockInstant(date, timeOf(minute), timeZone);
        if (start === null || start.getTime() < earliest) continue;
        const end = new Date(start.getTime() + rules.occupiedMinutes * MINUTE_MS);
        if (!free(search, start, end)) continue;
        out.push({
          id: slotIdOf(start),
          start: start.toISOString(),
          end: end.toISOString(),
          date,
          weekday,
          minutes: minute,
        });
      }
    }
  }
  return out;
}

/** Whether one start time is a free slot under the same rules (checked again at booking). */
export function findSlot(search: SlotSearch, start: Date): Slot | null {
  const id = slotIdOf(start);
  return freeSlots(search).find((slot) => slot.id === id) ?? null;
}

function partOfDay(minutes: number): "morning" | "afternoon" | "evening" {
  if (minutes < 12 * 60) return "morning";
  if (minutes < 17 * 60) return "afternoon";
  return "evening";
}

/**
 * The slots to offer: those matching the preference (all of them when none match), then
 * `count` of them, earliest first. With `spread`, each pick prefers a day not used yet, then
 * a part of the day not used yet on that day, so the customer gets a real choice instead of
 * 9:00, 9:30 and 10:00 on the same morning.
 */
export function pickOffers(
  slots: readonly Slot[],
  options: {
    readonly count: number;
    readonly spread: boolean;
    /** A `Preference`, or one that reads each slot in another time zone. */
    readonly preference: Pick<Preference, "understood"> & {
      matches(slot: Slot): boolean;
    };
  },
): { readonly offers: Slot[]; readonly matchedPreference: boolean } {
  const matching = slots.filter((slot) => options.preference.matches(slot));
  const matchedPreference = !options.preference.understood || matching.length > 0;
  const pool = matching.length > 0 ? matching : [...slots];
  if (!options.spread) return { offers: pool.slice(0, options.count), matchedPreference };

  const chosen: Slot[] = [];
  const days = new Set<string>();
  const parts = new Set<string>();
  const passes: ((slot: Slot) => boolean)[] = [
    (slot) => !days.has(slot.date),
    (slot) => !parts.has(`${slot.date}:${partOfDay(slot.minutes)}`),
    () => true,
  ];
  for (const pass of passes) {
    for (const slot of pool) {
      if (chosen.length >= options.count) break;
      if (chosen.includes(slot) || !pass(slot)) continue;
      chosen.push(slot);
      days.add(slot.date);
      parts.add(`${slot.date}:${partOfDay(slot.minutes)}`);
    }
  }
  chosen.sort((a, b) => a.start.localeCompare(b.start));
  return { offers: chosen, matchedPreference };
}
