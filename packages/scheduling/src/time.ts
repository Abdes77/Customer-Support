import { localMoment, zonedInstant } from "@repo/ai";
import { type Weekday, WEEKDAYS } from "@repo/settings";

/**
 * Calendar arithmetic on local dates ("YYYY-MM-DD") and wall-clock times ("HH:MM") in a
 * business's time zone. Instants are built from the wall clock of each day (`zonedInstant`),
 * never by adding 24 hours, so a day that changes to or from daylight saving time keeps its
 * 9:00 AM. The clock is always an argument.
 */

export { localMoment, zonedInstant };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  // getUTCDay: 0 is Sunday; WEEKDAYS starts on Monday.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return WEEKDAYS[(day + 6) % 7] ?? "monday";
}

export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function timeOf(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The instant a wall-clock time happens on a local date, or null when that time does not
 * exist there (the hour skipped when clocks spring forward).
 */
export function wallClockInstant(date: string, time: string, timeZone: string): Date | null {
  const instant = zonedInstant(date, time, timeZone);
  const shown = localMoment(instant, timeZone);
  return shown.date === date && shown.time === time ? instant : null;
}

/** Midnight at the start of a local date, as an instant (the first minute that exists). */
export function startOfLocalDay(date: string, timeZone: string): Date {
  return zonedInstant(date, "00:00", timeZone);
}

/** True when the time zone name is one this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_NAMES: Readonly<Record<Weekday, string>> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** "9:00 AM", "12:30 PM". */
export function clock(time: string): string {
  const hour = Number(time.slice(0, 2));
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${time.slice(3, 5)} ${hour >= 12 ? "PM" : "AM"}`;
}

/** "Tuesday, November 17". */
export function dayLabel(date: string): string {
  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  return `${DAY_NAMES[weekdayOf(date)]}, ${month} ${Number(date.slice(8, 10))}`;
}

/** The short name of a zone at an instant, for example "CST" or "PDT". */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(instant)
    .find((item) => item.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/**
 * A meeting time as the customer reads it: "Tuesday, November 17 at 9:00 AM", or with an
 * arrival window "Tuesday, November 17, between 9:00 AM and 11:00 AM". Shown in the
 * customer's time zone; the zone is named when it differs from the business's.
 */
export function meetingLabel(input: {
  readonly start: Date;
  readonly arrivalWindowMinutes: number | null;
  readonly timeZone: string;
  readonly businessTimeZone: string;
}): string {
  const { start, timeZone } = input;
  const local = localMoment(start, timeZone);
  const named =
    timeZone !== input.businessTimeZone &&
    zoneAbbreviation(start, timeZone) !== zoneAbbreviation(start, input.businessTimeZone);
  const suffix = named ? ` ${zoneAbbreviation(start, timeZone)}` : "";
  if (input.arrivalWindowMinutes === null) {
    return `${dayLabel(local.date)} at ${clock(local.time)}${suffix}`;
  }
  const until = localMoment(
    new Date(start.getTime() + input.arrivalWindowMinutes * MINUTE_MS),
    timeZone,
  );
  return `${dayLabel(local.date)}, between ${clock(local.time)} and ${clock(until.time)}${suffix}`;
}
