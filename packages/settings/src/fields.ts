import { z } from "zod";

/**
 * Field builders: the vocabulary every setting is declared in.
 *
 * A field is two things at once: the Zod schema that validates a value, and a plain
 * description of that value (kind, limits, options with labels, unit) that a form can be
 * drawn from. Because both come from one builder call they cannot drift apart, and the admin
 * panel can render any setting without knowing it in advance: it switches on `kind` and
 * recurses into `item`, `properties` and `inner`.
 *
 * Rules the builders keep:
 * - Values are plain JSON (they are stored in a `jsonb` column and hashed).
 * - Schemas may tidy a value (trim text, lower-case a color, sort a multi-select) but never
 *   change its type, and tidying twice gives the same result as tidying once.
 * - Objects are strict: an unknown property is an error, not something to drop silently.
 */

// ---------------------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------------------

export const TEXT_FORMATS = [
  "plain",
  "email",
  "url",
  "phone",
  "color",
  "time",
  "date",
  "zip",
  "us_state",
  "slug",
  "origin",
  "domain",
  "model_id",
] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

interface FieldCommon<T> {
  readonly schema: z.ZodType<T>;
  /**
   * Optional name of a purpose-built control ("weekly_hours", "time_range"). A form that
   * does not know the name falls back to the generic control for `kind`, which always works.
   */
  readonly widget: string | null;
}

export interface BooleanField extends FieldCommon<boolean> {
  readonly kind: "boolean";
}

export interface TextField extends FieldCommon<string> {
  readonly kind: "text";
  readonly format: TextFormat;
  readonly multiline: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly placeholder: string | null;
  /**
   * Placeholders the text may contain, written `{{name}}`. Null: the text is not a template
   * and braces mean nothing. An unknown placeholder is a validation error.
   */
  readonly variables: readonly string[] | null;
  /** Values to offer in a combo box. The field still accepts any valid text. */
  readonly suggestions: readonly string[];
}

export interface NumberField extends FieldCommon<number> {
  readonly kind: "number";
  readonly integer: boolean;
  readonly min: number;
  readonly max: number;
  /** Suggested increment for a stepper. Not enforced. */
  readonly step: number | null;
  /** Shown after the input: "minutes", "USD", "%". */
  readonly unit: string | null;
}

export interface SelectOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
  readonly description?: string;
}

export interface SelectField<V extends string = string> extends FieldCommon<V> {
  readonly kind: "select";
  readonly options: readonly SelectOption<V>[];
}

export interface MultiSelectField<V extends string = string> extends FieldCommon<V[]> {
  readonly kind: "multi_select";
  readonly options: readonly SelectOption<V>[];
  readonly minItems: number;
  readonly maxItems: number;
}

export interface ListField<T = unknown> extends FieldCommon<T[]> {
  readonly kind: "list";
  readonly item: AnyField;
  /** Singular name of one entry, for "Add ..." buttons: "holiday", "ZIP code". */
  readonly itemLabel: string;
  readonly minItems: number;
  readonly maxItems: number;
  /**
   * Entries must differ: `true` compares whole values, a string names the property of an
   * object item that must be unique (compared without regard to case).
   */
  readonly unique: boolean | string;
}

export interface ObjectProperty {
  readonly name: string;
  readonly label: string;
  readonly help: string | null;
  readonly field: AnyField;
}

export interface ObjectField<T = Record<string, unknown>> extends FieldCommon<T> {
  readonly kind: "object";
  readonly properties: readonly ObjectProperty[];
}

export interface NullableField<T = unknown> extends FieldCommon<T | null> {
  readonly kind: "nullable";
  readonly inner: AnyField;
  /** What "no value" means, for the checkbox or the empty state: "No limit". */
  readonly nullLabel: string;
}

export type AnyField =
  | BooleanField
  | TextField
  | NumberField
  | SelectField
  | MultiSelectField
  | ListField
  | ObjectField<unknown>
  | NullableField;

export type FieldKind = AnyField["kind"];

