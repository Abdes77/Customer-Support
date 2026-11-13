"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  blankValue,
  findSetting,
  SETTING_CATEGORIES,
  type SettingDefinition,
} from "@repo/settings";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Checkbox, Input } from "@/components/ui/form";
import type { ActionResult, FieldProblemView } from "@/server/admin/result";
import type { ScreenTarget } from "@/server/admin/settings-actions";
import type { SettingEntryView, SettingsScreenView } from "@/server/admin/settings-view";

import { FieldEditor, pathKey, type ProblemMap } from "./field-editor";
import { describePath, sourceLabel, summarizeValue } from "./format";

/*
 * The settings screen (C15), for any scope: the agency, a segment or a business. Every
 * setting in the view is drawn from its registry declaration (`findSetting(key)`): label,
 * help, category, group and the field the control is built from. Nothing here names a
 * setting, so a setting added to the registry shows up on this screen as it is.
 */

type Result = ActionResult<unknown>;

export interface SettingsActions {
  readonly save: (input: {
    target: ScreenTarget;
    key: string;
    value: unknown;
    expectedVersion: number | null;
  }) => Promise<Result>;
  readonly reset: (input: {
    target: ScreenTarget;
    key: string;
    expectedVersion: number | null;
  }) => Promise<Result>;
  readonly addEntry: (input: {
    target: ScreenTarget;
    key: string;
    entry: unknown;
    expectedVersion: number | null;
  }) => Promise<Result>;
  readonly removeEntry: (input: {
    target: ScreenTarget;
    key: string;
    index: number;
    expectedVersion: number | null;
  }) => Promise<Result>;
  /** Alert contacts only: sends a test alert to one entry of a contact list. */
  readonly testEntry?: (input: {
    target: ScreenTarget;
    key: string;
    index: number;
  }) => Promise<ActionResult<string>>;
}

interface Props {
  readonly view: SettingsScreenView;
  readonly target: ScreenTarget;
  readonly actions: SettingsActions;
  /** Show only these settings, in this order, without the category navigation. */
  readonly onlyKeys?: readonly string[];
  readonly initialCategory?: string;
}

function toProblemMap(problems: readonly FieldProblemView[]): ProblemMap {
  const map = new Map<string, string[]>();
  for (const problem of problems) {
    const key = pathKey(problem.path);
    map.set(key, [...(map.get(key) ?? []), problem.message]);
  }
  return map;
}

/** The field's own schema, as the server will run it; problems keyed by path. */
function check(definition: SettingDefinition, value: unknown): FieldProblemView[] {
  const result = definition.schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    ),
    message: issue.message,
  }));
}

