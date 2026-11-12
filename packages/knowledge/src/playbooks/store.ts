import {
  type AgencyId,
  AppError,
  NotFoundError,
  type PlaybookDocument,
  type SegmentId,
  type TraceId,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  type AgencyContext,
  and,
  type AuditActor,
  count,
  type DbContext,
  desc,
  eq,
  inArray,
  max,
  playbookGenerations,
  type PlaybookGenerationReason,
  type PlaybookGenerationStatus,
  type PlaybookOrigin,
  playbookVersions,
  recordSystemAudit,
  recordUserAudit,
  segments,
  sql,
  type UserContext,
} from "@repo/db";
import { canonicalJson } from "@repo/settings";

import { diffPlaybooks, summarizeDiff } from "./diff";
import {
  completenessIssues,
  describeIssues,
  parsePlaybookDocument,
  type PlaybookIssue,
} from "./document";

/**
 * Playbook versions and generation runs in the database.
 *
 * A stored version never changes (migration 0006 enforces it): saving an edit, storing a
 * generated document and rolling back each insert a new version and move the `is_active`
 * flag to it. Writers of one segment are serialized with an advisory lock, so version
 * numbers are gap-free and exactly one version is active.
 *
 * Every function takes a database context: a signed-in member of staff (row-level security
 * applies) or the system scope of the agency. Role checks for signed-in users are in
 * `service.ts`.
 */

/** A context that may write playbook versions: staff as themselves, or the agency's system scope. */
export type PlaybookWriteContext = UserContext | AgencyContext;

export interface SegmentRecord {
  readonly id: SegmentId;
  readonly agencyId: AgencyId;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
}

