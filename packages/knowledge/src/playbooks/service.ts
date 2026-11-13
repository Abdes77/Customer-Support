import {
  type AgencyId,
  type BusinessId,
  type Logger,
  NotFoundError,
  type PlaybookSnapshot,
  type SegmentId,
  type UserId,
} from "@repo/core";
import {
  businesses,
  type BusinessTenant,
  type Database,
  eq,
  loadUserAccess,
  requireAgencyRole,
  segments,
  type UserContext,
  type UserIdentity,
} from "@repo/db";
import type { EventSender } from "@repo/jobs";

import { diffPlaybooks, type PlaybookDiff } from "./diff";
import {
  assignSegment,
  type AssignSegmentResult,
  requestPlaybookGeneration,
  type SegmentChoice,
} from "./onboarding";
import {
  clearPlaybookOverride,
  listPlaybookOverrides,
  loadPlaybookForBusiness,
  type PlaybookOverrideRecord,
  setPlaybookOverride,
} from "./overrides";
import {
  getActivePlaybook,
  getGeneration,
  getPlaybookVersion,
  listGenerations,
  listPlaybookVersions,
  listSegmentPlaybooks,
  type PlaybookGenerationRecord,
  type PlaybookVersionRecord,
  type PlaybookVersionSummary,
  requireSegment,
  rollbackPlaybook,
  type SavedPlaybook,
  savePlaybookVersion,
  type SegmentPlaybookStatus,
  type SegmentRecord,
} from "./store";

/**
 * Playbooks for the admin panel (C15): every method acts for a signed-in user. Reading and
 * editing need agency staff (row-level security says the same); client users have no access
 * to playbooks at all. Edits and overrides are written as the user; generation runs, which
 * staff cannot write directly, are opened in the agency's system scope after the role check.
 */
export interface PlaybookService {
  /** The agency's segments with the state of each playbook. */
  listSegments(user: UserIdentity, agencyId: AgencyId): Promise<SegmentPlaybookStatus[]>;
  listVersions(user: UserIdentity, segmentId: SegmentId): Promise<PlaybookVersionSummary[]>;
  /** One version with its document; the active one when `version` is omitted. */
  getVersion(
    user: UserIdentity,
    segmentId: SegmentId,
    version?: number,
  ): Promise<PlaybookVersionRecord | null>;
  /** What changed from one version to another. */
  diffVersions(
    user: UserIdentity,
    segmentId: SegmentId,
    fromVersion: number,
    toVersion: number,
  ): Promise<PlaybookDiff>;
  /** Saves an edited document as a new version. */
  saveEdit(
    user: UserIdentity,
    input: {
      readonly segmentId: SegmentId;
      readonly document: unknown;
      readonly changeNote?: string | null;
      readonly baseVersion?: number | null;
    },
  ): Promise<SavedPlaybook>;
  rollback(
    user: UserIdentity,
    input: {
      readonly segmentId: SegmentId;
      readonly toVersion: number;
      readonly baseVersion?: number | null;
    },
  ): Promise<SavedPlaybook>;
  /** Research and write the playbook again, as a new version. */
  regenerate(
    user: UserIdentity,
    segmentId: SegmentId,
  ): Promise<{ readonly generation: PlaybookGenerationRecord; readonly started: boolean }>;
  listGenerations(user: UserIdentity, segmentId: SegmentId): Promise<PlaybookGenerationRecord[]>;
  getGeneration(user: UserIdentity, generationId: string): Promise<PlaybookGenerationRecord | null>;
  /** Puts a business into a segment; generates or reuses the playbook. */
  assignSegment(
    user: UserIdentity,
    input: { readonly businessId: BusinessId; readonly segment: SegmentChoice },
  ): Promise<AssignSegmentResult>;
  /** The playbook a business's bot uses: the segment's, with the business's own sections. */
  effectivePlaybook(user: UserIdentity, businessId: BusinessId): Promise<PlaybookSnapshot | null>;
  listOverrides(user: UserIdentity, businessId: BusinessId): Promise<PlaybookOverrideRecord[]>;
  setOverride(
    user: UserIdentity,
    input: {
      readonly businessId: BusinessId;
      readonly section: string;
      readonly content: unknown;
    },
  ): Promise<PlaybookOverrideRecord>;
  clearOverride(
    user: UserIdentity,
    input: { readonly businessId: BusinessId; readonly section: string },
  ): Promise<boolean>;
}

/** The segment, visible to the user, and the proof that the user is staff of its agency. */
async function staffSegment(ctx: UserContext, segmentId: SegmentId): Promise<SegmentRecord> {
  const segment = await requireSegment(ctx, segmentId);
  requireAgencyRole(await loadUserAccess(ctx), segment.agencyId);
  return segment;
}

interface StaffBusiness {
  readonly tenant: BusinessTenant;
  readonly segment: { readonly id: SegmentId; readonly slug: string; readonly name: string } | null;
}

