import {
  type AgencyId,
  type BusinessId,
  type Logger,
  newTraceId,
  NotFoundError,
  type SegmentId,
  type TraceId,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  type AgencyContext,
  and,
  businesses,
  count,
  type Database,
  eq,
  ne,
  recordSystemAudit,
  segments,
} from "@repo/db";
import { type EventSender, jobEvent } from "@repo/jobs";
import type { SegmentPresetId } from "@repo/settings";
import { applySegmentPreset } from "@repo/settings/server";

import {
  getActivePlaybook,
  openGeneration,
  type PlaybookGenerationRecord,
  requireSegment,
  type SegmentRecord,
  updateGeneration,
} from "./store";

/**
 * Putting a business into a segment: the moment a playbook is generated or reused
 * (docs/SPEC.md: "generated the first time a business is onboarded in a new segment, reused
 * and versioned for later clients in that segment").
 */

export type SegmentChoice =
  /** An existing segment of the agency. */
  | { readonly id: SegmentId }
  /** A segment by name: found by its slug, or created. */
  | {
      readonly name: string;
      readonly slug?: string;
      readonly description?: string | null;
    };

export interface AssignSegmentInput {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  readonly segment: SegmentChoice;
  /** The signed-in user the server acts for; null for a job or a script. */
  readonly requestedBy: UserId | null;
  readonly traceId?: TraceId;
}

export type PlaybookAssignment =
  /** The segment already had a playbook: the business uses it from its next reply on. */
  | { readonly status: "reused"; readonly version: number }
  /** The segment has none: a generation run is open (started now, or already under way). */
  | {
      readonly status: "generating";
      readonly generationId: string;
      /** False when the run was opened by an earlier request. */
      readonly started: boolean;
    };

export interface AssignSegmentResult {
  readonly segment: SegmentRecord;
  readonly segmentCreated: boolean;
  /** The settings preset applied to the segment by this call, if any. */
  readonly presetApplied: SegmentPresetId | null;
  readonly playbook: PlaybookAssignment;
}

/** "Kitchen & Bath Remodeling" → "kitchen-bath-remodeling". */
export function segmentSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60)
    .replaceAll(/-+$/g, "");
}

async function resolveSegment(
  ctx: AgencyContext,
  choice: SegmentChoice,
): Promise<{ readonly segment: SegmentRecord; readonly created: boolean }> {
  if ("id" in choice) return { segment: await requireSegment(ctx, choice.id), created: false };
  const name = choice.name.trim().replaceAll(/\s+/g, " ");
  const slug = segmentSlug(choice.slug ?? name);
  if (name.length === 0 || name.length > 120 || slug.length === 0) {
    throw new ValidationError("A segment needs a name of 1 to 120 characters with letters in it.");
  }
  const columns = {
    id: segments.id,
    agencyId: segments.agencyId,
    slug: segments.slug,
    name: segments.name,
    description: segments.description,
  };
  const [inserted] = await ctx.tx
    .insert(segments)
    .values({
      agencyId: ctx.tenant.agencyId,
      slug,
      name,
      description: choice.description?.trim().slice(0, 1000) ?? null,
    })
    .onConflictDoNothing({ target: [segments.agencyId, segments.slug] })
    .returning(columns);
  if (inserted !== undefined) return { segment: inserted, created: true };
  const [existing] = await ctx.tx
    .select(columns)
    .from(segments)
    .where(and(eq(segments.agencyId, ctx.tenant.agencyId), eq(segments.slug, slug)))
    .limit(1);
  if (existing === undefined) throw new Error("The segment could neither be created nor found");
  return { segment: existing, created: false };
}

export const generationEventId = (generationId: string) => `playbook-generation-${generationId}`;