export interface PlaybookVersionSummary {
  readonly id: string;
  readonly segmentId: SegmentId;
  readonly version: number;
  readonly isActive: boolean;
  readonly origin: PlaybookOrigin;
  readonly changeNote: string | null;
  readonly createdBy: UserId | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

export interface PlaybookVersionRecord extends PlaybookVersionSummary {
  /** Null when the stored document does not pass today's checks (see `issues`). */
  readonly document: PlaybookDocument | null;
  readonly issues: readonly PlaybookIssue[];
}

const SUMMARY_COLUMNS = {
  id: playbookVersions.id,
  segmentId: playbookVersions.segmentId,
  version: playbookVersions.version,
  isActive: playbookVersions.isActive,
  origin: playbookVersions.origin,
  changeNote: playbookVersions.changeNote,
  createdBy: playbookVersions.createdBy,
  createdAt: playbookVersions.createdAt,
};

function summary(row: {
  id: string;
  segmentId: SegmentId;
  version: number;
  isActive: boolean;
  origin: PlaybookOrigin;
  changeNote: string | null;
  createdBy: UserId | null;
  createdAt: Date;
}): PlaybookVersionSummary {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function record(row: Parameters<typeof summary>[0] & { document: unknown }): PlaybookVersionRecord {
  const { document: stored, ...rest } = row;
  const parsed = parsePlaybookDocument(stored);
  return {
    ...summary(rest),
    document: parsed.ok ? parsed.document : null,
    issues: parsed.ok ? [] : parsed.issues,
  };
}

export async function findSegment(
  ctx: DbContext,
  segmentId: SegmentId,
): Promise<SegmentRecord | null> {
  const [row] = await ctx.tx
    .select({
      id: segments.id,
      agencyId: segments.agencyId,
      slug: segments.slug,
      name: segments.name,
      description: segments.description,
    })
    .from(segments)
    .where(eq(segments.id, segmentId))
    .limit(1);
  return row ?? null;
}

export async function requireSegment(ctx: DbContext, segmentId: SegmentId): Promise<SegmentRecord> {
  const segment = await findSegment(ctx, segmentId);
  if (segment === null) {
    throw new NotFoundError("Segment not found.", { details: { segmentId } });
  }
  return segment;
}

/** Every version of the segment's playbook, newest first, without the documents. */
export async function listPlaybookVersions(
  ctx: DbContext,
  segmentId: SegmentId,
): Promise<PlaybookVersionSummary[]> {
  const rows = await ctx.tx
    .select(SUMMARY_COLUMNS)
    .from(playbookVersions)
    .where(eq(playbookVersions.segmentId, segmentId))
    .orderBy(desc(playbookVersions.version));
  return rows.map(summary);
}

export async function getPlaybookVersion(
  ctx: DbContext,
  segmentId: SegmentId,
  version: number,
): Promise<PlaybookVersionRecord | null> {
  const [row] = await ctx.tx
    .select({ ...SUMMARY_COLUMNS, document: playbookVersions.document })
    .from(playbookVersions)
    .where(and(eq(playbookVersions.segmentId, segmentId), eq(playbookVersions.version, version)))
    .limit(1);
  return row === undefined ? null : record(row);
}

/** The version in force, or null when the segment has no playbook yet. */
export async function getActivePlaybook(
  ctx: DbContext,
  segmentId: SegmentId,
): Promise<PlaybookVersionRecord | null> {
  const [row] = await ctx.tx
    .select({ ...SUMMARY_COLUMNS, document: playbookVersions.document })
    .from(playbookVersions)
    .where(and(eq(playbookVersions.segmentId, segmentId), eq(playbookVersions.isActive, true)))
    .limit(1);
  return row === undefined ? null : record(row);
}

/** Serializes writers of one segment's playbook for the rest of the transaction. */
export async function lockSegmentPlaybook(ctx: DbContext, segmentId: SegmentId): Promise<void> {
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`playbook:${segmentId}`}, 0))`,
  );
}

export interface SavePlaybookInput {
  readonly segmentId: SegmentId;
  /** Checked here: schema and rules must hold, or a `ValidationError` lists the problems. */
  readonly document: unknown;
  readonly origin: PlaybookOrigin;
  readonly changeNote?: string | null;
  /**
   * The active version the change was made from. When someone else saved in the meantime the
   * save is refused with a conflict instead of silently replacing their version.
   */
  readonly baseVersion?: number | null;
  /** Who is recorded, for the system scope. A signed-in user is always recorded as themselves. */
  readonly actor?: AuditActor;
  readonly traceId?: TraceId;
  /** Also require completeness (generated documents). Default false: reported as warnings. */
  readonly requireComplete?: boolean;
}

export interface SavedPlaybook {
  readonly version: number;
  /** False when the document equals the active version: nothing was stored. */
  readonly created: boolean;
  /** What a complete playbook would still need. Never blocks a hand edit. */
  readonly warnings: readonly PlaybookIssue[];
  /** Sections that differ from the version that was active before. */
  readonly changedSections: readonly string[];
}

export class PlaybookValidationError extends ValidationError {
  readonly issues: readonly PlaybookIssue[];
  constructor(issues: readonly PlaybookIssue[]) {
    super(
      `The playbook has ${issues.length === 1 ? "a problem" : "problems"}:\n${describeIssues(issues, 10)}`,
      {
        details: { issues: issues.slice(0, 50) },
      },
    );
    this.issues = issues;
  }
}

function conflict(message: string, details: Record<string, unknown>): AppError {
  return new AppError("conflict", message, { details });
}

async function audit(
  ctx: PlaybookWriteContext,
  agencyId: AgencyId,
  input: SavePlaybookInput,
  entry: { readonly action: string; readonly summary: string; readonly version: number },
): Promise<void> {
  const body = {
    action: entry.action,
    targetType: "segment",
    targetId: input.segmentId,
    summary: entry.summary,
    metadata: { version: entry.version, origin: input.origin },
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
  if (ctx.kind === "user") {
    await recordUserAudit(ctx, { agencyId }, body);
  } else {
    await recordSystemAudit(ctx, input.actor ?? { type: "system", label: "knowledge" }, body);
  }
}

/**
 * Stores a document as the segment's new, active playbook version. Call it inside the
 * transaction of the request or job; it takes the segment's lock itself.
 */
export async function savePlaybookVersion(
  ctx: PlaybookWriteContext,
  input: SavePlaybookInput,
): Promise<SavedPlaybook> {
  const parsed = parsePlaybookDocument(input.document);
  if (!parsed.ok) throw new PlaybookValidationError(parsed.issues);
  const warnings = completenessIssues(parsed.document);
  if (input.requireComplete === true && warnings.length > 0) {
    throw new PlaybookValidationError(warnings);
  }

  const segment = await requireSegment(ctx, input.segmentId);
  await lockSegmentPlaybook(ctx, segment.id);
  const active = await getActivePlaybook(ctx, segment.id);
  const activeVersion = active?.version ?? null;
  if (input.baseVersion !== undefined && input.baseVersion !== activeVersion) {
    throw conflict(
      "The playbook was changed by someone else in the meantime. Reload it and apply your changes again.",
      { segmentId: segment.id, baseVersion: input.baseVersion, activeVersion },
    );
  }
  if (
    active?.document !== undefined &&
    active.document !== null &&
    canonicalJson(active.document) === canonicalJson(parsed.document)
  ) {
    return { version: active.version, created: false, warnings, changedSections: [] };
  }

  const [latest] = await ctx.tx
    .select({ value: max(playbookVersions.version) })
    .from(playbookVersions)
    .where(eq(playbookVersions.segmentId, segment.id));
  const version = (latest?.value ?? 0) + 1;
  await ctx.tx
    .update(playbookVersions)
    .set({ isActive: false })
    .where(and(eq(playbookVersions.segmentId, segment.id), eq(playbookVersions.isActive, true)));
  const createdBy =
    ctx.kind === "user" ? ctx.user.id : input.actor?.type === "user" ? input.actor.userId : null;
  await ctx.tx.insert(playbookVersions).values({
    agencyId: segment.agencyId,
    segmentId: segment.id,
    version,
    isActive: true,
    origin: input.origin,
    document: parsed.document,
    changeNote: input.changeNote?.trim().slice(0, 500) ?? null,
    createdBy,
  });

  const diff =
    active?.document === undefined || active.document === null
      ? null
      : diffPlaybooks(active.document, parsed.document);
  await audit(ctx, segment.agencyId, input, {
    action: input.origin === "rollback" ? "playbook.rollback" : "playbook.save",
    version,
    summary:
      diff === null
        ? `Playbook of ${segment.name}: version ${version} (${input.origin})`
        : `Playbook of ${segment.name}: version ${version} (${input.origin}); ${summarizeDiff(diff)}`,
  });
  return { version, created: true, warnings, changedSections: diff?.changedSections ?? [] };
}

/**
 * Makes an earlier version the playbook in force again, as a new version with the same
 * document (history stays linear and nothing stored is touched).
 */
export async function rollbackPlaybook(
  ctx: PlaybookWriteContext,
  input: {
    readonly segmentId: SegmentId;
    readonly toVersion: number;
    readonly baseVersion?: number | null;
    readonly actor?: AuditActor;
    readonly traceId?: TraceId;
  },
): Promise<SavedPlaybook> {
  const target = await getPlaybookVersion(ctx, input.segmentId, input.toVersion);
  if (target === null) {
    throw new NotFoundError("That playbook version does not exist.", {
      details: { segmentId: input.segmentId, version: input.toVersion },
    });
  }
  if (target.document === null) {
    // A version from before a rule existed (for example a dollar figure outside the price
    // norms). It can be read and diffed, but not put back in force as it is.
    throw new PlaybookValidationError(target.issues);
  }
  return savePlaybookVersion(ctx, {
    segmentId: input.segmentId,
    document: target.document,
    origin: "rollback",
    changeNote: `Rolled back to version ${input.toVersion}`,
    ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

// --- generation runs -----------------------------------------------------------------------

export interface PlaybookGenerationRecord {
  readonly id: string;
  readonly segmentId: SegmentId;
  readonly status: PlaybookGenerationStatus;
  readonly reason: PlaybookGenerationReason;
  readonly requestedBy: UserId | null;
  readonly traceId: TraceId;
  readonly version: number | null;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function generation(row: typeof playbookGenerations.$inferSelect): PlaybookGenerationRecord {
  return {
    id: row.id,
    segmentId: row.segmentId,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requestedBy,
    traceId: row.traceId,
    version: row.version,
    stats: row.stats,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

const OPEN: readonly PlaybookGenerationStatus[] = ["pending", "running"];

/** A run that has not moved for this long is taken for dead and no longer blocks the segment. */
export const GENERATION_STALE_MS = 45 * 60 * 1000;

export async function getGeneration(
  ctx: DbContext,
  generationId: string,
): Promise<PlaybookGenerationRecord | null> {
  const [row] = await ctx.tx
    .select()
    .from(playbookGenerations)
    .where(eq(playbookGenerations.id, generationId))
    .limit(1);
  return row === undefined ? null : generation(row);
}

/** The runs of a segment, newest first. */
export async function listGenerations(
  ctx: DbContext,
  segmentId: SegmentId,
  limit = 10,
): Promise<PlaybookGenerationRecord[]> {
  const rows = await ctx.tx
    .select()
    .from(playbookGenerations)
    .where(eq(playbookGenerations.segmentId, segmentId))
    .orderBy(desc(playbookGenerations.createdAt), desc(playbookGenerations.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(generation);
}

/**
 * Opens a generation run for the segment, or returns the one already open. Runs that
 * stopped moving are closed as failed first, so a lost job cannot block a segment for good.
 */
export async function openGeneration(
  ctx: AgencyContext,
  input: {
    readonly segmentId: SegmentId;
    readonly reason: PlaybookGenerationReason;
    readonly requestedBy: UserId | null;
    readonly traceId: TraceId;
    readonly now: Date;
  },
): Promise<{ readonly generation: PlaybookGenerationRecord; readonly created: boolean }> {
  const segment = await requireSegment(ctx, input.segmentId);
  await lockSegmentPlaybook(ctx, segment.id);
  await ctx.tx
    .update(playbookGenerations)
    .set({
      status: "failed",
      errorCode: "timed_out",
      errorMessage: "The run stopped without finishing.",
      finishedAt: input.now,
    })
    .where(
      and(
        eq(playbookGenerations.segmentId, segment.id),
        inArray(playbookGenerations.status, [...OPEN]),
        // The database's own clock on both sides: `updated_at` is written by it.
        sql`${playbookGenerations.updatedAt} < now() - make_interval(secs => ${GENERATION_STALE_MS / 1000})`,
      ),
    );
  const [open] = await ctx.tx
    .select()
    .from(playbookGenerations)
    .where(
      and(
        eq(playbookGenerations.segmentId, segment.id),
        inArray(playbookGenerations.status, [...OPEN]),
      ),
    )
    .limit(1);
  if (open !== undefined) return { generation: generation(open), created: false };
  const [row] = await ctx.tx
    .insert(playbookGenerations)
    .values({
      agencyId: segment.agencyId,
      segmentId: segment.id,
      status: "pending",
      reason: input.reason,
      requestedBy: input.requestedBy,
      traceId: input.traceId,
    })
    .returning();
  if (row === undefined) throw new Error("Insert into playbook_generations returned no row");
  return { generation: generation(row), created: true };
}

/** Moves a run forward. Only open runs change: a finished run keeps its outcome. */
export async function updateGeneration(
  ctx: AgencyContext,
  generationId: string,
  change: {
    readonly status?: PlaybookGenerationStatus;
    readonly stats?: Readonly<Record<string, unknown>>;
    readonly version?: number;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly startedAt?: Date;
    readonly finishedAt?: Date;
  },
): Promise<boolean> {
  const rows = await ctx.tx
    .update(playbookGenerations)
    .set({
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.stats === undefined
        ? {}
        : { stats: sql`${playbookGenerations.stats} || ${JSON.stringify(change.stats)}::jsonb` }),
      ...(change.version === undefined ? {} : { version: change.version }),
      ...(change.errorCode === undefined ? {} : { errorCode: change.errorCode }),
      ...(change.errorMessage === undefined
        ? {}
        : { errorMessage: change.errorMessage?.slice(0, 1000) ?? null }),
      ...(change.startedAt === undefined ? {} : { startedAt: change.startedAt }),
      ...(change.finishedAt === undefined ? {} : { finishedAt: change.finishedAt }),
    })
    .where(
      and(eq(playbookGenerations.id, generationId), inArray(playbookGenerations.status, [...OPEN])),
    )
    .returning({ id: playbookGenerations.id });
  return rows.length > 0;
}

export interface SegmentPlaybookStatus {
  readonly segment: SegmentRecord;
  /** The version in force, or null. */
  readonly activeVersion: number | null;
  readonly versions: number;
  /** The open generation run, if there is one. */
  readonly generation: PlaybookGenerationRecord | null;
}

/** Every segment of the agency with the state of its playbook, by name. */
export async function listSegmentPlaybooks(
  ctx: DbContext,
  agencyId: AgencyId,
): Promise<SegmentPlaybookStatus[]> {
  const segmentRows = await ctx.tx
    .select({
      id: segments.id,
      agencyId: segments.agencyId,
      slug: segments.slug,
      name: segments.name,
      description: segments.description,
    })
    .from(segments)
    .where(eq(segments.agencyId, agencyId))
    .orderBy(segments.name, segments.id);
  if (segmentRows.length === 0) return [];
  const ids = segmentRows.map((segment) => segment.id);
  const versionRows = await ctx.tx
    .select({
      segmentId: playbookVersions.segmentId,
      versions: count(),
      active: sql<
        number | null
      >`max(${playbookVersions.version}) filter (where ${playbookVersions.isActive})`,
    })
    .from(playbookVersions)
    .where(inArray(playbookVersions.segmentId, ids))
    .groupBy(playbookVersions.segmentId);
  const openRows = await ctx.tx
    .select()
    .from(playbookGenerations)
    .where(
      and(
        inArray(playbookGenerations.segmentId, ids),
        inArray(playbookGenerations.status, [...OPEN]),
      ),
    );
  return segmentRows.map((segment) => {
    const versions = versionRows.find((row) => row.segmentId === segment.id);
    const open = openRows.find((row) => row.segmentId === segment.id);
    return {
      segment,
      activeVersion: versions?.active ?? null,
      versions: versions?.versions ?? 0,
      generation: open === undefined ? null : generation(open),
    };
  });
}
