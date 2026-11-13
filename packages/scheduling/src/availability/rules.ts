import { hoursOn } from "@repo/ai";
import type { AppSettings, TimeInterval, Weekday } from "@repo/settings";

import { weekdayOf } from "../time";

/** The scheduling settings a slot computation reads, by key. */
export type SchedulingValues = Pick<
  AppSettings,
  | "hours.weekly"
  | "hours.holidays"
  | "hours.us_federal_holidays"
  | "scheduling.slot_minutes"
  | "scheduling.slot_interval_minutes"
  | "scheduling.buffer_before_minutes"
  | "scheduling.buffer_after_minutes"
  | "scheduling.min_lead_time_hours"
  | "scheduling.max_days_ahead"
  | "scheduling.hours_source"
  | "scheduling.custom_hours"
  | "scheduling.skip_holidays"
  | "scheduling.max_meetings_per_day"
  | "scheduling.arrival_window_minutes"
  | "scheduling.travel_rules"
  | "scheduling.tentative_events"
  | "scheduling.all_day_events"
>;

export interface TravelRuleMatch {
  readonly name: string;
  readonly days: readonly Weekday[];
  readonly extraMinutes: number;
}

/** Everything that decides which times can be offered, worked out once from the settings. */
export interface SlotRules {
  /** How long the meeting itself takes. */
  readonly meetingMinutes: number;
  /** The arrival window shown to the customer, or null for an exact time. */
  readonly arrivalWindowMinutes: number | null;
  /**
   * How long a booking holds the calendar: the arrival window plus the meeting (the visit can
   * start at the end of the window), or the meeting alone.
   */
  readonly occupiedMinutes: number;
  readonly stepMinutes: number;
  /** Free time kept before and after, a travel rule's extra time included. */
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly minLeadHours: number;
  readonly maxDaysAhead: number;
  readonly maxPerDay: number | null;
  /** The travel rule of the customer's ZIP code, when one applies. */
  readonly travel: TravelRuleMatch | null;
  /** Meeting hours of one local date, sorted, holidays applied per the settings. */
  meetingHours(date: string): readonly TimeInterval[];
}

function sorted(intervals: readonly TimeInterval[]): TimeInterval[] {
  return [...intervals].sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0));
}

/** The parts of `a` that lie inside some interval of `b`. */
function intersect(a: readonly TimeInterval[], b: readonly TimeInterval[]): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const left of a) {
    for (const right of b) {
      const open = left.open > right.open ? left.open : right.open;
      const close = left.close < right.close ? left.close : right.close;
      if (open < close) out.push({ open, close });
    }
  }
  return sorted(out);
}

/**
 * The five-digit ZIP code in a location the customer gave ("1200 Elm St, Austin, TX 78704"):
 * the last one, which is where a US address puts it.
 */
export function zipCodeOf(location: string | null | undefined): string | null {
  if (location === null || location === undefined) return null;
  const matches = location.match(/(?<!\d)\d{5}(?:-\d{4})?(?!\d)/g) ?? [];
  return matches.at(-1)?.slice(0, 5) ?? null;
}

export function travelRuleFor(
  values: Pick<AppSettings, "scheduling.travel_rules">,
  zip: string | null,
): TravelRuleMatch | null {
  if (zip === null) return null;
  const rule = values["scheduling.travel_rules"].find((entry) => entry.zip_codes.includes(zip));
  if (rule === undefined) return null;
  return { name: rule.name, days: [...rule.days], extraMinutes: rule.extra_travel_minutes };
}

export function slotRules(
  values: SchedulingValues,
  options: { readonly zip: string | null },
): SlotRules {
  const travel = travelRuleFor(values, options.zip);
  const extra = travel?.extraMinutes ?? 0;
  const window = values["scheduling.arrival_window_minutes"];
  const meeting = values["scheduling.slot_minutes"];
  return {
    meetingMinutes: meeting,
    arrivalWindowMinutes: window,
    occupiedMinutes: meeting + (window ?? 0),
    stepMinutes: values["scheduling.slot_interval_minutes"],
    bufferBeforeMinutes: values["scheduling.buffer_before_minutes"] + extra,
    bufferAfterMinutes: values["scheduling.buffer_after_minutes"] + extra,
    minLeadHours: values["scheduling.min_lead_time_hours"],
    maxDaysAhead: values["scheduling.max_days_ahead"],
    maxPerDay: values["scheduling.max_meetings_per_day"],
    travel,
    meetingHours(date) {
      const skip = values["scheduling.skip_holidays"];
      const weekday = weekdayOf(date);
      const business = hoursOn(values, date);
      if (values["scheduling.hours_source"] === "business_hours") {
        // Without "no meetings on closed days" the plain weekly hours apply on holidays too.
        return skip ? business.intervals : sorted(values["hours.weekly"][weekday] ?? []);
      }
      const custom = sorted(values["scheduling.custom_hours"][weekday] ?? []);
      if (!skip || business.holiday === null) return custom;
      // A closed day has no meetings; a day with special hours keeps the meeting hours that
      // fall inside them.
      return intersect(custom, business.intervals);
    },
  };
}