/** The TypeScript type of a field's value. */
export type FieldValue<F> = F extends { readonly schema: z.ZodType<infer T> } ? T : never;

/** One thing wrong with a value, addressed by its path inside the value. */
export interface FieldProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

export const US_STATE_CODES = [
  ...["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN"],
  ...["IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH"],
  ...["NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT"],
  ...["VT", "VA", "WA", "WV", "WI", "WY"],
] as const;

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The placeholder names used in a template, in order of first appearance. */
export function templateVariablesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Fills `{{name}}` placeholders. A name without a value is left as it is. */
export function renderTemplate(
  text: string,
  values: Readonly<Record<string, string | number | null | undefined>>,
): string {
  return text.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

function normalizePhone(value: string): string {
  const compact = value.replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  return compact;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

interface FormatRule {
  readonly normalize?: (value: string) => string;
  readonly test: (value: string) => boolean;
  readonly message: string;
  /** Short description for the generated documentation. */
  readonly describe: string;
}

const FORMAT_RULES: Readonly<Record<Exclude<TextFormat, "plain">, FormatRule>> = {
  email: {
    normalize: (value) => value.toLowerCase(),
    test: (value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(value),
    message: "Enter an email address, for example office@example.com.",
    describe: "email address",
  },
  url: {
    test: (value) => parseHttpUrl(value) !== null && !/\s/.test(value),
    message: "Enter a web address that starts with https:// or http://.",
    describe: "web address",
  },
  phone: {
    normalize: normalizePhone,
    test: (value) => /^\+[1-9]\d{7,14}$/.test(value),
    message: "Enter a phone number with area code, for example +1 512 555 0142.",
    describe: "phone number (stored as E.164)",
  },
  color: {
    normalize: (value) => value.toLowerCase(),
    test: (value) => /^#[0-9a-f]{6}$/.test(value),
    message: "Enter a color as # followed by six hex digits, for example #1d4ed8.",
    describe: "color (#rrggbb)",
  },
  time: {
    test: (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    message: "Enter a time as HH:MM on the 24-hour clock, for example 08:30.",
    describe: "time of day (HH:MM, 24-hour)",
  },
  date: {
    test: isRealDate,
    message: "Enter a date as YYYY-MM-DD, for example 2026-12-25.",
    describe: "date (YYYY-MM-DD)",
  },
  zip: {
    test: (value) => /^\d{5}$/.test(value),
    message: "Enter a five-digit ZIP code.",
    describe: "five-digit ZIP code",
  },
  us_state: {
    normalize: (value) => value.toUpperCase(),
    test: (value) => (US_STATE_CODES as readonly string[]).includes(value),
    message: "Enter a two-letter state code, for example TX.",
    describe: "two-letter US state code",
  },
  slug: {
    test: (value) => /^[a-z][a-z0-9_]*$/.test(value),
    message: "Use lower-case letters, digits and underscores, starting with a letter.",
    describe: "identifier (lower-case letters, digits, underscores)",
  },
  origin: {
    normalize: (value) => value.toLowerCase().replace(/\/+$/, ""),
    test: (value) => parseHttpUrl(value)?.origin === value,
    message: "Enter a site origin without a path, for example https://www.example.com.",
    describe: "site origin (scheme and host, no path)",
  },
  domain: {
    normalize: (value) => value.toLowerCase(),
    test: (value) =>
      value.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
    message: "Enter a domain name, for example example.com.",
    describe: "domain name",
  },
  model_id: {
    test: (value) => /^claude-[a-z0-9][a-z0-9.-]*$/.test(value),
    message: "Enter a Claude model id, for example claude-fable-5-2.",
    describe: "Claude model id",
  },
};

export interface TextOptions {
  readonly format?: TextFormat;
  readonly multiline?: boolean;
  /** Default 0: the empty string is a valid value and means "not set". */
  readonly minLength?: number;
  /** Default 200 (single line) or 2000 (multi-line). */
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly variables?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly widget?: string;
}

function text(options: TextOptions = {}): TextField {
  const format = options.format ?? "plain";
  const multiline = options.multiline ?? false;
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? (multiline ? 2000 : 200);
  const variables = options.variables ?? null;
  const rule = format === "plain" ? null : FORMAT_RULES[format];

  const schema = z
    .string()
    .trim()
    .overwrite((value) => (rule?.normalize === undefined ? value : rule.normalize(value)))
    .superRefine((value, ctx) => {
      const problem = (message: string) => ctx.addIssue({ code: "custom", message });
      if (value.length < minLength) {
        problem(
          minLength === 1 ? "This cannot be empty." : `Use at least ${minLength} characters.`,
        );
        return;
      }
      if (value.length > maxLength) {
        problem(`Use at most ${maxLength} characters (this has ${value.length}).`);
        return;
      }
      if (!multiline && /[\r\n]/.test(value)) {
        problem("This must be a single line.");
        return;
      }
      // PostgreSQL cannot store U+0000 in jsonb; refuse it here instead of failing the write.
      if (value.includes("\u0000")) {
        problem("This text contains a character that cannot be saved.");
        return;
      }
      // An empty value means "not set" when the field allows it; formats apply to the rest.
      if (rule !== null && value !== "" && !rule.test(value)) {
        problem(rule.message);
        return;
      }
      if (variables !== null) {
        const unknown = templateVariablesIn(value).filter((name) => !variables.includes(name));
        if (unknown.length > 0) {
          problem(
            `Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(", ")}. ` +
              (variables.length === 0
                ? "This text takes no placeholders."
                : `Available: ${variables.map((name) => `{{${name}}}`).join(", ")}.`),
          );
        }
      }
    });

  return {
    kind: "text",
    schema,
    widget: options.widget ?? null,
    format,
    multiline,
    minLength,
    maxLength,
    placeholder: options.placeholder ?? null,
    variables,
    suggestions: options.suggestions ?? [],
  };
}

// ---------------------------------------------------------------------------------------
// Boolean, number
// ---------------------------------------------------------------------------------------

function boolean(): BooleanField {
  return { kind: "boolean", schema: z.boolean(), widget: null };
}

export interface NumberOptions {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly widget?: string;
}

function numeric(options: NumberOptions, isInteger: boolean): NumberField {
  const { min, max } = options;
  const unit = options.unit === undefined ? "" : ` ${options.unit}`;
  const base = isInteger ? z.number().int("Enter a whole number.") : z.number();
  const schema = base
    .min(min, `Enter a number of at least ${min}${unit}.`)
    .max(max, `Enter a number of at most ${max}${unit}.`);
  return {
    kind: "number",
    schema,
    widget: options.widget ?? null,
    integer: isInteger,
    min,
    max,
    step: options.step ?? (isInteger ? 1 : null),
    unit: options.unit ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Select, multi-select
// ---------------------------------------------------------------------------------------

type OptionInput<V extends string> =
  V | SelectOption<V> | readonly [value: V, label: string, description?: string];

function titleCase(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toOption<V extends string>(input: OptionInput<V>): SelectOption<V> {
  if (typeof input === "string") return { value: input, label: titleCase(input) };
  if (Array.isArray(input)) {
    const [value, label, description] = input as readonly [V, string, string?];
    return description === undefined ? { value, label } : { value, label, description };
  }
  return input as SelectOption<V>;
}

function toOptions<V extends string>(inputs: readonly OptionInput<V>[]): SelectOption<V>[] {
  const options = inputs.map(toOption);
  const values = new Set(options.map((option) => option.value));
  if (options.length === 0 || values.size !== options.length) {
    throw new Error("A select needs at least one option and no duplicate values.");
  }
  return options;
}

function enumSchema<V extends string>(options: readonly SelectOption<V>[]): z.ZodType<V> {
  const values = options.map((option) => option.value);
  return z.enum(values as [V, ...V[]], {
    error: `Choose one of: ${values.join(", ")}.`,
  });
}

/** One value out of a fixed list. Options are a value, `[value, label]` or `[value, label, description]`. */
function select<const V extends string>(inputs: readonly OptionInput<V>[]): SelectField<V> {
  const options = toOptions(inputs);
  return { kind: "select", schema: enumSchema(options), widget: null, options };
}

export interface MultiSelectOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** Any number of values out of a fixed list, stored in the order of the options. */
function multiSelect<const V extends string>(
  inputs: readonly OptionInput<V>[],
  limits: MultiSelectOptions = {},
): MultiSelectField<V> {
  const options = toOptions(inputs);
  const order = new Map(options.map((option, index) => [option.value as string, index]));
  const minItems = limits.minItems ?? 0;
  const maxItems = limits.maxItems ?? options.length;
  const schema = z
    .array(enumSchema(options))
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", message: "Each option can be chosen only once." });
      }
      if (values.length < minItems) {
        ctx.addIssue({
          code: "custom",
          message: `Choose at least ${minItems} option${minItems === 1 ? "" : "s"}.`,
        });
      }
      if (values.length > maxItems) {
        ctx.addIssue({ code: "custom", message: `Choose at most ${maxItems} options.` });
      }
    })
    .overwrite((values) =>
      [...values].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    ) as z.ZodType<V[]>;
  return { kind: "multi_select", schema, widget: null, options, minItems, maxItems };
}

// ---------------------------------------------------------------------------------------
// List, object, nullable
// ---------------------------------------------------------------------------------------

export interface ListOptions {
  readonly itemLabel: string;
  readonly minItems?: number;
  /** Default 100. Every list has a limit: settings are loaded on every turn. */
  readonly maxItems?: number;
  readonly unique?: boolean | string;
  readonly widget?: string;
}

function comparable(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : JSON.stringify(value);
}

function list<F extends AnyField>(item: F, options: ListOptions): ListField<FieldValue<F>> {
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? 100;
  const unique = options.unique ?? false;
  const schema = z.array(item.schema).superRefine((values, ctx) => {
    if (values.length < minItems) {
      ctx.addIssue({
        code: "custom",
        message: `Add at least ${minItems} ${options.itemLabel}${minItems === 1 ? "" : "s"}.`,
      });
    }
    if (values.length > maxItems) {
      ctx.addIssue({
        code: "custom",
        message: `At most ${maxItems} entries are allowed (this has ${values.length}).`,
      });
    }
    if (unique === false) return;
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = comparable(
        typeof unique === "string" ? (value as Record<string, unknown>)[unique] : value,
      );
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: typeof unique === "string" ? [index, unique] : [index],
          message:
            typeof unique === "string"
              ? `Another ${options.itemLabel} already uses this ${unique}.`
              : "This entry is listed twice.",
        });
      }
      seen.add(key);
    });
  }) as unknown as z.ZodType<FieldValue<F>[]>;
  return {
    kind: "list",
    schema,
    widget: options.widget ?? null,
    item,
    itemLabel: options.itemLabel,
    minItems,
    maxItems,
    unique,
  };
}

