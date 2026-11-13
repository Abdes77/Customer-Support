"use client";

import type { PlaybookSection } from "@repo/core";

import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";

import { blankEntry, SECTION_FIELDS, URGENCY_LEVELS } from "./fields";

/** Edits one section of a playbook: a list of entries with the section's fields. */
export function SectionEditor({
  section,
  value,
  onChange,
  disabled,
}: {
  readonly section: PlaybookSection;
  readonly value: readonly unknown[];
  readonly onChange: (value: unknown[]) => void;
  readonly disabled?: boolean;
}) {
  const fields = SECTION_FIELDS[section];
  const set = (index: number, entry: unknown) =>
    onChange(value.map((current, position) => (position === index ? entry : current)));
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {value.map((entry, index) => (
        <div key={index} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          {fields === null ? (
            <Textarea
              rows={2}
              value={typeof entry === "string" ? entry : ""}
              maxLength={600}
              disabled={disabled}
              aria-label={`Entry ${index + 1}`}
              onChange={(event) => set(index, event.target.value)}
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((field) => {
                const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
                  string,
                  unknown
                >;
                const raw = record[field.name];
                const label = `${field.label} (entry ${index + 1})`;
                const update = (next: unknown) => set(index, { ...record, [field.name]: next });
                const wide = field.kind === "long" || field.kind === "nullable_long";
                return (
                  <label key={field.name} className={wide ? "sm:col-span-2" : undefined}>
                    <span className="mb-1 block text-xs font-medium text-slate-700">
                      {field.label}
                    </span>
                    {field.kind === "level" ? (
                      <Select
                        value={typeof raw === "string" ? raw : "routine"}
                        disabled={disabled}
                        aria-label={label}
                        onChange={(event) => update(event.target.value)}
                      >
                        {URGENCY_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    ) : field.kind === "number" ? (
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={typeof raw === "number" ? raw : ""}
                        disabled={disabled}
                        aria-label={label}
                        onChange={(event) =>
                          update(event.target.value === "" ? null : Number(event.target.value))
                        }
                      />
                    ) : wide ? (
                      <Textarea
                        rows={2}
                        maxLength={1200}
                        value={typeof raw === "string" ? raw : ""}
                        disabled={disabled}
                        aria-label={label}
                        onChange={(event) =>
                          update(
                            field.kind === "nullable_long" && event.target.value.trim() === ""
                              ? null
                              : event.target.value,
                          )
                        }
                      />
                    ) : (
                      <Input
                        type={field.kind === "url" ? "url" : "text"}
                        maxLength={field.kind === "url" ? 2000 : 200}
                        value={typeof raw === "string" ? raw : ""}
                        disabled={disabled}
                        aria-label={label}
                        onChange={(event) => update(event.target.value)}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          )}
          <div className="mt-2 flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled === true || index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Move entry ${index + 1} up`}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled === true || index === value.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move entry ${index + 1} down`}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      {value.length < 40 && (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...value, blankEntry(section)])}
        >
          Add an entry
        </Button>
      )}
    </div>
  );
}
