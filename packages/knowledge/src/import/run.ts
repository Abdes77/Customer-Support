import { z } from "zod";

import { type AgencyId, BusinessId } from "@repo/core";
import type { AuditActor } from "@repo/db";

import {
  applyImport,
  type ImportContext,
  type ImportMode,
  type ImportResult,
  type ProfileMode,
  recordFailedImport,
} from "./apply";
import { type CsvDelimiter, parseCsv } from "./csv";
import { ColumnMapping, mappingProblems, suggestMapping } from "./mapping";
import {
  csvToRecords,
  IMPORT_LIMITS,
  ImportFact,
  type ImportProblem,
  ImportProfile,
  type ImportRecord,
} from "./records";

/**
 * The two ways lead-generation data comes in: a CSV file (uploaded in the admin panel or
 * posted to the API) and JSON records (the API). Both end in `applyImport`.
 */

export interface CsvPreview {
  readonly ok: boolean;
  /** Set when the file itself cannot be read. */
  readonly fileProblem: string | null;
  readonly delimiter: CsvDelimiter | null;
  readonly headers: readonly string[];
  /** The mapping guessed from the column names, for the person to correct. */
  readonly suggestedMapping: ColumnMapping;
  readonly rowCount: number;
  /** The first rows, as read. */
  readonly sample: readonly (readonly string[])[];
  /** What is wrong with the mapping in use (the given one, or the suggested one). */
  readonly mappingProblems: readonly { readonly column: string | null; readonly message: string }[];
  /** Rows that would import and rows with problems under that mapping. */
  readonly recordCount: number;
  readonly problems: readonly ImportProblem[];
}

/**
 * Reads a file and says what an import of it would do, without touching the database. The
 * mapping screen of the onboarding wizard is drawn from this.
 */
export function previewCsv(
  csv: string,
  options: { readonly mapping?: ColumnMapping; readonly agencyWide?: boolean } = {},
): CsvPreview {
  const parsed = parseCsv(csv);
  if (!parsed.ok) {
    return {
      ok: false,
      fileProblem: parsed.message,
      delimiter: null,
      headers: [],
      suggestedMapping: {},
      rowCount: 0,
      sample: [],
      mappingProblems: [],
      recordCount: 0,
      problems: [],
    };
  }
  const suggestedMapping = suggestMapping(parsed.headers);
  const mapping = options.mapping ?? suggestedMapping;
  const wrong = mappingProblems(parsed.headers, mapping, {
    agencyWide: options.agencyWide ?? false,
  });
  const { records, problems } =
    wrong.length > 0 ? { records: [], problems: [] } : csvToRecords(parsed, mapping);
  return {
    ok: wrong.length === 0 && records.length > 0,
    fileProblem: null,
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    suggestedMapping,
    rowCount: parsed.rows.length,
    sample: parsed.rows.slice(0, 5).map((row) => row.cells),
    mappingProblems: wrong,
    recordCount: records.length,
    problems: problems.slice(0, 50),
  };
}

export interface CsvImportInput {
  readonly agencyId: AgencyId;
  /** The business the file is for, or null for a file that names a business in every row. */
  readonly businessId: BusinessId | null;
  readonly csv: string;
  readonly fileName?: string | null;
  /** Default: the mapping suggested from the column names. */
  readonly mapping?: ColumnMapping;
  readonly mode?: ImportMode;
  readonly profileMode?: ProfileMode;
  readonly actor?: AuditActor;
  readonly now: Date;
}

export interface CsvImportResult extends ImportResult {
  /** The mapping that was used. */
  readonly mapping: ColumnMapping;
}