/** A property of an object field: a field plus the label and help its control shows. */
export interface PropertySpec<F extends AnyField = AnyField> {
  readonly label: string;
  readonly help?: string;
  readonly field: F;
}

export interface ObjectOptions<T> {
  /** Rules that involve several properties. Runs only on a value that is otherwise valid. */
  readonly check?: (value: T) => readonly FieldProblem[];
  readonly widget?: string;
}

type ObjectValue<P extends Record<string, PropertySpec>> = {
  [K in keyof P]: FieldValue<P[K]["field"]>;
};

function object<const P extends Record<string, PropertySpec>>(
  properties: P,
  options: ObjectOptions<ObjectValue<P>> = {},
): ObjectField<ObjectValue<P>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(properties)) shape[name] = property.field.schema;
  const { check } = options;
  const strict = z.strictObject(shape);
  const schema = (check === undefined
    ? strict
    : strict.superRefine((value, ctx) => {
        for (const problem of check(value as ObjectValue<P>)) {
          ctx.addIssue({ code: "custom", path: [...problem.path], message: problem.message });
        }
      })) as unknown as z.ZodType<ObjectValue<P>>;
  return {
    kind: "object",
    schema,
    widget: options.widget ?? null,
    properties: Object.entries(properties).map(([name, property]) => ({
      name,
      label: property.label,
      help: property.help ?? null,
      field: property.field,
    })),
  };
}

