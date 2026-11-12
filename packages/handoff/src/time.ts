import { businessHoursState, localMoment, zonedInstant } from "@repo/ai";
import type { AppSettings } from "@repo/settings";

import { timeZoneOfPhone } from "./area-codes";

/*
 * Time rules of handoff, on the service's clock (always an argument; never Date.now()).
 * Quiet hours are in the customer's time zone; business hours in the business's.
 */

export const MINUTE_MS = 60_000;

export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (timeZone === null || timeZone === undefined || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The customer's time zone for quiet hours: the contact's own when known, else (with
 * `hours.customer_time_zone` = "phone_area_code") the zone of a US number's area code, else
 * the business's.
 */
export function customerTimeZone(input: {
  readonly contactTimeZone: string | null;
  readonly phone: string | null;
  readonly businessTimeZone: string;
  readonly mode: AppSettings["hours.customer_time_zone"];
}): string {
  if (isValidTimeZone(input.contactTimeZone)) return input.contactTimeZone;
  if (input.mode === "phone_area_code") {
    const zone = timeZoneOfPhone(input.phone);
    if (zone !== null) return zone;
  }
  return isValidTimeZone(input.businessTimeZone) ? input.businessTimeZone : "America/New_York";
}

/** True when `at` falls inside a daily window ("21:00" to "08:00" wraps midnight). */
function insideWindow(at: Date, timeZone: string, start: string, end: string): boolean {
  const minute = minutesOf(localMoment(at, timeZone).time);
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** When a daily window that contains `at` ends, in `timeZone`; null when `at` is outside. */
export function windowEnd(
  at: Date,
  timeZone: string,
  window: { readonly enabled: boolean; readonly start: string; readonly end: string },
): Date | null {
  if (!window.enabled || window.start === window.end) return null;
  if (!insideWindow(at, timeZone, window.start, window.end)) return null;
  const local = localMoment(at, timeZone);
  const minute = minutesOf(local.time);
  const wraps = minutesOf(window.start) > minutesOf(window.end);
  const date = wraps && minute >= minutesOf(window.start) ? addDays(local.date, 1) : local.date;
  const end = zonedInstant(date, window.end, timeZone);
  // A daylight-saving jump can make the wall-clock end land before `at`; never go back.
  return end.getTime() > at.getTime() ? end : new Date(at.getTime() + MINUTE_MS);
}

/** When the customer's quiet hours that contain `at` end; null when `at` is not quiet. */
export function quietHoursEnd(
  at: Date,
  timeZone: string,
  quiet: AppSettings["hours.quiet_hours"],
): Date | null {
  return windowEnd(at, timeZone, quiet);
}

export type HoursValues = Pick<
  AppSettings,
  "hours.weekly" | "hours.holidays" | "hours.us_federal_holidays"
>;

/** The next moment the business is open at or after `at`, or null within two weeks. */
export function nextOpening(values: HoursValues, timeZone: string, at: Date): Date | null {
  const state = businessHoursState(values, timeZone, at);
  if (state.open) return at;
  if (state.nextOpen === null) return null;
  const opens = zonedInstant(state.nextOpen.date, state.nextOpen.time, timeZone);
  return opens.getTime() > at.getTime() ? opens : new Date(at.getTime() + MINUTE_MS);
}

/**
 * The first moment at or after `from` when an unprompted message (a nudge, a check-in) may
 * be sent: outside the customer's quiet hours and, when `businessHoursOnly`, while the
 * business is open. Null when no such moment comes within about two weeks (a business with
 * no hours at all).
 */
export function nextAllowedMoment(input: {
  readonly from: Date;
  readonly values: HoursValues & Pick<AppSettings, "hours.quiet_hours">;
  readonly customerTimeZone: string;
  readonly businessTimeZone: string;
  readonly businessHoursOnly: boolean;
}): Date | null {
  let at = input.from;
  for (let step = 0; step < 32; step += 1) {
    const quietEnd = quietHoursEnd(at, input.customerTimeZone, input.values["hours.quiet_hours"]);
    if (quietEnd !== null) {
      at = quietEnd;
      continue;
    }
    if (input.businessHoursOnly) {
      const opens = nextOpening(input.values, input.businessTimeZone, at);
      if (opens === null) return null;
      if (opens.getTime() !== at.getTime()) {
        at = opens;
        continue;
      }
    }
    return at;
  }
  return null;
}

/**
 * Whether follow-ups wait for business hours: when the setting says so, and when the
 * after-hours mode keeps the bot from writing while the office is closed (staying silent,
 * or sending only the after-hours message), so a nudge never contradicts it.
 */
export function followUpsNeedBusinessHours(
  values: Pick<AppSettings, "follow_up.send_window" | "hours.after_hours_mode">,
): boolean {
  if (values["follow_up.send_window"] === "business_hours") return true;
  const mode = values["hours.after_hours_mode"];
  return mode === "silent" || mode === "auto_reply";
}

/** Parses an ISO 8601 duration of days, hours and minutes ("P1D", "PT2H", "P1DT30M"). */
export function parseIsoDuration(value: string): number | null {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    value.trim(),
  );
  if (match === null || value.trim().toUpperCase() === "P" || /T$/i.test(value.trim())) {
    return null;
  }
  const [, weeks, days, hours, minutes, seconds] = match;
  const ms =
    Number(weeks ?? 0) * 7 * 86_400_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * MINUTE_MS +
    Number(seconds ?? 0) * 1000;
  return ms > 0 ? ms : null;
}
