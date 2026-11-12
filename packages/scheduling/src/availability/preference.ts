import { type Weekday, WEEKDAYS } from "@repo/settings";

import { addDays, weekdayOf } from "../time";

/**
 * The customer's stated preference ("weekday mornings", "Tuesday after 3", "next week",
 * "November 18"), read by a few plain rules into a filter on candidate slots. Anything the
 * rules do not recognise is simply not a filter: the customer still gets real times, and the
 * result says when none matched what they asked for.
 */

export interface SlotMoment {
  /** Local date in the business's time zone. */
  readonly date: string;
  readonly weekday: Weekday;
  /** Minutes after local midnight. */
  readonly minutes: number;
}

export interface Preference {
  /** True when at least one rule recognised something in the words. */
  readonly understood: boolean;
  matches(slot: SlotMoment): boolean;
}

const DAY_WORDS: readonly (readonly [RegExp, Weekday])[] = [
  [/\bmon(day)?s?\b/, "monday"],
  [/\btue(s|sday)?s?\b/, "tuesday"],
  [/\bwed(nesday)?s?\b/, "wednesday"],
  [/\bthu(r|rs|rsday)?s?\b/, "thursday"],
  [/\bfri(day)?s?\b/, "friday"],
  [/\bsat(urday)?s?\b/, "saturday"],
  [/\bsun(day)?s?\b/, "sunday"],
];

const MONTHS: readonly (readonly [RegExp, number])[] = [
  [/\bjan(uary)?\b/, 1],
  [/\bfeb(ruary)?\b/, 2],
  [/\bmar(ch)?\b/, 3],
  [/\bapr(il)?\b/, 4],
  [/\bmay\b/, 5],
  [/\bjune?\b/, 6],
  [/\bjuly?\b/, 7],
  [/\baug(ust)?\b/, 8],
  [/\bsep(t|tember)?\b/, 9],
  [/\boct(ober)?\b/, 10],
  [/\bnov(ember)?\b/, 11],
  [/\bdec(ember)?\b/, 12],
];

const WORKDAYS: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

/** "3", "3pm", "3:30 pm", "15:00" as minutes after midnight; a bare small hour is afternoon. */
function clockMinutes(
  hour: string,
  minute: string | undefined,
  meridiem: string | undefined,
): number | null {
  let h = Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  if (!Number.isInteger(h) || h > 23 || m > 59) return null;
  if (meridiem !== undefined) {
    if (h < 1 || h > 12) return null;
    if (meridiem.startsWith("p") && h !== 12) h += 12;
    if (meridiem.startsWith("a") && h === 12) h = 0;
  } else if (h >= 1 && h <= 6) {
    // "after 3" in a conversation about appointments means the afternoon.
    h += 12;
  }
  return h * 60 + m;
}

function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 16), index);
  return /\b(not|except|no|but)\s+(on\s+)?$/.test(before);
}

export function parsePreference(raw: string | null, today: string): Preference {
  if (raw === null || raw.trim().length === 0) return { understood: false, matches: () => true };
  const text = raw.toLowerCase();
  const tests: ((slot: SlotMoment) => boolean)[] = [];
  let understood = false;

  if (/\b(asap|as soon as|soonest|earliest|first available|any ?time|whenever)\b/.test(text)) {
    understood = true;
  }

  // Days of the week.
  const wanted = new Set<Weekday>();
  const unwanted = new Set<Weekday>();
  for (const [pattern, day] of DAY_WORDS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    (negated(text, match.index) ? unwanted : wanted).add(day);
  }
  if (/\bweekdays?\b|\bduring the week\b|\bwork ?days?\b/.test(text)) {
    for (const day of WORKDAYS) wanted.add(day);
  }
  if (/\bweekends?\b/.test(text)) {
    const match = /\bweekends?\b/.exec(text)!;
    for (const day of ["saturday", "sunday"] as const) {
      (negated(text, match.index) ? unwanted : wanted).add(day);
    }
  }
  if (wanted.size > 0 || unwanted.size > 0) {
    understood = true;
    tests.push(
      (slot) => (wanted.size === 0 || wanted.has(slot.weekday)) && !unwanted.has(slot.weekday),
    );
  }

  // Parts of the day.
  const parts: [number, number][] = [];
  if (/\bmornings?\b/.test(text)) parts.push([0, 12 * 60]);
  if (/\b(mid ?day|noon|lunch(time)?)\b/.test(text)) parts.push([11 * 60, 13 * 60 + 30]);
  if (/\bafternoons?\b/.test(text)) parts.push([12 * 60, 17 * 60]);
  if (/\bevenings?\b|\bafter work\b|\btonight\b/.test(text)) parts.push([16 * 60 + 30, 24 * 60]);
  if (parts.length > 0) {
    understood = true;
    tests.push((slot) => parts.some(([from, to]) => slot.minutes >= from && slot.minutes < to));
  }

  // "after 3", "before 10:30 am", "from 2 pm".
  const after =
    /\b(after|from|later than|past)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(text);
  if (after !== null) {
    const minutes = clockMinutes(after[2]!, after[3], after[4]?.replaceAll(".", ""));
    if (minutes !== null) {
      understood = true;
      tests.push((slot) => slot.minutes >= minutes);
    }
  }
  const before =
    /\b(before|by|until|no later than)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(text);
  if (before !== null) {
    const minutes = clockMinutes(before[2]!, before[3], before[4]?.replaceAll(".", ""));
    if (minutes !== null) {
      understood = true;
      tests.push((slot) => slot.minutes < minutes);
    }
  }

  // Dates: today, tomorrow, this week, next week, "November 18", "11/18".
  const dates = new Set<string>();
  let range: [string, string] | null = null;
  if (/\btoday\b/.test(text)) dates.add(today);
  if (/\btomorrow\b/.test(text)) dates.add(addDays(today, 1));
  const offset = WEEKDAYS.indexOf(weekdayOf(today));
  if (/\bnext week\b/.test(text)) {
    const monday = addDays(today, 7 - offset);
    range = [monday, addDays(monday, 6)];
  } else if (/\bthis week\b/.test(text)) {
    range = [today, addDays(today, 6 - offset)];
  }
  const year = Number(today.slice(0, 4));
  const resolve = (month: number, day: number): string | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (Number.isNaN(Date.parse(`${candidate}T12:00:00Z`))) return null;
    if (candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return candidate;
  };
  for (const [pattern, month] of MONTHS) {
    const match = new RegExp(`${pattern.source}\\.?\\s+(\\d{1,2})(st|nd|rd|th)?\\b`).exec(text);
    if (match !== null) {
      const date = resolve(month, Number(match[match.length - 2]));
      if (date !== null) dates.add(date);
    }
  }
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    const date = resolve(Number(match[1]), Number(match[2]));
    if (date !== null) dates.add(date);
  }
  if (dates.size > 0 || range !== null) {
    understood = true;
    tests.push(
      (slot) =>
        dates.has(slot.date) || (range !== null && slot.date >= range[0] && slot.date <= range[1]),
    );
  }

  return { understood, matches: (slot) => tests.every((test) => test(slot)) };
}