function nullable<F extends AnyField>(inner: F, nullLabel: string): NullableField<FieldValue<F>> {
  return {
    kind: "nullable",
    schema: inner.schema.nullable() as z.ZodType<FieldValue<F> | null>,
    widget: null,
    inner,
    nullLabel,
  };
}

// ---------------------------------------------------------------------------------------
// Shapes used by many settings
// ---------------------------------------------------------------------------------------

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface TimeInterval {
  open: string;
  close: string;
}
export type WeeklyHours = Record<Weekday, TimeInterval[]>;

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Opening hours for each day of the week: a list of open intervals per day, an empty list
 * meaning closed. "24:00" is not a time; use 23:59 for "until midnight".
 */
function weeklyHours(): ObjectField<WeeklyHours> {
  const interval = object({
    open: { label: "Opens", field: text({ format: "time", minLength: 5 }) },
    close: { label: "Closes", field: text({ format: "time", minLength: 5 }) },
  });
  const day = (label: string) => ({
    label,
    field: list(interval, { itemLabel: "open interval", maxItems: 4 }),
  });
  return object(
    {
      monday: day("Monday"),
      tuesday: day("Tuesday"),
      wednesday: day("Wednesday"),
      thursday: day("Thursday"),
      friday: day("Friday"),
      saturday: day("Saturday"),
      sunday: day("Sunday"),
    },
    {
      widget: "weekly_hours",
      check: (value) => {
        const problems: FieldProblem[] = [];
        for (const weekday of WEEKDAYS) {
          let previousClose = -1;
          value[weekday].forEach((entry, index) => {
            const open = minutesOf(entry.open);
            const close = minutesOf(entry.close);
            if (close <= open) {
              problems.push({
                path: [weekday, index, "close"],
                message: "The closing time must be later than the opening time.",
              });
            } else if (open < previousClose) {
              problems.push({
                path: [weekday, index, "open"],
                message: "Intervals of one day must be in order and must not overlap.",
              });
            }
            previousClose = Math.max(previousClose, close);
          });
        }
        return problems;
      },
    },
  );
}

