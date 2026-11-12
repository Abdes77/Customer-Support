import { describe, expect, it } from "vitest";

import { type AppSettings, settingsWith } from "@repo/settings";

import { meetingLabel } from "../time";
import { busyIntervals, type CalendarEvent, type Interval } from "./busy";
import { parsePreference } from "./preference";
import { slotRules, zipCodeOf } from "./rules";
import { findSlot, freeSlots, parseSlotId, pickOffers, type Slot, slotIdOf } from "./slots";

const CHICAGO = "America/Chicago";
const NEW_YORK = "America/New_York";

function values(overrides: Partial<AppSettings> = {}): AppSettings {
  return settingsWith(overrides).values;
}

function slots(
  options: {
    readonly overrides?: Partial<AppSettings>;
    readonly now?: string;
    readonly timeZone?: string;
    readonly events?: readonly CalendarEvent[];
    readonly bookings?: readonly Interval[];
    readonly perDay?: ReadonlyMap<string, number>;
    readonly zip?: string | null;
  } = {},
): Slot[] {
  const v = values(options.overrides);
  const timeZone = options.timeZone ?? CHICAGO;
  return freeSlots({
    rules: slotRules(v, { zip: options.zip ?? null }),
    timeZone,
    // Tuesday, November 10, 2026, 10:00 AM in Chicago.
    now: new Date(options.now ?? "2026-11-10T16:00:00.000Z"),
    busy: [...busyIntervals(options.events ?? [], v, timeZone), ...(options.bookings ?? [])],
    bookingsPerDay: options.perDay ?? new Map(),
  });
}

const local = (slot: Slot | undefined) =>
  slot === undefined ? null : `${slot.date} ${slot.minutes / 60}`;

