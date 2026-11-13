"use client";

import { useId } from "react";

import {
  type AnyField,
  blankValue,
  type ListField,
  type ObjectField,
  WEEKDAYS,
} from "@repo/settings";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/form";

/*
 * The control for any setting, drawn from its field description alone (C2's registry): it
 * switches on `kind` and recurses into lists, objects and nullable values, so a setting
 * added to the registry gets a working form without any code here. Values stay plain JSON;
 * validation is the field's own schema, run on save (here and again on the server).
 */

export type Path = readonly (string | number)[];
export type ProblemMap = ReadonlyMap<string, readonly string[]>;

export const pathKey = (path: Path) => JSON.stringify(path);

interface EditorProps {
  readonly field: AnyField;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  /** Accessible name of the control, when the caller has no visible label for it. */
  readonly label: string;
  readonly path: Path;
  readonly problems: ProblemMap;
  readonly disabled?: boolean;
}

const INPUT_TYPES: Readonly<Record<string, string>> = {
  email: "email",
  url: "url",
  phone: "tel",
  color: "color",
  time: "time",
  date: "date",
};

function ProblemText({ problems, path }: { readonly problems: ProblemMap; readonly path: Path }) {
  const messages = problems.get(pathKey(path));
  if (messages === undefined || messages.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {messages.map((message) => (
        <li key={message} className="text-xs font-medium text-red-700">
          {message}
        </li>
      ))}
    </ul>
  );
}

function invalid(problems: ProblemMap, path: Path): boolean {
  return (problems.get(pathKey(path))?.length ?? 0) > 0;
}

export function FieldEditor(props: EditorProps) {
  const { field } = props;
  switch (field.kind) {
    case "boolean":
      return <BooleanEditor {...props} />;
    case "text":
      return <TextEditor {...props} field={field} />;
    case "number":
      return <NumberEditor {...props} field={field} />;
    case "select":
      return <SelectEditor {...props} field={field} />;
    case "multi_select":
      return <MultiSelectEditor {...props} field={field} />;
    case "list":
      return <ListEditor {...props} field={field} />;
    case "object":
      return field.widget === "weekly_hours" ? (
        <WeeklyHoursEditor {...props} field={field} />
      ) : (
        <ObjectEditor {...props} field={field} />
      );
    case "nullable":
      return <NullableEditor {...props} field={field} />;
  }
}

