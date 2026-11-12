import type { BusinessProfile } from "@repo/core";
import { type BusinessContext, businesses, eq, segments } from "@repo/db";
import { loadLeadSnapshot } from "@repo/leads";

/**
 * Loaders for the parts of the engine input: the business profile, and the lead (C5). The playbook loader (the segment's active
 * version with the business's own sections) comes from `@repo/knowledge` (C6).
 */

/** The business as the engine sees it, or null when it has no segment yet. */
export async function loadBusinessProfile(ctx: BusinessContext): Promise<BusinessProfile | null> {
  const [row] = await ctx.tx
    .select({
      id: businesses.id,
      agencyId: businesses.agencyId,
      name: businesses.name,
      timezone: businesses.timezone,
      phone: businesses.phone,
      email: businesses.email,
      websiteUrl: businesses.websiteUrl,
      city: businesses.city,
      state: businesses.state,
      postalCode: businesses.postalCode,
      segmentId: segments.id,
      segmentSlug: segments.slug,
      segmentName: segments.name,
    })
    .from(businesses)
    .innerJoin(segments, eq(segments.id, businesses.segmentId))
    .where(eq(businesses.id, ctx.tenant.businessId))
    .limit(1);
  if (row === undefined) return null;
  return {
    id: row.id,
    agencyId: row.agencyId,
    name: row.name,
    timezone: row.timezone,
    segment: { id: row.segmentId, slug: row.segmentSlug, name: row.segmentName },
    contact: {
      phone: row.phone,
      email: row.email,
      websiteUrl: row.websiteUrl,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
    },
  };
}

/**
 * The conversation's lead with its fields and the routing decision in force. Kept under its
 * old name for callers that predate C5; the implementation is `loadLeadSnapshot` from
 * @repo/leads, which orders decisions by their `sequence`.
 */
export const defaultLeadLoader = loadLeadSnapshot;
