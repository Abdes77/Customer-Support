"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { KNOWLEDGE_CATEGORIES } from "@repo/core";

import {
  importCsvAction,
  type ImportOutcome,
  previewCsvAction,
} from "@/app/(admin)/_actions/knowledge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/form";

import { CATEGORY_LABELS } from "./categories";

/*
 * The import of the agency's lead-generation data for one business: pick a CSV file, check
 * how its columns are read (the suggestion comes from the column names), correct the
 * mapping, import. The file is read in the browser and sent as text; cells are shown as
 * text only.
 */

type Target =
  | { to: "ignore" }
  | { to: "external_ref" }
  | { to: "profile"; field: string }
  | { to: "fact"; category: string; title?: string; split?: string }
  | { to: "fact_category" }
  | { to: "fact_title" }
  | { to: "fact_content" };

interface Preview {
  readonly ok: boolean;
  readonly fileProblem: string | null;
  readonly headers: readonly string[];
  readonly suggestedMapping: Readonly<Record<string, Target>>;
  readonly rowCount: number;
  readonly sample: readonly (readonly string[])[];
  readonly mappingProblems: readonly { column: string | null; message: string }[];
  readonly recordCount: number;
  readonly problems: readonly { row: number | null; column: string | null; message: string }[];
}

const PROFILE_LABELS: Readonly<Record<string, string>> = {
  name: "Business name",
  website_url: "Website",
  phone: "Phone",
  email: "Email",
  address_line1: "Street address",
  address_line2: "Address line 2",
  city: "City",
  state: "State",
  postal_code: "ZIP code",
  timezone: "Time zone",
};

function encode(target: Target): string {
  switch (target.to) {
    case "profile":
      return `profile:${target.field}`;
    case "fact":
      return `fact:${target.category}${target.split === undefined ? "" : `:${encodeURIComponent(target.split)}`}`;
    default:
      return target.to;
  }
}

function decode(value: string): Target {
  if (value.startsWith("profile:")) return { to: "profile", field: value.slice(8) };
  if (value.startsWith("fact:")) {
    const [, category = "other", split] = value.split(":");
    return split === undefined
      ? { to: "fact", category }
      : { to: "fact", category, split: decodeURIComponent(split) };
  }
  return {
    to: value as "ignore" | "external_ref" | "fact_category" | "fact_title" | "fact_content",
  };
}

const STAT_LABELS: readonly [string, string][] = [
  ["factsCreated", "facts added"],
  ["factsUpdated", "facts updated"],
  ["factsUnchanged", "unchanged"],
  ["factsKept", "kept because a person edited them"],
  ["factsArchived", "archived"],
  ["profileFieldsSet", "profile fields filled in"],
  ["recordsFailed", "rows with problems"],
];