/** Imports a CSV file. A file or a mapping that cannot be used is a failed run, not an error. */
export async function importCsv(
  ctx: ImportContext,
  input: CsvImportInput,
): Promise<CsvImportResult> {
  const base = {
    agencyId: input.agencyId,
    businessId: input.businessId,
    kind: "csv" as const,
    fileName: input.fileName ?? null,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    now: input.now,
  };
  const parsed = parseCsv(input.csv);
  if (!parsed.ok) {
    const failed = await recordFailedImport(ctx, {
      ...base,
      problems: [{ row: parsed.row, column: null, message: parsed.message }],
    });
    return { ...failed, mapping: input.mapping ?? {} };
  }
  const mapping = input.mapping ?? suggestMapping(parsed.headers);
  const wrong = mappingProblems(parsed.headers, mapping, {
    agencyWide: input.businessId === null,
  });
  if (wrong.length > 0) {
    const failed = await recordFailedImport(ctx, {
      ...base,
      problems: wrong.map((problem) => ({ row: null, ...problem })),
    });
    return { ...failed, mapping };
  }
  const { records, problems } = csvToRecords(parsed, mapping);
  const result = await applyImport(ctx, {
    ...base,
    records,
    problems,
    received: parsed.rows.length,
    mapping,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.profileMode === undefined ? {} : { profileMode: input.profileMode }),
  });
  return { ...result, mapping };
}

/** The body of `POST /api/v1/knowledge/import`. Each business is validated on its own. */
export const ApiImportRequest = z.strictObject({
  mode: z.enum(["merge", "replace"]).default("merge"),
  profileMode: z.enum(["fill_empty", "overwrite", "ignore"]).default("fill_empty"),
  businesses: z.array(z.unknown()).min(1).max(IMPORT_LIMITS.records),
});

const ApiBusiness = z.strictObject({
  /** The business's id here, or its reference in the agency's own data. */
  id: BusinessId.optional(),
  externalRef: z.string().trim().min(1).max(200).optional(),
  profile: ImportProfile.optional(),
  facts: z.array(ImportFact).max(IMPORT_LIMITS.factsPerRecord).default([]),
});

export interface ApiImportInput {
  readonly agencyId: AgencyId;
  /** The business the caller is limited to (a key bound to one business), or null. */
  readonly businessId: BusinessId | null;
  /** The parsed JSON body. Validated here. */
  readonly body: unknown;
  readonly actor?: AuditActor;
  readonly now: Date;
}

export type ApiImportOutcome =
  | { readonly ok: true; readonly result: ImportResult }
  /** The body as a whole is not an import request. Nothing was recorded. */
  | { readonly ok: false; readonly problems: readonly ImportProblem[] };

function pathText(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : `${out.length > 0 ? "." : ""}${String(part)}`;
  }
  return out;
}

/** Imports the records of an API request. Records with problems are reported, the rest import. */
export async function importApiRecords(
  ctx: ImportContext,
  input: ApiImportInput,
): Promise<ApiImportOutcome> {
  const request = ApiImportRequest.safeParse(input.body);
  if (!request.success) {
    return {
      ok: false,
      problems: request.error.issues.map((issue) => ({
        row: null,
        column: pathText(issue.path) || null,
        message: issue.message,
      })),
    };
  }
  const records: ImportRecord[] = [];
  const problems: ImportProblem[] = [];
  request.data.businesses.forEach((entry, index) => {
    const row = index + 1;
    const parsed = ApiBusiness.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({ row, column: pathText(issue.path) || null, message: issue.message });
      }
      return;
    }
    const business = parsed.data;
    if (
      input.businessId === null &&
      business.id === undefined &&
      business.externalRef === undefined
    ) {
      problems.push({
        row,
        column: null,
        message: 'The record needs "id" or "externalRef" to say which business it is for.',
      });
      return;
    }
    if (business.facts.length === 0 && Object.keys(business.profile ?? {}).length === 0) {
      problems.push({
        row,
        column: null,
        message: "The record has neither facts nor profile fields.",
      });
      return;
    }
    records.push({
      row,
      businessId: business.id ?? null,
      externalRef: business.externalRef ?? null,
      profile: business.profile ?? {},
      facts: business.facts,
    });
  });
  const result = await applyImport(ctx, {
    agencyId: input.agencyId,
    businessId: input.businessId,
    kind: "api",
    records,
    problems,
    received: request.data.businesses.length,
    mode: request.data.mode,
    profileMode: request.data.profileMode,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    now: input.now,
  });
  return { ok: true, result };
}

export { ColumnMapping };