async function staffBusiness(ctx: UserContext, businessId: BusinessId): Promise<StaffBusiness> {
  const [row] = await ctx.tx
    .select({
      agencyId: businesses.agencyId,
      businessId: businesses.id,
      segmentId: segments.id,
      segmentSlug: segments.slug,
      segmentName: segments.name,
    })
    .from(businesses)
    .leftJoin(segments, eq(segments.id, businesses.segmentId))
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (row === undefined) {
    throw new NotFoundError("Business not found.", { details: { businessId } });
  }
  requireAgencyRole(await loadUserAccess(ctx), row.agencyId);
  return {
    tenant: { agencyId: row.agencyId, businessId: row.businessId },
    segment:
      row.segmentId === null || row.segmentSlug === null || row.segmentName === null
        ? null
        : { id: row.segmentId, slug: row.segmentSlug, name: row.segmentName },
  };
}

export function createPlaybookService(deps: {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}): PlaybookService {
  const { db } = deps;
  const asUser = <T>(user: UserIdentity, fn: (ctx: UserContext) => Promise<T>) =>
    db.asUser(user).run(fn);
  const requester = (user: UserIdentity): UserId => user.id;

  return {
    listSegments: (user, agencyId) =>
      asUser(user, async (ctx) => {
        requireAgencyRole(await loadUserAccess(ctx), agencyId);
        return listSegmentPlaybooks(ctx, agencyId);
      }),

    listVersions: (user, segmentId) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, segmentId);
        return listPlaybookVersions(ctx, segmentId);
      }),

    getVersion: (user, segmentId, version) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, segmentId);
        return version === undefined
          ? getActivePlaybook(ctx, segmentId)
          : getPlaybookVersion(ctx, segmentId, version);
      }),

    diffVersions: (user, segmentId, fromVersion, toVersion) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, segmentId);
        const from = await getPlaybookVersion(ctx, segmentId, fromVersion);
        const to = await getPlaybookVersion(ctx, segmentId, toVersion);
        if (from?.document == null || to?.document == null) {
          throw new NotFoundError("One of the two versions does not exist or cannot be read.", {
            details: { segmentId, fromVersion, toVersion },
          });
        }
        return diffPlaybooks(from.document, to.document);
      }),

    saveEdit: (user, input) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, input.segmentId);
        return savePlaybookVersion(ctx, {
          segmentId: input.segmentId,
          document: input.document,
          origin: "manual",
          changeNote: input.changeNote ?? null,
          ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
        });
      }),

    rollback: (user, input) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, input.segmentId);
        return rollbackPlaybook(ctx, input);
      }),

    async regenerate(user, segmentId) {
      const segment = await asUser(user, (ctx) => staffSegment(ctx, segmentId));
      return requestPlaybookGeneration(deps, {
        agencyId: segment.agencyId,
        segmentId,
        requestedBy: requester(user),
      });
    },

    listGenerations: (user, segmentId) =>
      asUser(user, async (ctx) => {
        await staffSegment(ctx, segmentId);
        return listGenerations(ctx, segmentId);
      }),

    // Row-level security shows a run only to staff of its agency.
    getGeneration: (user, generationId) => asUser(user, (ctx) => getGeneration(ctx, generationId)),

    async assignSegment(user, input) {
      const { tenant } = await asUser(user, (ctx) => staffBusiness(ctx, input.businessId));
      if ("id" in input.segment) {
        const segmentId = input.segment.id;
        await asUser(user, (ctx) => staffSegment(ctx, segmentId));
      }
      return assignSegment(deps, {
        agencyId: tenant.agencyId,
        businessId: tenant.businessId,
        segment: input.segment,
        requestedBy: requester(user),
      });
    },

    effectivePlaybook: (user, businessId) =>
      asUser(user, async (ctx) => {
        const business = await staffBusiness(ctx, businessId);
        if (business.segment === null) return null;
        return loadPlaybookForBusiness(
          ctx,
          { id: businessId, segment: business.segment },
          { logger: deps.logger },
        );
      }),

    listOverrides: (user, businessId) =>
      asUser(user, async (ctx) => {
        await staffBusiness(ctx, businessId);
        return listPlaybookOverrides(ctx, businessId);
      }),

    setOverride: (user, input) =>
      asUser(user, async (ctx) => {
        const business = await staffBusiness(ctx, input.businessId);
        const active =
          business.segment === null ? null : await getActivePlaybook(ctx, business.segment.id);
        return setPlaybookOverride(ctx, {
          tenant: business.tenant,
          section: input.section,
          content: input.content,
          baseVersion: active?.version ?? null,
        });
      }),

    clearOverride: (user, input) =>
      asUser(user, async (ctx) => {
        const business = await staffBusiness(ctx, input.businessId);
        return clearPlaybookOverride(ctx, { tenant: business.tenant, section: input.section });
      }),
  };
}