/** Builds a `WeeklyHours` value: the same hours on the given days, closed on the others. */
export function sameHoursOn(days: readonly Weekday[], open: string, close: string): WeeklyHours {
  const hours = {} as WeeklyHours;
  for (const weekday of WEEKDAYS) {
    hours[weekday] = days.includes(weekday) ? [{ open, close }] : [];
  }
  return hours;
}

export interface DailyWindow {
  enabled: boolean;
  start: string;
  end: string;
}

/**
 * A window of the day that may run past midnight (21:00 to 08:00), with a switch. Used for
 * quiet hours.
 */
function dailyWindow(labels: {
  readonly enabled: string;
  readonly start: string;
  readonly end: string;
}): ObjectField<DailyWindow> {
  return object(
    {
      enabled: { label: labels.enabled, field: boolean() },
      start: { label: labels.start, field: text({ format: "time", minLength: 5 }) },
      end: { label: labels.end, field: text({ format: "time", minLength: 5 }) },
    },
    {
      widget: "daily_window",
      check: (value) =>
        value.start === value.end
          ? [{ path: ["end"], message: "The start and the end must be different times." }]
          : [],
    },
  );
}

export interface StringListOptions extends Omit<ListOptions, "unique"> {
  readonly format?: TextFormat;
  /** Longest single entry. Default 120. */
  readonly maxLength?: number;
  readonly placeholder?: string;
}

