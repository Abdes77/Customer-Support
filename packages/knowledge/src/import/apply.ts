import type { AgencyId, BusinessId, KnowledgeCategory, UserId } from "@repo/core";
import {
  type AgencyContext,
  and,
  type AuditActor,
  type BusinessContext,
  businesses,
  count,
  eq,
  type ImportRunKind,
  importRuns,
  type ImportRunStatus,
  inArray,
  isNotNull,
  knowledgeItems,
  like,
  max,
  or,
  recordSystemAudit,
  recordUserAudit,
  type UserContext,
} from "@repo/db";

import { isHandEdited, MAX_ACTIVE_FACTS } from "../knowledge/items";
import { shortHash, slug } from "../knowledge/text";
import { PROFILE_PROPERTY } from "./records";
import type { ImportFact, ImportProblem, ImportProfile, ImportRecord } from "./records";

/**
 * Applying import records to the database, in the caller's transaction.
 *
 * - Facts are upserted by a stable key (`import:<category>:<title>`), so importing the same
 *   data again changes what changed and adds nothing twice.
 * - A fact a person edited by hand, or archived, is left as the person left it.
 * - "replace" mode also archives the imported facts of a business that the new data no
 *   longer contains; "merge" (the default) only adds and updates.
 * - Profile fields fill the gaps of the business's profile unless told to overwrite.
 * - Every import is one `import_runs` row with counters and the problems found, row by row.
 */

export type ImportContext = UserContext | BusinessContext | AgencyContext;

export type ImportMode = "merge" | "replace";
export type ProfileMode = "fill_empty" | "overwrite" | "ignore";

export interface ImportStats {
  /** Records (rows) received, including the ones with problems. */
  readonly records: number;
  readonly recordsImported: number;
  readonly recordsFailed: number;
  readonly businesses: number;
  readonly factsCreated: number;
  readonly factsUpdated: number;
  readonly factsUnchanged: number;
  /** Facts left alone because a person edited or archived them. */
  readonly factsKept: number;
  /** Facts archived by "replace" mode. */
  readonly factsArchived: number;
  readonly profileFieldsSet: number;
}

export interface ImportResult {
  readonly importRunId: string;
  readonly status: ImportRunStatus;
  readonly stats: ImportStats;
  /** At most `MAX_STORED_PROBLEMS`; `stats.recordsFailed` has the real number of rows. */
  readonly problems: readonly ImportProblem[];
}

export const MAX_STORED_PROBLEMS = 200;

/** The prefix of the keys of facts that came from CSV or API imports. */
export const IMPORT_KEY_PREFIX = "import:";

/** The stable key of an imported fact within its business. */
export function importKey(fact: Pick<ImportFact, "category" | "title" | "content">): string {
  const named = slug(fact.title);
  // A fact without a title is told apart by its text: a reworded one is a new fact.
  const name = named.length > 0 ? named : `text-${shortHash(fact.content)}`;
  return `${IMPORT_KEY_PREFIX}${fact.category}:${name}`;
}

export interface ApplyImportInput {
  readonly agencyId: AgencyId;
  readonly kind: Extract<ImportRunKind, "csv" | "api">;
  /** The one business the import is for, or null for an import that names its businesses. */
  readonly businessId: BusinessId | null;
  readonly records: readonly ImportRecord[];
  /** Problems found before this step (parsing, mapping). They are part of the run. */
  readonly problems?: readonly ImportProblem[];
  /** Records received, when some never became records (rows with problems). */
  readonly received?: number;
  readonly mode?: ImportMode;
  readonly profileMode?: ProfileMode;
  readonly fileName?: string | null;
  readonly mapping?: Record<string, unknown>;
  /** Who is recorded for the system scope. A signed-in user is recorded as themselves. */
  readonly actor?: AuditActor;
  readonly now: Date;
}

interface BusinessRow {
  readonly id: BusinessId;
  readonly externalRef: string | null;
  readonly profile: Readonly<Record<keyof ImportProfile, string | null>>;
}

const PROFILE_COLUMNS = {
  name: businesses.name,
  websiteUrl: businesses.websiteUrl,
  phone: businesses.phone,
  email: businesses.email,
  addressLine1: businesses.addressLine1,
  addressLine2: businesses.addressLine2,
  city: businesses.city,
  state: businesses.state,
  postalCode: businesses.postalCode,
  timezone: businesses.timezone,
} as const;

