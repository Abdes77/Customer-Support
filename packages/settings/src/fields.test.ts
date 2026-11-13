import { describe, expect, it } from "vitest";

import {
  type AnyField,
  blankValue,
  describeField,
  f,
  problemsOf,
  renderTemplate,
  sameHoursOn,
  templateVariablesIn,
  walkField,
} from "./fields";

function parse(field: AnyField, value: unknown) {
  const result = field.schema.safeParse(value);
  return result.success
    ? { ok: true as const, value: result.data }
    : { ok: false as const, problems: problemsOf(result.error) };
}

function messages(field: AnyField, value: unknown): string[] {
  const result = parse(field, value);
  return result.ok ? [] : result.problems.map((problem) => problem.message);
}

describe("text", () => {
  it("trims, and enforces length and single line", () => {
    const field = f.text({ minLength: 1, maxLength: 5 });
    expect(parse(field, "  abc  ")).toEqual({ ok: true, value: "abc" });
    expect(messages(field, "   ")).toEqual(["This cannot be empty."]);
    expect(messages(field, "abcdef")[0]).toMatch(/at most 5 characters/);
    expect(messages(field, "a\nb")).toEqual(["This must be a single line."]);
    expect(parse(f.text({ multiline: true }), "a\nb").ok).toBe(true);
    expect(parse(field, 5).ok).toBe(false);
    expect(parse(field, null).ok).toBe(false);
  });

  it("refuses the NUL character, which a jsonb column cannot hold", () => {
    expect(messages(f.text(), "a\u0000b")).toEqual([
      "This text contains a character that cannot be saved.",
    ]);
    expect(messages(f.stringList({ itemLabel: "tag" }), ["ok", "\u0000"])).toHaveLength(1);
  });

  it("treats the empty string as 'not set' when the field allows it, whatever the format", () => {
    expect(parse(f.text({ format: "email" }), "")).toEqual({ ok: true, value: "" });
    expect(parse(f.text({ format: "email", minLength: 1 }), "").ok).toBe(false);
  });

  it.each([
    ["email", "Office@Example.com", "office@example.com"],
    ["phone", "(512) 555-0142", "+15125550142"],
    ["phone", "1 512 555 0142", "+15125550142"],
    ["phone", "+44 20 7946 0958", "+442079460958"],
    ["color", "#1D4ED8", "#1d4ed8"],
    ["time", "08:30", "08:30"],
    ["date", "2028-02-29", "2028-02-29"],
    ["zip", "78701", "78701"],
    ["us_state", "tx", "TX"],
    ["slug", "roof_age", "roof_age"],
    ["origin", "https://WWW.Example.com/", "https://www.example.com"],
    ["origin", "http://localhost:3000", "http://localhost:3000"],
    ["domain", "Example.COM", "example.com"],
    ["url", "https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["model_id", "claude-fable-5-2", "claude-fable-5-2"],
  ] as const)("accepts and tidies a %s: %s", (format, input, expected) => {
    expect(parse(f.text({ format, minLength: 1 }), input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["email", "office@"],
    ["email", "a b@example.com"],
    ["phone", "555-0142"],
    ["phone", "call me"],
    ["color", "blue"],
    ["color", "#12345"],
    ["time", "24:00"],
    ["time", "8:30"],
    ["date", "2027-02-29"],
    ["date", "12/25/2026"],
    ["zip", "7870"],
    ["zip", "78701-1234"],
    ["us_state", "ZZ"],
    ["slug", "Roof Age"],
    ["slug", "1st"],
    ["origin", "https://www.example.com/shop"],
    ["origin", "www.example.com"],
    ["origin", "ftp://example.com"],
    ["domain", "https://example.com"],
    ["domain", "localhost"],
    ["url", "javascript:alert(1)"],
    ["url", "example.com"],
    ["model_id", "gpt-4"],
    ["model_id", "claude fable"],
  ] as const)("refuses a bad %s: %s", (format, input) => {
    expect(parse(f.text({ format, minLength: 1 }), input).ok).toBe(false);
  });

  it("tidying is idempotent", () => {
    for (const [format, input] of [
      ["phone", "(512) 555-0142"],
      ["origin", "https://WWW.Example.com///"],
      ["us_state", "tx"],
    ] as const) {
      const field = f.text({ format });
      const once = field.schema.parse(input);
      expect(field.schema.parse(once)).toBe(once);
    }
  });

  it("checks placeholders of a template", () => {
    const field = f.text({ variables: ["business_name", "bot_name"] });
    expect(parse(field, "Hi from {{ business_name }}, I'm {{bot_name}}").ok).toBe(true);
    expect(messages(field, "Hi {{customer}}")[0]).toMatch(/Unknown placeholder \{\{customer\}\}/);
    expect(messages(f.text({ variables: [] }), "Hi {{x}}")[0]).toMatch(/takes no placeholders/);
    // Not a template: braces are just text.
    expect(parse(f.text(), "Hi {{anything}}").ok).toBe(true);
  });
});

describe("templates", () => {
  it("lists and fills placeholders", () => {
    expect(templateVariablesIn("{{a}} and {{ b }} and {{a}}")).toEqual(["a", "b"]);
    expect(renderTemplate("{{a}} to {{ b }}, {{c}}", { a: "one", b: 2 })).toBe("one to 2, {{c}}");
  });
});

describe("numbers", () => {
  it("enforces range and whole numbers", () => {
    const whole = f.integer({ min: 0, max: 100, unit: "points" });
    expect(parse(whole, 50).ok).toBe(true);
    expect(messages(whole, 50.5)).toEqual(["Enter a whole number."]);
    expect(messages(whole, -1)[0]).toBe("Enter a number of at least 0 points.");
    expect(messages(whole, 101)[0]).toBe("Enter a number of at most 100 points.");
    expect(parse(whole, "50").ok).toBe(false);
    expect(parse(whole, Number.NaN).ok).toBe(false);
    expect(parse(whole, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(parse(f.number({ min: 0, max: 1 }), 0.25).ok).toBe(true);
  });
});

describe("select and multi-select", () => {
  it("accepts only its options and keeps their labels", () => {
    const field = f.select(["never", ["ranges", "Ranges"], ["exact", "Exact", "Listed prices"]]);
    expect(field.options).toEqual([
      { value: "never", label: "Never" },
      { value: "ranges", label: "Ranges" },
      { value: "exact", label: "Exact", description: "Listed prices" },
    ]);
    expect(parse(field, "ranges").ok).toBe(true);
    expect(messages(field, "sometimes")[0]).toMatch(/Choose one of: never, ranges, exact/);
    expect(() => f.select([])).toThrow();
    expect(() => f.select(["a", "a"])).toThrow();
  });

  it("stores a multi-select in option order, without duplicates, within its limits", () => {
    const field = f.multiSelect(["name", "phone", "email"], { minItems: 1, maxItems: 2 });
    expect(parse(field, ["phone", "name"])).toEqual({ ok: true, value: ["name", "phone"] });
    expect(messages(field, ["name", "name"])).toContain("Each option can be chosen only once.");
    expect(messages(field, [])).toContain("Choose at least 1 option.");
    expect(messages(field, ["name", "phone", "email"])).toContain("Choose at most 2 options.");
    expect(parse(field, ["fax"]).ok).toBe(false);
    expect(parse(field, "name").ok).toBe(false);
  });
});

describe("list, object, nullable", () => {
  it("enforces list limits and uniqueness", () => {
    const zips = f.stringList({ itemLabel: "ZIP code", format: "zip", maxItems: 2 });
    expect(parse(zips, ["78701", "78702"]).ok).toBe(true);
    expect(messages(zips, ["78701", "78701"])).toContain("This entry is listed twice.");
    expect(messages(zips, ["78701", "78702", "78703"])[0]).toMatch(/At most 2 entries/);
    expect(parse(zips, ["7870"]).ok).toBe(false);

    const people = f.list(f.object({ name: { label: "Name", field: f.text({ minLength: 1 }) } }), {
      itemLabel: "person",
      minItems: 1,
      unique: "name",
    });
    expect(messages(people, [])).toContain("Add at least 1 person.");
    const duplicate = parse(people, [{ name: "Ana" }, { name: "ana" }]);
    expect(duplicate.ok).toBe(false);
    expect(!duplicate.ok && duplicate.problems[0]?.path).toEqual([1, "name"]);
  });

  it("objects are strict and run their cross-property check", () => {
    const field = f.object(
      {
        hot: { label: "Hot", field: f.integer({ min: 0, max: 100 }) },
        warm: { label: "Warm", field: f.integer({ min: 0, max: 100 }) },
      },
      {
        check: (value) =>
          value.hot > value.warm ? [] : [{ path: ["hot"], message: "Hot must be above warm." }],
      },
    );
    expect(parse(field, { hot: 70, warm: 40 }).ok).toBe(true);
    expect(parse(field, { hot: 30, warm: 40 })).toEqual({
      ok: false,
      problems: [{ path: ["hot"], message: "Hot must be above warm." }],
    });
    expect(parse(field, { hot: 70 }).ok).toBe(false);
    expect(parse(field, { hot: 70, warm: 40, cold: 1 }).ok).toBe(false);
    expect(parse(field, null).ok).toBe(false);
    expect(parse(field, [70, 40]).ok).toBe(false);
  });

  it("nullable accepts null and the inner value, not undefined", () => {
    const field = f.nullable(f.integer({ min: 1, max: 9 }), "No limit");
    expect(parse(field, null)).toEqual({ ok: true, value: null });
    expect(parse(field, 5).ok).toBe(true);
    expect(parse(field, 10).ok).toBe(false);
    expect(parse(field, undefined).ok).toBe(false);
  });
});

describe("weekly hours and daily windows", () => {
  it("accepts ordered, non-overlapping intervals", () => {
    const field = f.weeklyHours();
    const hours = sameHoursOn(["monday", "tuesday"], "08:00", "17:00");
    expect(parse(field, hours).ok).toBe(true);
    expect(hours.sunday).toEqual([]);
    expect(
      parse(field, {
        ...hours,
        monday: [
          { open: "08:00", close: "12:00" },
          { open: "13:00", close: "17:00" },
        ],
      }).ok,
    ).toBe(true);
  });

  it("refuses inverted and overlapping intervals and missing days", () => {
    const field = f.weeklyHours();
    const hours = sameHoursOn(["monday"], "08:00", "17:00");
    const inverted = parse(field, { ...hours, monday: [{ open: "17:00", close: "08:00" }] });
    expect(!inverted.ok && inverted.problems[0]?.path).toEqual(["monday", 0, "close"]);
    const overlapping = parse(field, {
      ...hours,
      monday: [
        { open: "08:00", close: "12:00" },
        { open: "11:00", close: "17:00" },
      ],
    });
    expect(!overlapping.ok && overlapping.problems[0]?.path).toEqual(["monday", 1, "open"]);
    const { sunday: _sunday, ...sixDays } = hours;
    expect(parse(field, sixDays).ok).toBe(false);
  });

  it("a daily window may cross midnight but not be empty", () => {
    const field = f.dailyWindow({ enabled: "On", start: "From", end: "Until" });
    expect(parse(field, { enabled: true, start: "21:00", end: "08:00" }).ok).toBe(true);
    expect(parse(field, { enabled: true, start: "21:00", end: "21:00" }).ok).toBe(false);
  });
});

describe("describing a field", () => {
  it("walks nested fields", () => {
    const field = f.list(
      f.object({
        name: { label: "Name", field: f.text() },
        limit: { label: "Limit", field: f.nullable(f.integer({ min: 0, max: 5 }), "None") },
      }),
      { itemLabel: "row" },
    );
    const seen: string[] = [];
    walkField(field, (inner, path) => seen.push(`${path.join(".")}:${inner.kind}`));
    expect(seen).toEqual([
      ":list",
      "[]:object",
      "[].name:text",
      "[].limit:nullable",
      "[].limit:number",
    ]);
  });

  it("says what a field accepts", () => {
    expect(describeField(f.boolean())).toBe("yes / no");
    expect(describeField(f.integer({ min: 0, max: 100, unit: "points" }))).toBe(
      "whole number, 0 to 100 points",
    );
    expect(describeField(f.select(["a", "b"]))).toBe("one of: `a`, `b`");
    expect(describeField(f.nullable(f.text({ format: "zip" }), "Business address"))).toBe(
      "five-digit ZIP code, or empty (business address)",
    );
    expect(describeField(f.text({ variables: ["bot_name"] }))).toBe(
      "text, up to 200 characters; placeholders: {{bot_name}}",
    );
  });
});

describe("blankValue", () => {
  it("has the shape of the field, for every kind", () => {
    expect(blankValue(f.boolean())).toBe(false);
    expect(blankValue(f.text())).toBe("");
    expect(blankValue(f.integer({ min: 5, max: 9 }))).toBe(5);
    expect(blankValue(f.integer({ min: -9, max: -5 }))).toBe(-5);
    expect(blankValue(f.integer({ min: -5, max: 5 }))).toBe(0);
    expect(blankValue(f.select(["b", "a"]))).toBe("b");
    expect(blankValue(f.multiSelect(["a", "b"]))).toEqual([]);
    expect(blankValue(f.nullable(f.text(), "None"))).toBeNull();
    const row = f.object({
      name: { label: "Name", field: f.text({ minLength: 1 }) },
      days: { label: "Days", field: f.multiSelect(["mon", "tue"]) },
      limit: { label: "Limit", field: f.nullable(f.integer({ min: 1, max: 5 }), "None") },
      on: { label: "On", field: f.boolean() },
    });
    expect(blankValue(row)).toEqual({ name: "", days: [], limit: null, on: false });
    expect(blankValue(f.list(row, { itemLabel: "row" }))).toEqual([]);
    // The shape is right even where the content is not valid yet.
    const parsed = row.schema.safeParse(blankValue(row));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["name"]]);
  });
});