function BooleanEditor({ value, onChange, label, disabled, path, problems }: EditorProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-slate-800">
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={label}
        />
        {value === true ? "On" : "Off"}
      </label>
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function TextEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: Extract<AnyField, { kind: "text" }> }) {
  const id = useId();
  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    value: text,
    disabled,
    "aria-label": label,
    "aria-invalid": invalid(problems, path) || undefined,
    maxLength: field.maxLength,
    placeholder: field.placeholder ?? undefined,
  };
  return (
    <div>
      {field.multiline ? (
        <Textarea {...common} rows={4} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <>
          <Input
            {...common}
            type={INPUT_TYPES[field.format] ?? "text"}
            className={field.format === "color" ? "h-10 w-20 p-1" : undefined}
            list={field.suggestions.length > 0 ? `${id}-suggestions` : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
          {field.suggestions.length > 0 && (
            <datalist id={`${id}-suggestions`}>
              {field.suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          )}
        </>
      )}
      {field.variables !== null && field.variables.length > 0 && (
        <p className="mt-1 text-xs text-slate-500">
          Placeholders: {field.variables.map((name) => `{{${name}}}`).join(", ")}
        </p>
      )}
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function NumberEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: Extract<AnyField, { kind: "number" }> }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode={field.integer ? "numeric" : "decimal"}
          className="w-36"
          min={field.min}
          max={field.max}
          step={field.step ?? "any"}
          value={typeof value === "number" && Number.isFinite(value) ? value : ""}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid(problems, path) || undefined}
          onChange={(event) =>
            onChange(event.target.value === "" ? null : Number(event.target.value))
          }
        />
        {field.unit !== null && <span className="text-sm text-slate-600">{field.unit}</span>}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {field.min} to {field.max}
      </p>
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function SelectEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: Extract<AnyField, { kind: "select" }> }) {
  const name = useId();
  const described = field.options.some((option) => option.description !== undefined);
  if (described && field.options.length <= 6) {
    return (
      <fieldset>
        <legend className="sr-only">{label}</legend>
        <div className="space-y-2">
          {field.options.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm",
                value === option.value ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white",
              )}
            >
              <input
                type="radio"
                name={name}
                className="mt-0.5 accent-blue-700"
                checked={value === option.value}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
              <span>
                <span className="font-medium text-slate-900">{option.label}</span>
                {option.description !== undefined && (
                  <span className="block text-slate-600">{option.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        <ProblemText problems={problems} path={path} />
      </fieldset>
    );
  }
  const selected = field.options.find((option) => option.value === value);
  return (
    <div>
      <Select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className="sm:max-w-md"
      >
        {selected === undefined && <option value="">Choose…</option>}
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {selected?.description !== undefined && (
        <p className="mt-1 text-xs text-slate-600">{selected.description}</p>
      )}
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function MultiSelectEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: Extract<AnyField, { kind: "multi_select" }> }) {
  const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
  const toggle = (option: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(option);
    else next.delete(option);
    // Keep the options' order, as the schema stores it.
    onChange(field.options.map((candidate) => candidate.value).filter((item) => next.has(item)));
  };
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {field.options.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm text-slate-800">
            <Checkbox
              className="mt-0.5"
              checked={chosen.has(option.value)}
              disabled={disabled}
              onChange={(event) => toggle(option.value, event.target.checked)}
            />
            <span>
              {option.label}
              {option.description !== undefined && (
                <span className="block text-xs text-slate-500">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <ProblemText problems={problems} path={path} />
    </fieldset>
  );
}

function ListEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: ListField }) {
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const simple =
    field.item.kind === "text" || field.item.kind === "select" || field.item.kind === "number";
  const set = (index: number, item: unknown) =>
    onChange(items.map((current, position) => (position === index ? item : current)));
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div>
      {items.length === 0 && <p className="text-sm text-slate-500">No {field.itemLabel}s yet.</p>}
      <ol className={cn("space-y-2", items.length > 0 && "mb-2")}>
        {items.map((item, index) => (
          <li
            key={index}
            className={cn(
              simple
                ? "flex items-start gap-2"
                : "rounded-lg border border-slate-200 bg-slate-50/60 p-3",
            )}
          >
            <div className={cn(simple && "min-w-0 flex-1")}>
              {!simple && (
                <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  {field.itemLabel} {index + 1}
                </p>
              )}
              <FieldEditor
                field={field.item}
                value={item}
                onChange={(next) => set(index, next)}
                label={`${label}: ${field.itemLabel} ${index + 1}`}
                path={[...path, index]}
                problems={problems}
                disabled={disabled}
              />
            </div>
            <div className={cn("flex gap-1", !simple && "mt-2")}>
              {items.length > 1 && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled === true || index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${field.itemLabel} ${index + 1} up`}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled === true || index === items.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${field.itemLabel} ${index + 1} down`}
                  >
                    ↓
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, position) => position !== index))}
                aria-label={`Remove ${field.itemLabel} ${index + 1}`}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {items.length < field.maxItems && (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...items, blankValue(field.item)])}
        >
          Add {field.itemLabel}
        </Button>
      )}
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function ObjectEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: ObjectField<unknown> }) {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field.properties.map((property) => {
        const wide =
          property.field.kind === "list" ||
          property.field.kind === "object" ||
          property.field.kind === "multi_select" ||
          (property.field.kind === "text" && property.field.multiline);
        return (
          <div key={property.name} className={cn(wide && "sm:col-span-2")}>
            <p className="mb-1 text-sm font-medium text-slate-800">{property.label}</p>
            {property.help !== null && (
              <p className="mb-1 text-xs text-slate-500">{property.help}</p>
            )}
            <FieldEditor
              field={property.field}
              value={record[property.name]}
              onChange={(next) => onChange({ ...record, [property.name]: next })}
              label={`${label}: ${property.label}`}
              path={[...path, property.name]}
              problems={problems}
              disabled={disabled}
            />
          </div>
        );
      })}
      <div className="sm:col-span-2">
        <ProblemText problems={problems} path={path} />
      </div>
    </div>
  );
}