describe("free slots from the settings", () => {
  it("starts after the minimum lead time, skips the federal holiday, and keeps to business hours", () => {
    const found = slots();
    // Wednesday, November 11 is Veterans Day: closed. The next day opens at 8:00.
    expect(found[0]).toMatchObject({ id: "2026-11-12T14:00Z", date: "2026-11-12", minutes: 480 });
    expect(found.every((slot) => slot.date !== "2026-11-11")).toBe(true);
    // A 60-minute meeting on the 30-minute grid: the last start is 16:00 (ends at 17:00).
    const thursday = found.filter((slot) => slot.date === "2026-11-12");
    expect(thursday.map((slot) => slot.minutes / 60)).toEqual([
      8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16,
    ]);
    // Weekends are closed; nothing after 14 days.
    expect(found.some((slot) => slot.weekday === "saturday" || slot.weekday === "sunday")).toBe(
      false,
    );
    expect(found.at(-1)?.date).toBe("2026-11-24");
  });

  it("respects the minimum lead time in hours", () => {
    const found = slots({ overrides: { "scheduling.min_lead_time_hours": 2 } });
    expect(found[0]?.id).toBe("2026-11-10T18:00Z"); // noon, two hours from 10:00
  });

  it("keeps the meeting clear of busy events with its buffers", () => {
    const found = slots({
      events: [
        {
          allDay: false,
          start: "2026-11-12T14:00:00Z",
          end: "2026-11-12T16:00:00Z",
          status: "busy",
        },
        {
          allDay: false,
          start: "2026-11-12T17:00:00Z",
          end: "2026-11-12T18:00:00Z",
          status: "busy",
        },
      ],
    });
    const thursday = found.filter((slot) => slot.date === "2026-11-12").map((s) => s.minutes / 60);
    // 8:00 to 10:00 busy; a meeting at 10:00 would end at 11:00 and its 30 minutes after it
    // would touch the 11:00 event, so the first start is 12:00 (the event ends at noon).
    expect(thursday.slice(0, 3)).toEqual([12, 12.5, 13]);
    expect(thursday).not.toContain(10);
    expect(thursday).not.toContain(9.5);
  });

  it("counts a buffer before the meeting against the event before it", () => {
    const found = slots({
      overrides: { "scheduling.buffer_before_minutes": 30, "scheduling.buffer_after_minutes": 0 },
      events: [
        {
          allDay: false,
          start: "2026-11-12T14:00:00Z",
          end: "2026-11-12T16:00:00Z",
          status: "busy",
        },
      ],
    });
    expect(local(found[0])).toBe("2026-11-12 10.5");
  });

  it("treats tentative events per the setting and ignores free ones", () => {
    const events: CalendarEvent[] = [
      {
        allDay: false,
        start: "2026-11-12T14:00:00Z",
        end: "2026-11-12T23:00:00Z",
        status: "tentative",
      },
      { allDay: false, start: "2026-11-13T14:00:00Z", end: "2026-11-13T23:00:00Z", status: "free" },
    ];
    expect(local(slots({ events })[0])).toBe("2026-11-13 8");
    expect(local(slots({ events, overrides: { "scheduling.tentative_events": "free" } })[0])).toBe(
      "2026-11-12 8",
    );
  });

  it("blocks whole days for all-day events as marked, always, or never", () => {
    const busyDay: CalendarEvent = {
      allDay: true,
      startDate: "2026-11-12",
      endDate: "2026-11-14",
      status: "busy",
    };
    const freeDay: CalendarEvent = { ...busyDay, status: "free" };
    expect(local(slots({ events: [busyDay] })[0])).toBe("2026-11-16 8");
    expect(local(slots({ events: [freeDay] })[0])).toBe("2026-11-12 8");
    expect(
      local(
        slots({ events: [freeDay], overrides: { "scheduling.all_day_events": "always_busy" } })[0],
      ),
    ).toBe("2026-11-16 8");
    expect(
      local(slots({ events: [busyDay], overrides: { "scheduling.all_day_events": "ignore" } })[0]),
    ).toBe("2026-11-12 8");
  });

  it("counts the business's own bookings as busy and stops at the meetings per day", () => {
    // A booking from 8:00 to 9:00 with its 30 minutes after it (the service adds its buffers).
    const booked: Interval = {
      start: Date.parse("2026-11-12T14:00:00Z"),
      end: Date.parse("2026-11-12T15:30:00Z"),
    };
    expect(local(slots({ bookings: [booked] })[0])).toBe("2026-11-12 9.5");
    const full = slots({
      overrides: { "scheduling.max_meetings_per_day": 1 },
      perDay: new Map([["2026-11-12", 1]]),
    });
    expect(local(full[0])).toBe("2026-11-13 8");
  });

  it("uses custom meeting hours, own holidays and special hours", () => {
    const custom = {
      "scheduling.hours_source": "custom",
      "hours.holidays": [
        { date: "2026-11-13", name: "Team day", hours: [] },
        { date: "2026-11-16", name: "Half day", hours: [{ open: "08:00", close: "12:00" }] },
      ],
    } as const satisfies Partial<AppSettings>;
    const found = slots({ overrides: custom });
    expect(local(found[0])).toBe("2026-11-12 9"); // custom hours are 9:00 to 16:00
    expect(found.some((slot) => slot.date === "2026-11-13")).toBe(false);
    const monday = found.filter((slot) => slot.date === "2026-11-16").map((s) => s.minutes / 60);
    expect(monday).toEqual([9, 9.5, 10, 10.5, 11]);
    // Without "no meetings on closed days" holidays do not matter.
    const ignoring = slots({ overrides: { ...custom, "scheduling.skip_holidays": false } });
    expect(ignoring.some((slot) => slot.date === "2026-11-13")).toBe(true);
    expect(slots({ overrides: { "scheduling.skip_holidays": false } })[0]?.date).toBe("2026-11-11");
  });

  it("applies a travel rule's days and extra time to customers in its ZIP codes", () => {
    const overrides = {
      "scheduling.travel_rules": [
        { name: "Hill Country", zip_codes: ["78620"], days: ["friday"], extra_travel_minutes: 60 },
      ],
    } as const satisfies Partial<AppSettings>;
    const outside = slots({ overrides, zip: "78704" });
    expect(local(outside[0])).toBe("2026-11-12 8");
    const inside = slots({
      overrides,
      zip: zipCodeOf("1200 Ranch Rd, Dripping Springs, TX 78620"),
      events: [
        {
          allDay: false,
          start: "2026-11-13T16:00:00Z",
          end: "2026-11-13T17:00:00Z",
          status: "busy",
        },
      ],
    });
    expect(inside.every((slot) => slot.weekday === "friday")).toBe(true);
    // Busy 10:00 to 11:00; with an hour of travel on each side (plus the 30 minutes after),
    // the morning has 8:00 only if it ends by 9:00; it does not (9:00 + 90 min > 10:00).
    const friday = inside.filter((slot) => slot.date === "2026-11-13").map((s) => s.minutes / 60);
    expect(friday[0]).toBe(12);
  });

  it("holds the arrival window plus the meeting, and labels the window", () => {
    const found = slots({ overrides: { "scheduling.arrival_window_minutes": 120 } });
    const thursday = found.filter((slot) => slot.date === "2026-11-12");
    expect(thursday.at(-1)?.minutes).toBe(14 * 60); // 14:00 + 2 h window + 1 h meeting = 17:00
    const first = thursday[0]!;
    expect(Date.parse(first.end) - Date.parse(first.start)).toBe(3 * 3_600_000);
    expect(
      meetingLabel({
        start: new Date(first.start),
        arrivalWindowMinutes: 120,
        timeZone: CHICAGO,
        businessTimeZone: CHICAGO,
      }),
    ).toBe("Thursday, November 12, between 8:00 AM and 10:00 AM");
  });
});