async function loadBusinesses(
  ctx: ImportContext,
  input: ApplyImportInput,
): Promise<Map<string, BusinessRow>> {
  const refs = [
    ...new Set(input.records.map((record) => record.externalRef).filter((ref) => ref !== null)),
  ];
  const ids = [
    ...new Set(
      input.records
        .map((record) => record.businessId ?? null)
        .filter((id): id is BusinessId => id !== null),
    ),
  ];
  const where =
    input.businessId !== null
      ? eq(businesses.id, input.businessId)
      : refs.length === 0 && ids.length === 0
        ? null
        : and(
            eq(businesses.agencyId, input.agencyId),
            or(
              refs.length === 0 ? undefined : inArray(businesses.externalRef, refs),
              ids.length === 0 ? undefined : inArray(businesses.id, ids),
            ),
          );
  if (where === null) return new Map();
  const rows = await ctx.tx
    .select({ id: businesses.id, externalRef: businesses.externalRef, ...PROFILE_COLUMNS })
    .from(businesses)
    .where(where);
  const found = new Map<string, BusinessRow>();
  for (const row of rows) {
    const { id, externalRef, ...profile } = row;
    const entry = { id, externalRef, profile };
    found.set(`id:${id}`, entry);
    if (externalRef !== null) found.set(`ref:${externalRef}`, entry);
  }
  return found;
}

function actorId(ctx: ImportContext, actor: AuditActor | undefined): UserId | null {
  if (ctx.kind === "user") return ctx.user.id;
  return actor?.type === "user" ? actor.userId : null;
}

interface Counters {
  recordsImported: number;
  recordsFailed: number;
  factsCreated: number;
  factsUpdated: number;
  factsUnchanged: number;
  factsKept: number;
  factsArchived: number;
  profileFieldsSet: number;
}

/**
 * Applies the records and writes the import run. Returns "failed" when nothing could be
 * imported, "partial" when some records had problems, "succeeded" otherwise. Throws only
 * for problems that are not about the data (the database, the tenant).
 */
