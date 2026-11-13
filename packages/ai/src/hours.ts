import { type AppSettings, type TimeInterval, type Weekday, WEEKDAYS } from "@repo/settings";

/**
 * Business hours as the engine needs them: is the office open at a given instant, when does
 * it close, when does it open next, and since when has it been closed. Everything is worked
 * out in the business's time zone from the `hours.*` settings; the clock is an argument.
 */

export interface LocalMoment {
  /** "YYYY-MM-DD" in the business's time zone. */
  readonly date: string;
  /** "HH:MM", 24-hour. */
  readonly time: string;
  readonly weekday: Weekday;
}

export interface HoursState {
  readonly now: LocalMoment;
  readonly open: boolean;
  /** Today's closing time of the interval that is open now. */
  readonly closesAt: string | null;
  /** The next moment the office opens; null when it is open, or never opens in two weeks. */
  readonly nextOpen: (LocalMoment & { readonly daysAhead: number }) | null;
  /** The instant the office last closed; null when it is open or has no hours at all. */
  readonly closedSince: Date | null;
  /** Why today is closed or has special hours, when a holiday is the reason. */
  readonly holiday: string | null;
}

const LOOKAHEAD_DAYS = 14;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall-clock date, time and weekday of an instant in a time zone. */
export function localMoment(instant: Date, timeZone: string): LocalMoment {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  const weekday = (parts["weekday"] ?? "").toLowerCase() as Weekday;
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    time: `${parts["hour"]}:${parts["minute"]}`,
    weekday: WEEKDAYS.includes(weekday) ? weekday : "monday",
  };
}

/** The instant at which a time zone's wall clock shows the given date and time. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const wanted = Date.parse(`${date}T${time}:00Z`);
  let guess = wanted;
  // The zone's offset at the guess moves the guess; twice settles daylight-saving edges.
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localMoment(new Date(guess), timeZone);
    const shown = Date.parse(`${local.date}T${local.time}:00Z`);
    guess += wanted - shown;
  }
  return new Date(guess);
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function weekdayOf(date: string): Weekday {
  // getUTCDay: 0 is Sunday; WEEKDAYS starts on Monday.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return WEEKDAYS[(day + 6) % 7] ?? "monday";
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset)).toISOString().slice(0, 10);
}

/** A fixed-date holiday is observed on Friday when it falls on Saturday, Monday for Sunday. */
function observed(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 6) return addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  return date;
}

/** The US federal holidays of a year, by the date they are observed, with their names. */
export function usFederalHolidays(year: number): ReadonlyMap<string, string> {
  const fixed = (month: number, day: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const holidays = new Map<string, string>();
  const add = (date: string, name: string) => {
    holidays.set(date, name);
  };
  add(observed(fixed(1, 1)), "New Year's Day");
  add(nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day");
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  add(lastWeekday(year, 5, 1), "Memorial Day");
  add(observed(fixed(6, 19)), "Juneteenth");
  add(observed(fixed(7, 4)), "Independence Day");
  add(nthWeekday(year, 9, 1, 1), "Labor Day");
  add(nthWeekday(year, 10, 1, 2), "Columbus Day");
  add(observed(fixed(11, 11)), "Veterans Day");
  add(nthWeekday(year, 11, 4, 4), "Thanksgiving Day");
  add(observed(fixed(12, 25)), "Christmas Day");
  // New Year's Day of the next year can be observed on December 31 of this one.
  const nextNewYear = observed(`${year + 1}-01-01`);
  if (nextNewYear.startsWith(String(year))) add(nextNewYear, "New Year's Day");
  return holidays;
}

type HoursValues = Pick<
  AppSettings,
  "hours.weekly" | "hours.holidays" | "hours.us_federal_holidays"
>;

/** The open intervals of one calendar day, sorted, and the holiday behind them if any. */
export function hoursOn(
  values: HoursValues,
  date: string,
): { readonly intervals: readonly TimeInterval[]; readonly holiday: string | null } {
  const special = values["hours.holidays"].find((day) => day.date === date);
  const sorted = (intervals: readonly TimeInterval[]) =>
    [...intervals].sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0));
  if (special !== undefined) {
    return {
      intervals: sorted(special.hours),
      holiday: special.name.length > 0 ? special.name : "a special day",
    };
  }
  if (values["hours.us_federal_holidays"]) {
    const name = usFederalHolidays(Number(date.slice(0, 4))).get(date);
    if (name !== undefined) return { intervals: [], holiday: name };
  }
  return { intervals: sorted(values["hours.weekly"][weekdayOf(date)] ?? []), holiday: null };
}