describe("daylight saving time", () => {
  it("keeps 9:00 AM local across the November change", () => {
    const found = slots({
      timeZone: NEW_YORK,
      now: "2026-10-28T12:00:00.000Z", // Wednesday, Oct 28, 8:00 EDT
      overrides: {
        "hours.weekly": {
          ...values()["hours.weekly"],
          monday: [{ open: "09:00", close: "10:00" }],
        },
      },
    });
    const friday = found.find((slot) => slot.date === "2026-10-30");
    const monday = found.find((slot) => slot.date === "2026-11-02");
    expect(friday?.id).toBe("2026-10-30T12:00Z"); // 8:00 EDT = UTC-4
    expect(monday?.id).toBe("2026-11-02T14:00Z"); // 9:00 EST = UTC-5
  });

  it("skips wall-clock times that do not exist when clocks spring forward", () => {
    const found = slots({
      timeZone: NEW_YORK,
      now: "2026-03-05T15:00:00.000Z",
      overrides: {
        "scheduling.hours_source": "custom",
        "scheduling.slot_minutes": 30,
        "scheduling.buffer_after_minutes": 0,
        "scheduling.custom_hours": {
          ...values()["scheduling.custom_hours"],
          sunday: [{ open: "01:00", close: "04:00" }],
        },
      },
    });
    const sunday = found
      .filter((slot) => slot.date === "2026-03-08")
      .map((slot) => slot.minutes / 60);
    expect(sunday).toEqual([1, 1.5, 3, 3.5]);
    expect(found.find((slot) => slot.date === "2026-03-08" && slot.minutes === 180)?.id).toBe(
      "2026-03-08T07:00Z",
    );
  });
});

describe("offers", () => {
  const all = slots();

  it("spreads the offers over different days, earliest first", () => {
    const { offers } = pickOffers(all, {
      count: 3,
      spread: true,
      preference: parsePreference(null, "2026-11-10"),
    });
    expect(offers.map(local)).toEqual(["2026-11-12 8", "2026-11-13 8", "2026-11-16 8"]);
    const packed = pickOffers(all, {
      count: 3,
      spread: false,
      preference: parsePreference(null, "2026-11-10"),
    });
    expect(packed.offers.map(local)).toEqual(["2026-11-12 8", "2026-11-12 8.5", "2026-11-12 9"]);
  });

  it("follows the customer's preference in words", () => {
    const today = "2026-11-10";
    const pick = (words: string) =>
      pickOffers(all, { count: 2, spread: true, preference: parsePreference(words, today) });
    expect(pick("Tuesday afternoon please").offers.map(local)).toEqual([
      "2026-11-17 12",
      "2026-11-24 12",
    ]);
    expect(pick("after 3").offers.map(local)).toEqual(["2026-11-12 15", "2026-11-13 15"]);
    expect(pick("before 9:30 am").offers.map(local)).toEqual(["2026-11-12 8", "2026-11-13 8"]);
    expect(pick("next week, not Monday").offers.map(local)).toEqual([
      "2026-11-17 8",
      "2026-11-18 8",
    ]);
    expect(pick("Nov 19 in the morning").offers.map(local)).toEqual([
      "2026-11-19 8",
      "2026-11-19 8.5",
    ]);
    expect(pick("11/20").offers[0]?.date).toBe("2026-11-20");
  });

  it("says when nothing matched the preference and offers the nearest times instead", () => {
    const result = pickOffers(all, {
      count: 2,
      spread: true,
      preference: parsePreference("Saturday", "2026-11-10"),
    });
    expect(result.matchedPreference).toBe(false);
    expect(result.offers).toHaveLength(2);
    expect(
      pickOffers(all, {
        count: 2,
        spread: true,
        preference: parsePreference("whenever", "2026-11-10"),
      }).matchedPreference,
    ).toBe(true);
  });
});

describe("slot ids", () => {
  it("round-trips and finds the same slot again at booking time", () => {
    const start = new Date("2026-11-12T14:00:00.000Z");
    expect(slotIdOf(start)).toBe("2026-11-12T14:00Z");
    expect(parseSlotId("2026-11-12T14:00Z")?.toISOString()).toBe(start.toISOString());
    expect(parseSlotId("slot_2026-11-12T14:00Z")?.toISOString()).toBe(start.toISOString());
    expect(parseSlotId("tomorrow at 9")).toBeNull();
    const v = values();
    const search = {
      rules: slotRules(v, { zip: null }),
      timeZone: CHICAGO,
      now: new Date("2026-11-10T16:00:00.000Z"),
      busy: [],
      bookingsPerDay: new Map<string, number>(),
    };
    expect(findSlot(search, start)?.id).toBe("2026-11-12T14:00Z");
    expect(findSlot(search, new Date("2026-11-12T14:10:00.000Z"))).toBeNull(); // off the grid
    expect(findSlot(search, new Date("2026-11-11T14:00:00.000Z"))).toBeNull(); // holiday
  });
});

describe("labels", () => {
  it("shows the time in the customer's zone and names it when it differs", () => {
    const start = new Date("2026-11-12T14:00:00.000Z");
    expect(
      meetingLabel({
        start,
        arrivalWindowMinutes: null,
        timeZone: CHICAGO,
        businessTimeZone: CHICAGO,
      }),
    ).toBe("Thursday, November 12 at 8:00 AM");
    expect(
      meetingLabel({
        start,
        arrivalWindowMinutes: null,
        timeZone: "America/Denver",
        businessTimeZone: CHICAGO,
      }),
    ).toBe("Thursday, November 12 at 7:00 AM MST");
  });
});