export function CsvImport({ businessId }: { readonly businessId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, Target>>({});
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const runPreview = (text: string, next?: Record<string, Target>) => {
    setError(null);
    startTransition(async () => {
      const result = await previewCsvAction({
        businessId,
        csv: text,
        ...(next === undefined ? {} : { mapping: next }),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const value = result.value as unknown as Preview;
      setPreview(value);
      if (next === undefined) setMapping({ ...value.suggestedMapping });
    });
  };

  const onFile = async (selected: File | undefined) => {
    setOutcome(null);
    setPreview(null);
    if (selected === undefined) {
      setFile(null);
      return;
    }
    if (selected.size > 3_500_000) {
      setError("The file is too large for an upload here (3.5 MB at most).");
      return;
    }
    const text = await selected.text();
    setFile({ name: selected.name.slice(0, 200), text });
    runPreview(text);
  };

  const changeColumn = (column: string, value: string) => {
    if (file === null) return;
    const next = { ...mapping, [column]: decode(value) };
    setMapping(next);
    runPreview(file.text, next);
  };

  const runImport = () => {
    if (file === null) return;
    setError(null);
    startTransition(async () => {
      const result = await importCsvAction({
        businessId,
        csv: file.text,
        fileName: file.name,
        mapping,
        mode,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(result.value);
      setPreview(null);
      setFile(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`csv-${businessId}`} className="block text-sm font-medium text-slate-800">
          CSV file from your lead-generation data
        </label>
        <input
          id={`csv-${businessId}`}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-slate-50"
          onChange={(event) => void onFile(event.target.files?.[0])}
          disabled={pending}
        />
        <p className="mt-1 text-xs text-slate-500">
          One row per fact (category, title, text columns), or one row for the business with a
          column per kind of fact.
        </p>
      </div>

      {error !== null && <Callout tone="danger">{error}</Callout>}
      {pending && (
        <p className="text-sm text-slate-600" role="status">
          Reading…
        </p>
      )}

      {preview?.fileProblem != null && (
        <Callout tone="danger" title="This file cannot be read">
          {preview.fileProblem}
        </Callout>
      )}

      {preview !== null && preview.fileProblem === null && (
        <div className="space-y-4" data-testid="csv-preview">
          <p className="text-sm text-slate-700">
            {preview.rowCount} {preview.rowCount === 1 ? "row" : "rows"} in{" "}
            <span className="font-medium">{file?.name}</span>. Check what each column means:
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Column
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Read as
                  </th>
                  <th scope="col" className="px-3 py-2">
                    First value
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.headers.map((header, index) => (
                  <tr key={`${header}-${index}`}>
                    <td className="px-3 py-2 font-medium break-words text-slate-900">{header}</td>
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`Column ${header}`}
                        value={encode(mapping[header] ?? { to: "ignore" })}
                        onChange={(event) => changeColumn(header, event.target.value)}
                        disabled={pending}
                        className="min-w-48"
                      >
                        <option value="ignore">Do not import</option>
                        <optgroup label="Business profile">
                          {Object.entries(PROFILE_LABELS).map(([field, label]) => (
                            <option key={field} value={`profile:${field}`}>
                              {label}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="A fact of this kind">
                          {KNOWLEDGE_CATEGORIES.map((category) => (
                            <option key={category} value={`fact:${category}`}>
                              {CATEGORY_LABELS[category]}
                            </option>
                          ))}
                          {(() => {
                            const current = mapping[header];
                            return current?.to === "fact" && current.split !== undefined ? (
                              <option value={encode(current)}>
                                {CATEGORY_LABELS[
                                  current.category as keyof typeof CATEGORY_LABELS
                                ] ?? current.category}{" "}
                                (one fact per item)
                              </option>
                            ) : null;
                          })()}
                        </optgroup>
                        <optgroup label="One fact per row">
                          <option value="fact_category">Fact category</option>
                          <option value="fact_title">Fact title</option>
                          <option value="fact_content">Fact text</option>
                        </optgroup>
                        <option value="external_ref">Business reference</option>
                      </Select>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-slate-600">
                      {preview.sample[0]?.[index] ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.mappingProblems.length > 0 && (
            <Callout tone="warning" title="The mapping needs a fix">
              <ul className="list-disc pl-5">
                {preview.mappingProblems.map((problem, index) => (
                  <li key={index}>
                    {problem.column === null ? "" : `${problem.column}: `}
                    {problem.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {preview.problems.length > 0 && (
            <Callout
              tone="warning"
              title={`${preview.problems.length} ${preview.problems.length === 1 ? "row has problems and is" : "rows have problems and are"} skipped`}
            >
              <ul className="list-disc pl-5">
                {preview.problems.slice(0, 10).map((problem, index) => (
                  <li key={index}>
                    {problem.row === null ? "" : `Row ${problem.row}`}
                    {problem.column === null ? "" : `, ${problem.column}`}: {problem.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-slate-800">Facts already imported</legend>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="mode"
                className="accent-blue-700"
                checked={mode === "merge"}
                onChange={() => setMode("merge")}
              />
              Keep them, add and update from this file
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="mode"
                className="accent-blue-700"
                checked={mode === "replace"}
                onChange={() => setMode("replace")}
              />
              Archive imported facts this file no longer has
            </label>
          </fieldset>

          <Button onClick={runImport} disabled={pending || !preview.ok}>
            Import{" "}
            {preview.recordCount > 0
              ? `${preview.recordCount} ${preview.recordCount === 1 ? "record" : "records"}`
              : ""}
          </Button>
        </div>
      )}

      {outcome !== null && (
        <Callout
          tone={
            outcome.status === "succeeded"
              ? "success"
              : outcome.status === "failed"
                ? "danger"
                : "warning"
          }
          title={outcome.status === "failed" ? "The import failed" : "Imported"}
          testId="import-outcome"
        >
          <p>
            {STAT_LABELS.filter(([key]) => (outcome.stats[key] ?? 0) > 0)
              .map(([key, label]) => `${outcome.stats[key]} ${label}`)
              .join(", ") || "Nothing changed."}
          </p>
          {outcome.problems.slice(0, 5).map((problem, index) => (
            <p key={index}>
              {problem.row === null ? "" : `Row ${problem.row}: `}
              {problem.message}
            </p>
          ))}
        </Callout>
      )}
    </div>
  );
}
