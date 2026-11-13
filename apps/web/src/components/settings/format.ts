import { type AnyField, WEEKDAYS } from "@repo/settings";

/*
 * One-line summaries of setting values, drawn from the field description alone, so a new
 * setting is summarized without any code here. Used by the settings screen (browser) and
 * the overview pages (server). Values are only ever rendered as text.
 */

const MAX = 120;

function clip(text: string, max = MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : noun.endsWith("s") ? "es" : "s"}`;
}

const DAY_SHORT: Readonly<Record<string, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function weeklyHours(value: Record<string, unknown>): string {
  const parts: string[] = [];
  let run: { from: string; to: string; hours: string } | null = null;
  const flush = () => {
    if (run === null) return;
    parts.push(`${run.from === run.to ? run.from : `${run.from}–${run.to}`} ${run.hours}`);
    run = null;
  };
  for (const day of WEEKDAYS) {
    const intervals = Array.isArray(value[day])
      ? (value[day] as { open?: string; close?: string }[])
      : [];
    const hours = intervals
      .map((interval) => `${interval.open ?? "?"}–${interval.close ?? "?"}`)
      .join(", ");
    if (hours === "") {
      flush();
      continue;
    }
    if (run !== null && run.hours === hours) {
      run.to = DAY_SHORT[day] ?? day;
    } else {
      flush();
      run = { from: DAY_SHORT[day] ?? day, to: DAY_SHORT[day] ?? day, hours };
    }
  }
  flush();
  return parts.length === 0 ? "Closed every day" : parts.join("; ");
}

/** A short, plain-text summary of a value of the field. */
export function summarizeValue(field: AnyField, value: unknown): string {
  switch (field.kind) {
    case "boolean":
      return value === true ? "On" : "Off";
    case "text":
      return typeof value === "string" && value.trim() !== "" ? clip(value) : "Empty";
    case "number":
      return typeof value === "number"
        ? `${value}${field.unit === null ? "" : ` ${field.unit}`}`
        : "Not a number";
    case "select":
      return field.options.find((option) => option.value === value)?.label ?? String(value);
    case "multi_select": {
      const values = Array.isArray(value) ? (value as unknown[]) : [];
      if (values.length === 0) return "None";
      return clip(
        values
          .map(
            (item) => field.options.find((option) => option.value === item)?.label ?? String(item),
          )
          .join(", "),
      );
    }
    case "list": {
      const items = Array.isArray(value) ? (value as unknown[]) : [];
      if (items.length === 0) return "None";
      if ((field.item.kind === "text" || field.item.kind === "select") && items.length <= 6) {
        return clip(items.map((item) => summarizeValue(field.item, item)).join(", "));
      }
      return plural(items.length, field.itemLabel);
    }
    case "object": {
      if (typeof value !== "object" || value === null) return "Not set";
      const record = value as Record<string, unknown>;
      if (field.widget === "weekly_hours") return clip(weeklyHours(record));
      if (field.widget === "daily_window") {
        return record["enabled"] === false
          ? "Off"
          : `${String(record["start"])}–${String(record["end"])}`;
      }
      return clip(
        field.properties
          .filter((property) => property.field.kind !== "object" && property.field.kind !== "list")
          .slice(0, 4)
          .map(
            (property) =>
              `${property.label}: ${summarizeValue(property.field, record[property.name])}`,
          )
          .join("; "),
      );
    }
    case "nullable":
      return value === null || value === undefined
        ? field.nullLabel
        : summarizeValue(field.inner, value);
  }
}

/** Where a value comes from, relative to the scope the screen shows. */
export function sourceLabel(
  source: "default" | "global" | "segment" | "business",
  screenScope: "global" | "segment" | "business",
): string {
  if (source === screenScope) return "Set here";
  switch (source) {
    case "default":
      return "Default";
    case "global":
      return "From the agency";
    case "segment":
      return "From the segment";
    case "business":
      return "From the business";
  }
}

/** "Monday › 1st › Closes": a problem's path in the words of the form. */
export function describePath(field: AnyField, path: readonly (string | number)[]): string {
  const words: string[] = [];
  let current: AnyField | undefined = field;
  for (const part of path) {
    if (current === undefined) break;
    if (current.kind === "nullable") current = current.inner;
    if (current.kind === "list" && typeof part === "number") {
      words.push(`${current.itemLabel} ${part + 1}`);
      current = current.item;
    } else if (current.kind === "object" && typeof part === "string") {
      const property: { label: string; field: AnyField } | undefined = current.properties.find(
        (candidate) => candidate.name === part,
      );
      words.push(property?.label ?? part);
      current = property?.field;
    } else {
      words.push(String(part));
      current = undefined;
    }
  }
  return words.join(" › ");
}
