import { describe, expect, it } from "vitest";

import { sameHoursOn, settingsWith } from "@repo/settings";

import {
  businessHoursState,
  clockTime,
  describeNextOpen,
  describeWeeklyHours,
  hoursOn,
  localMoment,
  usFederalHolidays,
  zonedInstant,
} from "./hours";

const defaults = settingsWith({}).values;
const DENVER = "America/Denver";

describe("local time", () => {
  it("shows an instant on the wall clock of a time zone, across daylight saving", () => {
    expect(localMoment(new Date("2026-11-10T17:00:00Z"), DENVER)).toEqual({
      date: "2026-11-10",
      time: "10:00",
      weekday: "tuesday",
    });
    // In July, Denver is six hours behind UTC, not seven.
    expect(localMoment(new Date("2026-07-01T05:30:00Z"), DENVER)).toEqual({
      date: "2026-06-30",
      time: "23:30",
      weekday: "tuesday",
    });
  });

  it("finds the instant of a wall-clock time and back", () => {
    for (const [date, time] of [
      ["2026-11-10", "08:00"],
      ["2026-07-04", "17:30"],
      ["2026-03-08", "09:00"],
    ] as const) {
      const instant = zonedInstant(date, time, DENVER);
      expect(localMoment(instant, DENVER)).toMatchObject({ date, time });
    }
    expect(zonedInstant("2026-11-10", "08:00", DENVER).toISOString()).toBe(
      "2026-11-10T15:00:00.000Z",
    );
  });
});

describe("usFederalHolidays", () => {
  it("knows the holidays of 2026 by the day they are observed", () => {
    const holidays = usFederalHolidays(2026);
    expect(Object.fromEntries(holidays)).toEqual({
      "2026-01-01": "New Year's Day",
      "2026-01-19": "Martin Luther King Jr. Day",
      "2026-02-16": "Washington's Birthday",
      "2026-05-25": "Memorial Day",
      "2026-06-19": "Juneteenth",
      // July 4, 2026 is a Saturday: observed on Friday.
      "2026-07-03": "Independence Day",
      "2026-09-07": "Labor Day",
      "2026-10-12": "Columbus Day",
      "2026-11-11": "Veterans Day",
      "2026-11-26": "Thanksgiving Day",
      "2026-12-25": "Christmas Day",
    });
    // January 1, 2028 is a Saturday: observed on the last day of 2027.
    expect(usFederalHolidays(2027).get("2027-12-31")).toBe("New Year's Day");
  });
});

describe("businessHoursState", () => {
  it("is open during the weekly hours and says when it closes", () => {
    const state = businessHoursState(defaults, DENVER, new Date("2026-11-10T17:00:00Z"));
    expect(state).toMatchObject({
      open: true,
      closesAt: "17:00",
      nextOpen: null,
      closedSince: null,
    });
  });

  it("is closed in the evening, and knows since when and until when", () => {
    // Tuesday 20:30 in Denver.
    const state = businessHoursState(defaults, DENVER, new Date("2026-11-11T03:30:00Z"));
    expect(state.open).toBe(false);
    // Wednesday, November 11, 2026 is Veterans Day: the next opening is Thursday.
    expect(state.nextOpen).toEqual({
      date: "2026-11-12",
      time: "08:00",
      weekday: "thursday",
      daysAhead: 2,
    });
    expect(state.closedSince?.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(describeNextOpen(state.nextOpen!)).toBe("on Thursday at 8:00 AM");
  });

  it("is closed on a federal holiday unless the business works through them", () => {
    const veteransDay = new Date("2026-11-11T17:00:00Z");
    expect(businessHoursState(defaults, DENVER, veteransDay)).toMatchObject({
      open: false,
      holiday: "Veterans Day",
    });
    const working = settingsWith({ "hours.us_federal_holidays": false }).values;
    expect(businessHoursState(working, DENVER, veteransDay).open).toBe(true);
  });

  it("uses the special hours of a listed day, which win over the weekly hours and the holidays", () => {
    const values = settingsWith({
      "hours.holidays": [
        {
          date: "2026-11-11",
          name: "Veterans Day, short day",
          hours: [{ open: "09:00", close: "12:00" }],
        },
        { date: "2026-11-13", name: "Team outing", hours: [] },
      ],
    }).values;
    expect(hoursOn(values, "2026-11-11")).toEqual({
      intervals: [{ open: "09:00", close: "12:00" }],
      holiday: "Veterans Day, short day",
    });
    // 11:00 on the short day: open until noon.
    expect(businessHoursState(values, DENVER, new Date("2026-11-11T18:00:00Z"))).toMatchObject({
      open: true,
      closesAt: "12:00",
    });
    // Thursday evening: Friday is the outing, so the next opening is Monday.
    const state = businessHoursState(values, DENVER, new Date("2026-11-13T02:00:00Z"));
    expect(state.nextOpen).toMatchObject({ date: "2026-11-16", weekday: "monday" });
  });

  it("opens later today when the customer writes before opening time", () => {
    const state = businessHoursState(defaults, DENVER, new Date("2026-11-10T13:30:00Z"));
    expect(state.open).toBe(false);
    expect(state.nextOpen).toMatchObject({ date: "2026-11-10", time: "08:00", daysAhead: 0 });
    // Closed since Monday 17:00.
    expect(state.closedSince?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });

  it("handles a lunch break and a business that never opens", () => {
    const split = settingsWith({
      "hours.weekly": {
        ...sameHoursOn([], "08:00", "17:00"),
        tuesday: [
          { open: "08:00", close: "12:00" },
          { open: "13:00", close: "17:00" },
        ],
      },
    }).values;
    // 12:30 on Tuesday: between the two intervals.
    const lunch = businessHoursState(split, DENVER, new Date("2026-11-10T19:30:00Z"));
    expect(lunch).toMatchObject({ open: false, nextOpen: { time: "13:00", daysAhead: 0 } });
    expect(lunch.closedSince?.toISOString()).toBe("2026-11-10T19:00:00.000Z");

    const never = settingsWith({ "hours.weekly": sameHoursOn([], "08:00", "17:00") }).values;
    expect(businessHoursState(never, DENVER, new Date("2026-11-10T19:30:00Z"))).toMatchObject({
      open: false,
      nextOpen: null,
      closedSince: null,
    });
  });
});

describe("wording", () => {
  it("writes times and weekly hours the way a customer reads them", () => {
    expect(clockTime("08:00")).toBe("8:00 AM");
    expect(clockTime("12:30")).toBe("12:30 PM");
    expect(clockTime("00:15")).toBe("12:15 AM");
    expect(describeWeeklyHours(defaults["hours.weekly"])).toBe(
      "Monday to Friday 8:00 AM to 5:00 PM; Saturday to Sunday closed",
    );
  });
});