export interface PlaybookRequestDeps {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

/**
 * Sends the event that starts the generation job. When it cannot be sent the run is closed
 * as failed at once, so the segment is not blocked by a run nobody is working on.
 */
export async function emitGenerationRequested(
  deps: PlaybookRequestDeps,
  input: {
    readonly agencyId: AgencyId;
    readonly segmentId: SegmentId;
    readonly generation: PlaybookGenerationRecord;
    readonly businessId: BusinessId | null;
  },
): Promise<void> {
  try {
    await deps.events.send([
      jobEvent("playbook.generation_requested", generationEventId(input.generation.id), {
        traceId: input.generation.traceId,
        agencyId: input.agencyId,
        segmentId: input.segmentId,
        generationId: input.generation.id,
        businessId: input.businessId,
      }),
    ]);
  } catch (error) {
    const now = (deps.clock ?? (() => new Date()))();
    await deps.db.forAgency(input.agencyId).run((ctx) =>
      updateGeneration(ctx, input.generation.id, {
        status: "failed",
        errorCode: "not_queued",
        errorMessage: "The generation job could not be queued.",
        finishedAt: now,
      }),
    );
    deps.logger.error("playbook.generation_not_queued", {
      agencyId: input.agencyId,
      segmentId: input.segmentId,
      generationId: input.generation.id,
      error,
    });
    throw error;
  }
}

/**
 * Puts a business into a segment and makes sure the segment gets a playbook.
 *
 * - The segment is found by id or slug, or created.
 * - The first time a segment is served it gets its settings preset (C2), as ordinary segment
 *   overrides. Later businesses do not re-apply it: an admin may have reset a value on purpose.
 * - A segment with an active playbook is reused as it is, with no model call. Otherwise a
 *   generation run is opened (one per segment at a time) and the job is asked to run it.
 *
 * The caller has already authorized the request; everything here runs in the agency's system
 * scope and is recorded in the audit log under `requestedBy`.
 */
export async function assignSegment(
  deps: PlaybookRequestDeps,
  input: AssignSegmentInput,
): Promise<AssignSegmentResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const traceId = input.traceId ?? newTraceId();
  const outcome = await deps.db.forAgency(input.agencyId).run(async (ctx) => {
    const [business] = await ctx.tx
      .select({ id: businesses.id, name: businesses.name, segmentId: businesses.segmentId })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    if (business === undefined) {
      throw new NotFoundError("Business not found.", { details: { businessId: input.businessId } });
    }
    const { segment, created } = await resolveSegment(ctx, input.segment);
    const [others] = await ctx.tx
      .select({ value: count() })
      .from(businesses)
      .where(and(eq(businesses.segmentId, segment.id), ne(businesses.id, business.id)));
    const firstServed = created || (others?.value ?? 0) === 0;
    if (business.segmentId !== segment.id) {
      await ctx.tx
        .update(businesses)
        .set({ segmentId: segment.id })
        .where(eq(businesses.id, business.id));
    }

    const preset = firstServed
      ? await applySegmentPreset(ctx, {
          segmentId: segment.id,
          slug: segment.slug,
          actor: { type: "system", label: "segment-onboarding" },
        })
      : null;
    const presetApplied = preset !== null && preset.applied.length > 0 ? preset.preset : null;

    const active = await getActivePlaybook(ctx, segment.id);
    const opened =
      active === null
        ? await openGeneration(ctx, {
            segmentId: segment.id,
            reason: "onboarding",
            requestedBy: input.requestedBy,
            traceId,
            now,
          })
        : null;

    await recordSystemAudit(
      ctx,
      input.requestedBy === null
        ? { type: "system", label: "segment-onboarding" }
        : { type: "user", userId: input.requestedBy },
      {
        action: "business.segment_assigned",
        targetType: "business",
        targetId: business.id,
        summary: `${business.name}: segment ${segment.name}${
          active === null ? ", playbook requested" : `, playbook v${active.version} reused`
        }`,
        metadata: {
          segmentId: segment.id,
          segmentCreated: created,
          playbookVersion: active?.version ?? null,
          generationId: opened?.generation.id ?? null,
        },
        traceId,
      },
    );
    return { segment, created, presetApplied, active, opened };
  });

  if (outcome.active !== null) {
    return {
      segment: outcome.segment,
      segmentCreated: outcome.created,
      presetApplied: outcome.presetApplied,
      playbook: { status: "reused", version: outcome.active.version },
    };
  }
  const opened = outcome.opened;
  if (opened === null) throw new Error("unreachable: no playbook and no generation run");
  if (opened.created) {
    await emitGenerationRequested(deps, {
      agencyId: input.agencyId,
      segmentId: outcome.segment.id,
      generation: opened.generation,
      businessId: input.businessId,
    });
  }
  return {
    segment: outcome.segment,
    segmentCreated: outcome.created,
    presetApplied: outcome.presetApplied,
    playbook: {
      status: "generating",
      generationId: opened.generation.id,
      started: opened.created,
    },
  };
}

/**
 * Asks for a new playbook version for a segment that may already have one (an admin's
 * "research again"). Returns the open run when one is under way.
 */
export async function requestPlaybookGeneration(
  deps: PlaybookRequestDeps,
  input: {
    readonly agencyId: AgencyId;
    readonly segmentId: SegmentId;
    readonly requestedBy: UserId | null;
    readonly traceId?: TraceId;
  },
): Promise<{ readonly generation: PlaybookGenerationRecord; readonly started: boolean }> {
  const now = (deps.clock ?? (() => new Date()))();
  const opened = await deps.db.forAgency(input.agencyId).run((ctx) =>
    openGeneration(ctx, {
      segmentId: input.segmentId,
      reason: "manual",
      requestedBy: input.requestedBy,
      traceId: input.traceId ?? newTraceId(),
      now,
    }),
  );
  if (opened.created) {
    await emitGenerationRequested(deps, {
      agencyId: input.agencyId,
      segmentId: input.segmentId,
      generation: opened.generation,
      businessId: null,
    });
  }
  return { generation: opened.generation, started: opened.created };
}