/** Open or closed at `now`, and the opening and closing times around it. */
export function businessHoursState(values: HoursValues, timeZone: string, now: Date): HoursState {
  const moment = localMoment(now, timeZone);
  const today = hoursOn(values, moment.date);
  const current = today.intervals.find(
    (interval) => interval.open <= moment.time && moment.time < interval.close,
  );
  if (current !== undefined) {
    return {
      now: moment,
      open: true,
      closesAt: current.close,
      nextOpen: null,
      closedSince: null,
      holiday: today.holiday,
    };
  }

  let nextOpen: HoursState["nextOpen"] = null;
  const laterToday = today.intervals.find((interval) => interval.open > moment.time);
  if (laterToday !== undefined) {
    nextOpen = { date: moment.date, time: laterToday.open, weekday: moment.weekday, daysAhead: 0 };
  } else {
    for (let days = 1; days <= LOOKAHEAD_DAYS && nextOpen === null; days += 1) {
      const date = addDays(moment.date, days);
      const first = hoursOn(values, date).intervals[0];
      if (first !== undefined) {
        nextOpen = { date, time: first.open, weekday: weekdayOf(date), daysAhead: days };
      }
    }
  }

  let closedSince: Date | null = null;
  const earlierToday = today.intervals.filter((interval) => interval.close <= moment.time).at(-1);
  if (earlierToday !== undefined) {
    closedSince = zonedInstant(moment.date, earlierToday.close, timeZone);
  } else {
    for (let days = 1; days <= LOOKAHEAD_DAYS && closedSince === null; days += 1) {
      const date = addDays(moment.date, -days);
      const last = hoursOn(values, date).intervals.at(-1);
      if (last !== undefined) closedSince = zonedInstant(date, last.close, timeZone);
    }
  }

  return {
    now: moment,
    open: false,
    closesAt: null,
    nextOpen,
    closedSince,
    holiday: today.holiday,
  };
}

const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const MONTH_NAMES = [
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

export function weekdayName(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday];
}

/** "17:00" as "5:00 PM", the way a US customer reads a time. */
export function clockTime(time: string): string {
  const hour = Number(time.slice(0, 2));
  const minute = time.slice(3, 5);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minute} ${suffix}`;
}

/** "2026-11-11" as "November 11, 2026". */
export function longDate(date: string): string {
  const month = MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? "";
  return `${month} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}

/** "Monday to Friday 8:00 AM to 5:00 PM; Saturday closed; ...", for the business block. */
export function describeWeeklyHours(weekly: AppSettings["hours.weekly"]): string {
  const describe = (intervals: readonly TimeInterval[]) =>
    intervals.length === 0
      ? "closed"
      : intervals
          .map((interval) => `${clockTime(interval.open)} to ${clockTime(interval.close)}`)
          .join(" and ");
  const groups: { first: Weekday; last: Weekday; hours: string }[] = [];
  for (const weekday of WEEKDAYS) {
    const hours = describe(weekly[weekday] ?? []);
    const previous = groups.at(-1);
    if (previous?.hours === hours) previous.last = weekday;
    else groups.push({ first: weekday, last: weekday, hours });
  }
  return groups
    .map((group) =>
      group.first === group.last
        ? `${weekdayName(group.first)} ${group.hours}`
        : `${weekdayName(group.first)} to ${weekdayName(group.last)} ${group.hours}`,
    )
    .join("; ");
}

/** "tomorrow (Wednesday) at 8:00 AM", relative to today. */
export function describeNextOpen(next: NonNullable<HoursState["nextOpen"]>): string {
  const at = `at ${clockTime(next.time)}`;
  if (next.daysAhead === 0) return `today ${at}`;
  if (next.daysAhead === 1) return `tomorrow (${weekdayName(next.weekday)}) ${at}`;
  if (next.daysAhead < 7) return `on ${weekdayName(next.weekday)} ${at}`;
  return `on ${weekdayName(next.weekday)}, ${longDate(next.date)}, ${at}`;
}