export function SettingsScreen({ view, target, actions, onlyKeys, initialCategory }: Props) {
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);

  const rows = useMemo(() => {
    const byKey = new Map(view.entries.map((entry) => [entry.key, entry]));
    const keys = onlyKeys ?? view.entries.map((entry) => entry.key);
    return keys.flatMap((key) => {
      const entry = byKey.get(key);
      const definition = findSetting(key);
      return entry === undefined || definition === undefined ? [] : [{ entry, definition }];
    });
  }, [view.entries, onlyKeys]);

  const categories = useMemo(
    () =>
      SETTING_CATEGORIES.map((category) => ({
        ...category,
        count: rows.filter((row) => row.definition.category === category.id).length,
        changed: rows.filter(
          (row) => row.definition.category === category.id && row.entry.override !== null,
        ).length,
      })).filter((category) => category.count > 0),
    [rows],
  );
  const [category, setCategory] = useState(
    categories.find((candidate) => candidate.id === initialCategory)?.id ?? categories[0]?.id ?? "",
  );

  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    ({ entry, definition }) =>
      (onlyKeys !== undefined || needle !== "" || definition.category === category) &&
      (!changedOnly || entry.override !== null) &&
      (needle === "" ||
        definition.label.toLowerCase().includes(needle) ||
        definition.help.toLowerCase().includes(needle) ||
        definition.key.toLowerCase().includes(needle)),
  );

  const groups: { name: string | null; rows: typeof visible }[] = [];
  for (const row of visible) {
    const name =
      needle !== "" && onlyKeys === undefined
        ? (SETTING_CATEGORIES.find((candidate) => candidate.id === row.definition.category)
            ?.label ?? null)
        : row.definition.group;
    const last = groups.at(-1);
    if (last?.name === name && last !== undefined) last.rows.push(row);
    else groups.push({ name, rows: [row] });
  }

  const list = (
    <div className="min-w-0 flex-1 space-y-6">
      {groups.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
          No setting matches.
        </p>
      )}
      {groups.map((group, index) => (
        <section key={`${group.name ?? "none"}-${index}`} aria-label={group.name ?? undefined}>
          {group.name !== null && (
            <h3 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
              {group.name}
            </h3>
          )}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
            {group.rows.map(({ entry, definition }) => (
              <li key={entry.key}>
                <SettingRow
                  entry={entry}
                  definition={definition}
                  scope={view.scope}
                  target={target}
                  actions={actions}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );

  if (onlyKeys !== undefined) return list;

  const current = categories.find((candidate) => candidate.id === category);
  return (
    <div>
      {view.issueCount > 0 && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          {view.issueCount === 1 ? "One stored value is" : `${view.issueCount} stored values are`}{" "}
          invalid and ignored; the value below it applies. They are marked on their settings.
        </p>
      )}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex-1">
          <label htmlFor="settings-search" className="sr-only">
            Search settings
          </label>
          <Input
            id="settings-search"
            type="search"
            placeholder="Search all settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <Checkbox
            checked={changedOnly}
            onChange={(event) => setChangedOnly(event.target.checked)}
          />
          Only settings changed here
        </label>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav
          aria-label="Setting categories"
          className={cn("lg:sticky lg:top-6 lg:w-60 lg:shrink-0", needle !== "" && "opacity-60")}
        >
          <label htmlFor="settings-category" className="sr-only">
            Category
          </label>
          <select
            id="settings-category"
            className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base lg:hidden"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {categories.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} ({candidate.count})
              </option>
            ))}
          </select>
          <ul className="hidden flex-col gap-0.5 lg:flex">
            {categories.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-current={candidate.id === category ? "true" : undefined}
                  onClick={() => {
                    setCategory(candidate.id);
                    setQuery("");
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm",
                    candidate.id === category
                      ? "bg-blue-50 font-medium text-blue-800"
                      : "text-slate-700 hover:bg-slate-100",
                  )}
                >
                  <span className="truncate">{candidate.label}</span>
                  {candidate.changed > 0 && (
                    <span className="rounded-full bg-blue-100 px-1.5 text-xs text-blue-800">
                      {candidate.changed}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          {needle === "" && current !== undefined && (
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-slate-900">{current.label}</h2>
              <p className="text-sm text-slate-600">{current.description}</p>
            </div>
          )}
          {list}
        </div>
      </div>
    </div>
  );
}

type Mode = { kind: "view" } | { kind: "edit"; value: unknown } | { kind: "add"; value: unknown };

function SettingRow({
  entry,
  definition,
  scope,
  target,
  actions,
}: {
  readonly entry: SettingEntryView;
  readonly definition: SettingDefinition;
  readonly scope: SettingsScreenView["scope"];
  readonly target: ScreenTarget;
  readonly actions: SettingsActions;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [problems, setProblems] = useState<readonly FieldProblemView[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const expectedVersion = entry.override?.version ?? null;
  const field = definition.field;
  const listItem = field.kind === "list" ? field.item : null;
  const id = `setting-${entry.key.replaceAll(".", "-")}`;

  const run = (action: () => Promise<Result | ActionResult<string>>, done: string) => {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMode({ kind: "view" });
        setProblems([]);
        setMessage({ tone: "ok", text: typeof result.value === "string" ? result.value : done });
        router.refresh();
      } else {
        setProblems(result.problems ?? []);
        setMessage({ tone: "error", text: result.error });
      }
    });
  };

  const save = () => {
    if (mode.kind === "view") return;
    const checkAgainst =
      mode.kind === "add" && field.kind === "list"
        ? { ...definition, schema: field.item.schema }
        : definition;
    const found = check(checkAgainst, mode.value);
    if (found.length > 0) {
      setProblems(found);
      setMessage({ tone: "error", text: "Fix the marked values first." });
      return;
    }
    if (mode.kind === "add") {
      run(
        () => actions.addEntry({ target, key: entry.key, entry: mode.value, expectedVersion }),
        "Added.",
      );
    } else {
      run(
        () => actions.save({ target, key: entry.key, value: mode.value, expectedVersion }),
        "Saved.",
      );
    }
  };

  const problemMap = toProblemMap(problems);
  const editorField = mode.kind === "add" && listItem !== null ? listItem : field;
  const strayProblems = problems.filter((problem) => problem.path.length > 0);

  return (
    <div className="px-4 py-4 sm:px-5" data-setting-key={entry.key} id={id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-slate-900">{definition.label}</h4>
          <p className="mt-0.5 text-sm text-slate-600">{definition.help}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Badge tone={entry.source === scope ? "blue" : "neutral"}>
            {sourceLabel(entry.source, scope)}
          </Badge>
          {definition.sensitive && <Badge tone="violet">Private</Badge>}
        </div>
      </div>

      {mode.kind === "view" && (
        <div className="mt-2">
          {entry.sensitive ? (
            <SensitiveValue
              entry={entry}
              disabled={pending || !entry.editable}
              onRemove={(index) =>
                run(
                  () => actions.removeEntry({ target, key: entry.key, index, expectedVersion }),
                  "Removed.",
                )
              }
              onTest={
                actions.testEntry === undefined
                  ? undefined
                  : (index) => {
                      const testEntry = actions.testEntry;
                      if (testEntry !== undefined) {
                        run(() => testEntry({ target, key: entry.key, index }), "Test sent.");
                      }
                    }
              }
            />
          ) : (
            <p className="text-sm break-words text-slate-900" data-testid="setting-value">
              {summarizeValue(field, entry.value)}
            </p>
          )}
          {entry.override !== null && entry.source === scope && (
            <p className="mt-1 text-xs text-slate-500">
              Without this override:{" "}
              {entry.sensitive
                ? entry.inherited.summary
                : summarizeValue(field, entry.inherited.value)}{" "}
              ({sourceLabel(entry.inherited.source, scope).toLowerCase()})
            </p>
          )}
          {entry.override !== null && !entry.override.inForce && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-950">
              The value stored here is invalid and ignored
              {entry.override.problem === null ? "." : `: ${entry.override.problem}`}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {entry.editable && !entry.sensitive && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setMessage(null);
                  setProblems([]);
                  setMode({ kind: "edit", value: structuredClone(entry.value) });
                }}
              >
                {entry.source === scope ? "Change" : "Override"}
              </Button>
            )}
            {entry.editable && entry.sensitive && listItem !== null && (
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  pending ||
                  (entry.entries?.length ?? 0) >= (field.kind === "list" ? field.maxItems : 0)
                }
                onClick={() => {
                  setMessage(null);
                  setProblems([]);
                  setMode({ kind: "add", value: blankValue(listItem) });
                }}
              >
                Add {field.kind === "list" ? field.itemLabel : "entry"}
              </Button>
            )}
            {entry.editable && entry.sensitive && listItem === null && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode({ kind: "edit", value: blankValue(field) })}
              >
                Replace value
              </Button>
            )}
            {entry.resettable && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(
                    () => actions.reset({ target, key: entry.key, expectedVersion }),
                    "Reset: the inherited value applies again.",
                  )
                }
              >
                Reset to inherited
              </Button>
            )}
            {!entry.editable && entry.denial !== null && (
              <span className="text-xs text-slate-500">{entry.denial}</span>
            )}
          </div>
        </div>
      )}

      {mode.kind !== "view" && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
          {entry.sensitive && mode.kind === "edit" && (
            <p className="mb-2 text-xs text-slate-600">
              This value is private, so the current one is not shown. What you enter replaces it.
            </p>
          )}
          <FieldEditor
            field={editorField}
            value={mode.value}
            onChange={(value) => setMode({ ...mode, value })}
            label={definition.label}
            path={[]}
            problems={problemMap}
            disabled={pending}
          />
          {strayProblems.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-red-700">
              {strayProblems.map((problem) => (
                <li key={`${pathKey(problem.path)}:${problem.message}`}>
                  {describePath(editorField, problem.path)}: {problem.message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : mode.kind === "add" ? "Add" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setMode({ kind: "view" });
                setProblems([]);
                setMessage(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message !== null && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={cn(
            "mt-2 text-sm",
            message.tone === "error" ? "font-medium text-red-700" : "text-emerald-700",
          )}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function SensitiveValue({
  entry,
  disabled,
  onRemove,
  onTest,
}: {
  readonly entry: SettingEntryView;
  readonly disabled: boolean;
  readonly onRemove: (index: number) => void;
  readonly onTest: ((index: number) => void) | undefined;
}) {
  if (entry.entries === null || entry.entries.length === 0) {
    return (
      <p className="text-sm text-slate-900" data-testid="setting-value">
        {entry.summary}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="setting-entries">
      {entry.entries.map((item, index) => (
        <li
          key={index}
          className="flex flex-col gap-2 rounded-md border border-slate-200 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{item.label}</p>
            {item.details.length > 0 && (
              <p className="truncate text-xs text-slate-600">{item.details.join(" · ")}</p>
            )}
          </div>
          <div className="flex gap-1">
            {onTest !== undefined && (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onTest(index)}>
                Send test
              </Button>
            )}
            {!disabled && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${item.label}`}
              >
                Remove
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