/** A list of short texts without duplicates: keywords, ZIP codes, domains. */
function stringList(options: StringListOptions): ListField<string> {
  return list(
    text({
      format: options.format ?? "plain",
      minLength: 1,
      maxLength: options.maxLength ?? 120,
      placeholder: options.placeholder,
    }),
    { ...options, unique: true },
  );
}

/**
 * The field builders. `f.text()`, `f.integer({ min, max })`, `f.select([...])`,
 * `f.list(item, { itemLabel })`, `f.object({ name: { label, field } })`, `f.nullable(field, "No limit")`.
 */
export const f = {
  boolean,
  text,
  /** A number that may have decimals. */
  number: (options: NumberOptions) => numeric(options, false),
  /** A whole number. */
  integer: (options: NumberOptions) => numeric(options, true),
  select,
  multiSelect,
  list,
  stringList,
  object,
  nullable,
  weeklyHours,
  dailyWindow,
} as const;

// ---------------------------------------------------------------------------------------
// Reading a field
// ---------------------------------------------------------------------------------------

/** The problems Zod found, in the shape the rest of the package uses. */
export function problemsOf(error: z.ZodError): FieldProblem[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    ),
    message: issue.message,
  }));
}

/** Calls `visit` for the field and every field nested in it. */
export function walkField(
  field: AnyField,
  visit: (field: AnyField, path: readonly string[]) => void,
  path: readonly string[] = [],
): void {
  visit(field, path);
  switch (field.kind) {
    case "list":
      walkField(field.item, visit, [...path, "[]"]);
      break;
    case "object":
      for (const property of field.properties) {
        walkField(property.field, visit, [...path, property.name]);
      }
      break;
    case "nullable":
      walkField(field.inner, visit, path);
      break;
    default:
      break;
  }
}

/**
 * A starting value for a field: what a form shows when an entry is added to a list or a
 * nullable field is switched on. It has the right shape but is not necessarily valid (an
 * empty required text is not); validation happens when the form is saved.
 */
export function blankValue(field: AnyField): unknown {
  switch (field.kind) {
    case "boolean":
      return false;
    case "text":
      return "";
    case "number":
      return Math.min(Math.max(0, field.min), field.max);
    case "select":
      return field.options[0]?.value ?? "";
    case "multi_select":
    case "list":
      return [];
    case "object":
      return Object.fromEntries(
        field.properties.map((property) => [property.name, blankValue(property.field)]),
      );
    case "nullable":
      return null;
  }
}

function describeRange(field: NumberField): string {
  const unit = field.unit === null ? "" : ` ${field.unit}`;
  return `${field.integer ? "whole number" : "number"}, ${field.min} to ${field.max}${unit}`;
}

/** One line that says what a field accepts, for the generated documentation. */
export function describeField(field: AnyField): string {
  switch (field.kind) {
    case "boolean":
      return "yes / no";
    case "text": {
      const what =
        field.format === "plain"
          ? field.multiline
            ? "text (several lines)"
            : "text"
          : FORMAT_RULES[field.format].describe;
      const length = field.format === "plain" ? `, up to ${field.maxLength} characters` : "";
      const variables =
        field.variables === null || field.variables.length === 0
          ? ""
          : `; placeholders: ${field.variables.map((name) => `{{${name}}}`).join(", ")}`;
      return `${what}${length}${variables}`;
    }
    case "number":
      return describeRange(field);
    case "select":
      return `one of: ${field.options.map((option) => `\`${option.value}\``).join(", ")}`;
    case "multi_select":
      return `any of: ${field.options.map((option) => `\`${option.value}\``).join(", ")}`;
    case "list": {
      const limit = `up to ${field.maxItems}`;
      return `list (${limit}) of: ${describeField(field.item)}`;
    }
    case "object":
      return `{ ${field.properties
        .map((property) => `${property.name}: ${describeField(property.field)}`)
        .join("; ")} }`;
    case "nullable":
      return `${describeField(field.inner)}, or empty (${field.nullLabel.toLowerCase()})`;
  }
}