export async function applyImport(
  ctx: ImportContext,
  input: ApplyImportInput,
): Promise<ImportResult> {
  const mode = input.mode ?? "merge";
  const profileMode = input.profileMode ?? "fill_empty";
  const problems: ImportProblem[] = [...(input.problems ?? [])];
  const counters: Counters = {
    recordsImported: 0,
    recordsFailed: 0,
    factsCreated: 0,
    factsUpdated: 0,
    factsUnchanged: 0,
    factsKept: 0,
    factsArchived: 0,
    profileFieldsSet: 0,
  };
  const editor = actorId(ctx, input.actor);
  const source = input.kind === "csv" ? "csv_import" : "api";

  const [run] = await ctx.tx
    .insert(importRuns)
    .values({
      agencyId: input.agencyId,
      businessId: input.businessId,
      kind: input.kind,
      status: "running",
      fileName: input.fileName?.slice(0, 255) ?? null,
      mapping: input.mapping ?? {},
      createdBy: editor,
      startedAt: input.now,
    })
    .returning({ id: importRuns.id });
  if (run === undefined) throw new Error("Insert into import_runs returned no row");

  // Which business each record is for.
  const known = await loadBusinesses(ctx, input);
  const perBusiness = new Map<BusinessId, { business: BusinessRow; records: ImportRecord[] }>();
  for (const record of input.records) {
    let business: BusinessRow | undefined;
    const recordId = record.businessId ?? null;
    if (input.businessId !== null) {
      business = known.get(`id:${input.businessId}`);
      const otherId = recordId !== null && recordId !== input.businessId;
      const ownRef = business?.externalRef ?? null;
      const otherRef =
        ownRef !== null && record.externalRef !== null && ownRef !== record.externalRef;
      if (otherId || (otherRef && recordId === null)) {
        problems.push({
          row: record.row,
          column: null,
          message: "This record is for another business than the one this import may write.",
        });
        counters.recordsFailed += 1;
        continue;
      }
    } else if (recordId !== null) {
      business = known.get(`id:${recordId}`);
    } else if (record.externalRef === null) {
      problems.push({
        row: record.row,
        column: null,
        message: "The row does not say which business it is for (no reference).",
      });
      counters.recordsFailed += 1;
      continue;
    } else {
      business = known.get(`ref:${record.externalRef}`);
    }
    if (business === undefined) {
      problems.push({
        row: record.row,
        column: null,
        message:
          input.businessId !== null
            ? "The business does not exist."
            : "No business has this reference. Create the business first, or set its reference in its profile.",
      });
      counters.recordsFailed += 1;
      continue;
    }
    const entry = perBusiness.get(business.id) ?? { business, records: [] };
    entry.records.push(record);
    perBusiness.set(business.id, entry);
  }

  for (const { business, records } of perBusiness.values()) {
    const tenant = { agencyId: input.agencyId, businessId: business.id };

    // Facts of this business in this import, by key. A key that appears twice keeps its
    // first fact; the row of the second is reported.
    const incoming = new Map<string, { fact: ImportFact; row: number }>();
    const failedRows = new Set<number>();
    for (const record of records) {
      for (const fact of record.facts) {
        const key = importKey(fact);
        const first = incoming.get(key);
        if (first === undefined) {
          incoming.set(key, { fact, row: record.row });
          continue;
        }
        if (first.fact.content === fact.content) continue;
        problems.push({
          row: record.row,
          column: null,
          message: `This row has a fact with the same category and title as row ${first.row} but a different text. Only the first was imported.`,
        });
        failedRows.add(record.row);
      }
    }

    const keys = [...incoming.keys()];
    const existing =
      keys.length === 0
        ? []
        : await ctx.tx
            .select()
            .from(knowledgeItems)
            .where(
              and(
                eq(knowledgeItems.businessId, business.id),
                inArray(knowledgeItems.importKey, keys),
              ),
            );
    const byKey = new Map(existing.map((row) => [row.importKey ?? "", row]));

    const [activeRow] = await ctx.tx
      .select({ value: count() })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.businessId, business.id), eq(knowledgeItems.status, "active")));
    let active = activeRow?.value ?? 0;
    const positions = new Map<KnowledgeCategory, number>();
    const nextPosition = async (category: KnowledgeCategory): Promise<number> => {
      let next = positions.get(category);
      if (next === undefined) {
        const [row] = await ctx.tx
          .select({ value: max(knowledgeItems.position) })
          .from(knowledgeItems)
          .where(
            and(eq(knowledgeItems.businessId, business.id), eq(knowledgeItems.category, category)),
          );
        next = (row?.value ?? -1) + 1;
      }
      positions.set(category, next + 1);
      return next;
    };

    let full = false;
    for (const [key, { fact, row }] of incoming) {
      const current = byKey.get(key);
      if (current === undefined) {
        if (active >= MAX_ACTIVE_FACTS) {
          if (!full) {
            problems.push({
              row,
              column: null,
              message: `The business already holds ${MAX_ACTIVE_FACTS} active facts, the most it can. The remaining facts were not imported.`,
            });
          }
          full = true;
          failedRows.add(row);
          continue;
        }
        await ctx.tx.insert(knowledgeItems).values({
          ...tenant,
          category: fact.category,
          title: fact.title,
          content: fact.content,
          source,
          importRunId: run.id,
          importKey: key,
          position: await nextPosition(fact.category),
          updatedBy: editor,
        });
        active += 1;
        counters.factsCreated += 1;
        continue;
      }
      const archivedByPerson =
        current.status === "archived" && current.metadata["archivedBy"] !== "import";
      if (isHandEdited(current.metadata) || archivedByPerson) {
        counters.factsKept += 1;
        continue;
      }
      const same =
        current.title === fact.title &&
        current.content === fact.content &&
        current.category === fact.category &&
        current.status === "active";
      if (same) {
        counters.factsUnchanged += 1;
        continue;
      }
      if (current.status !== "active") {
        if (active >= MAX_ACTIVE_FACTS) {
          failedRows.add(row);
          continue;
        }
        active += 1;
      }
      const { archivedBy: _archivedBy, ...metadata } = current.metadata;
      await ctx.tx
        .update(knowledgeItems)
        .set({
          title: fact.title,
          content: fact.content,
          status: "active",
          source,
          importRunId: run.id,
          metadata,
          updatedBy: editor,
        })
        .where(eq(knowledgeItems.id, current.id));
      counters.factsUpdated += 1;
    }

    if (mode === "replace") {
      // Imported facts the new data no longer has. Website facts and hand-written ones have
      // other keys (or none) and are not touched.
      const candidates = await ctx.tx
        .select({
          id: knowledgeItems.id,
          importKey: knowledgeItems.importKey,
          metadata: knowledgeItems.metadata,
        })
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.businessId, business.id),
            eq(knowledgeItems.status, "active"),
            isNotNull(knowledgeItems.importKey),
            like(knowledgeItems.importKey, `${IMPORT_KEY_PREFIX}%`),
          ),
        );
      for (const candidate of candidates) {
        if (candidate.importKey === null || incoming.has(candidate.importKey)) continue;
        if (isHandEdited(candidate.metadata)) {
          counters.factsKept += 1;
          continue;
        }
        await ctx.tx
          .update(knowledgeItems)
          .set({ status: "archived", metadata: { ...candidate.metadata, archivedBy: "import" } })
          .where(eq(knowledgeItems.id, candidate.id));
        counters.factsArchived += 1;
      }
    }

    // A business that has no reference yet takes the one its data came with, so that a later
    // import for the whole agency finds it. Never a reference another business already has.
    const ref = records.find((record) => record.externalRef !== null)?.externalRef ?? null;
    if (profileMode !== "ignore" && business.externalRef === null && ref !== null) {
      const [holder] = await ctx.tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(and(eq(businesses.agencyId, input.agencyId), eq(businesses.externalRef, ref)))
        .limit(1);
      if (holder === undefined) {
        await ctx.tx
          .update(businesses)
          .set({ externalRef: ref })
          .where(eq(businesses.id, business.id));
        counters.profileFieldsSet += 1;
      }
    }

    if (profileMode !== "ignore") {
      const merged: Partial<Record<keyof ImportProfile, string>> = {};
      for (const record of records) {
        for (const property of Object.values(PROFILE_PROPERTY)) {
          const value = record.profile[property];
          if (value === undefined || value.length === 0 || merged[property] !== undefined) continue;
          const current = business.profile[property];
          const empty = current === null || current.trim().length === 0;
          // The time zone and the name always have a value: they change only on "overwrite".
          if (profileMode === "overwrite" ? current !== value : empty) merged[property] = value;
        }
      }
      if (Object.keys(merged).length > 0) {
        await ctx.tx.update(businesses).set(merged).where(eq(businesses.id, business.id));
        counters.profileFieldsSet += Object.keys(merged).length;
      }
    }

    for (const record of records) {
      if (failedRows.has(record.row)) counters.recordsFailed += 1;
      else counters.recordsImported += 1;
    }
  }

  const received = input.received ?? input.records.length;
  const stats: ImportStats = {
    records: received,
    recordsImported: counters.recordsImported,
    // Rows that never became a record (parsing or validation) are failures too.
    recordsFailed: counters.recordsFailed + Math.max(0, received - input.records.length),
    businesses: perBusiness.size,
    factsCreated: counters.factsCreated,
    factsUpdated: counters.factsUpdated,
    factsUnchanged: counters.factsUnchanged,
    factsKept: counters.factsKept,
    factsArchived: counters.factsArchived,
    profileFieldsSet: counters.profileFieldsSet,
  };
  const status: ImportRunStatus =
    stats.recordsImported === 0 ? "failed" : problems.length > 0 ? "partial" : "succeeded";
  const stored = problems.slice(0, MAX_STORED_PROBLEMS);
  await ctx.tx
    .update(importRuns)
    .set({
      status,
      stats: { ...stats, mode, profileMode, problems: problems.length },
      errors: stored,
      finishedAt: input.now,
    })
    .where(eq(importRuns.id, run.id));

  const entry = {
    action: "knowledge.import",
    targetType: "import_run",
    targetId: run.id,
    summary: `Knowledge import (${input.kind}): ${status}; ${stats.factsCreated} added, ${stats.factsUpdated} updated, ${stats.factsArchived} archived, ${stats.recordsFailed} rows with problems`,
    metadata: { kind: input.kind, mode, status, ...stats },
  };
  if (ctx.kind === "user") {
    await recordUserAudit(ctx, { agencyId: input.agencyId, businessId: input.businessId }, entry);
  } else {
    await recordSystemAudit(
      ctx,
      input.actor ?? { type: "system", label: "knowledge-import" },
      entry,
    );
  }
  return { importRunId: run.id, status, stats, problems: stored };
}