const DAY_LABELS: Readonly<Record<string, string>> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** Opening hours as a week: one row per day, closed or one or more open intervals. */
function WeeklyHoursEditor({
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: ObjectField<unknown> }) {
  const week =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const intervalsOf = (day: string) =>
    Array.isArray(week[day]) ? (week[day] as { open: string; close: string }[]) : [];
  const setDay = (day: string, intervals: { open: string; close: string }[]) =>
    onChange({ ...week, [day]: intervals });
  return (
    <div className="space-y-2">
      {WEEKDAYS.map((day) => {
        const intervals = intervalsOf(day);
        const open = intervals.length > 0;
        return (
          <div
            key={day}
            className="flex flex-col gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 sm:flex-row sm:items-center"
          >
            <label className="flex w-36 items-center gap-2 text-sm font-medium text-slate-800">
              <Checkbox
                checked={open}
                disabled={disabled}
                aria-label={`${label}: open on ${DAY_LABELS[day]}`}
                onChange={(event) =>
                  setDay(day, event.target.checked ? [{ open: "08:00", close: "17:00" }] : [])
                }
              />
              {DAY_LABELS[day]}
            </label>
            {open ? (
              <div className="flex flex-1 flex-col gap-1.5">
                {intervals.map((interval, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <Input
                      type="time"
                      className="w-32"
                      value={interval.open}
                      disabled={disabled}
                      aria-label={`${DAY_LABELS[day]} opens`}
                      onChange={(event) =>
                        setDay(
                          day,
                          intervals.map((item, position) =>
                            position === index ? { ...item, open: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <span className="text-sm text-slate-500">to</span>
                    <Input
                      type="time"
                      className="w-32"
                      value={interval.close}
                      disabled={disabled}
                      aria-label={`${DAY_LABELS[day]} closes`}
                      onChange={(event) =>
                        setDay(
                          day,
                          intervals.map((item, position) =>
                            position === index ? { ...item, close: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    {intervals.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          setDay(
                            day,
                            intervals.filter((_, position) => position !== index),
                          )
                        }
                      >
                        Remove
                      </Button>
                    )}
                    <ProblemText problems={problems} path={[...path, day, index, "close"]} />
                    <ProblemText problems={problems} path={[...path, day, index, "open"]} />
                  </div>
                ))}
                {intervals.length < 4 && (
                  <Button
                    size="sm"
                    variant="link"
                    className="self-start"
                    disabled={disabled}
                    onClick={() => setDay(day, [...intervals, { open: "13:00", close: "17:00" }])}
                  >
                    Add a break or second interval
                  </Button>
                )}
              </div>
            ) : (
              <span className="text-sm text-slate-500">Closed</span>
            )}
          </div>
        );
      })}
      <ProblemText problems={problems} path={path} />
    </div>
  );
}

function NullableEditor({
  field,
  value,
  onChange,
  label,
  disabled,
  path,
  problems,
}: EditorProps & { readonly field: Extract<AnyField, { kind: "nullable" }> }) {
  const id = useId();
  const isNull = value === null || value === undefined;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-slate-800">
        <Checkbox
          id={id}
          checked={isNull}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? null : blankValue(field.inner))}
        />
        {field.nullLabel}
      </label>
      {!isNull && (
        <FieldEditor
          field={field.inner}
          value={value}
          onChange={onChange}
          label={label}
          path={path}
          problems={problems}
          disabled={disabled}
        />
      )}
    </div>
  );
}