/** Records a run that never got as far as applying anything (an unreadable file). */
export async function recordFailedImport(
  ctx: ImportContext,
  input: {
    readonly agencyId: AgencyId;
    readonly businessId: BusinessId | null;
    readonly kind: Extract<ImportRunKind, "csv" | "api">;
    readonly fileName?: string | null;
    readonly problems: readonly ImportProblem[];
    readonly actor?: AuditActor;
    readonly now: Date;
  },
): Promise<ImportResult> {
  const stats: ImportStats = {
    records: 0,
    recordsImported: 0,
    recordsFailed: 0,
    businesses: 0,
    factsCreated: 0,
    factsUpdated: 0,
    factsUnchanged: 0,
    factsKept: 0,
    factsArchived: 0,
    profileFieldsSet: 0,
  };
  const stored = input.problems.slice(0, MAX_STORED_PROBLEMS);
  const [run] = await ctx.tx
    .insert(importRuns)
    .values({
      agencyId: input.agencyId,
      businessId: input.businessId,
      kind: input.kind,
      status: "failed",
      fileName: input.fileName?.slice(0, 255) ?? null,
      stats: { ...stats, problems: input.problems.length },
      errors: stored,
      createdBy: actorId(ctx, input.actor),
      startedAt: input.now,
      finishedAt: input.now,
    })
    .returning({ id: importRuns.id });
  if (run === undefined) throw new Error("Insert into import_runs returned no row");
  return { importRunId: run.id, status: "failed", stats, problems: stored };
}
