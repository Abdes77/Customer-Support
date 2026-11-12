import {
  type BusinessProfile,
  type ConversationId,
  type LeadFieldValue,
  type LeadSnapshot,
  PlaybookDocument,
  type PlaybookSnapshot,
  RoutingDecision,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  businesses,
  desc,
  eq,
  leadFields,
  leads,
  playbookVersions,
  routingDecisions,
  segments,
} from "@repo/db";

/**
 * Default loaders for the parts of the engine input other chunks own. They read the tables
 * C1 created; C5 (lead) and C6 (playbook with per-business overrides) replace them at the
 * composition root when they need more.
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

/** The segment's active playbook version, or null when there is none or it is not valid. */
export async function defaultPlaybookLoader(
  ctx: BusinessContext,
  business: BusinessProfile,
): Promise<PlaybookSnapshot | null> {
  const [row] = await ctx.tx
    .select({ version: playbookVersions.version, document: playbookVersions.document })
    .from(playbookVersions)
    .where(
      and(eq(playbookVersions.segmentId, business.segment.id), eq(playbookVersions.isActive, true)),
    )
    .limit(1);
  if (row === undefined) return null;
  const document = PlaybookDocument.safeParse(row.document);
  if (!document.success) return null;
  return {
    segmentId: business.segment.id,
    segmentSlug: business.segment.slug,
    version: row.version,
    document: document.data,
  };
}

const NEW_LEAD: LeadSnapshot = { id: null, status: "new", fields: {}, routing: null };

/** The conversation's lead with its fields and newest routing decision. */
export async function defaultLeadLoader(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<LeadSnapshot> {
  const [lead] = await ctx.tx
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .limit(1);
  if (lead === undefined) return NEW_LEAD;

  const fieldRows = await ctx.tx
    .select({
      key: leadFields.key,
      value: leadFields.value,
      confidence: leadFields.confidence,
      evidence: leadFields.evidence,
      updatedAt: leadFields.updatedAt,
    })
    .from(leadFields)
    .where(eq(leadFields.leadId, lead.id));
  const fields: Record<string, LeadFieldValue> = {};
  for (const row of fieldRows) {
    fields[row.key] = {
      key: row.key,
      value: (row.value ?? null) as LeadFieldValue["value"],
      confidence: row.confidence,
      evidence: row.evidence,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const [decision] = await ctx.tx
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.leadId, lead.id))
    .orderBy(desc(routingDecisions.decidedAt), desc(routingDecisions.createdAt))
    .limit(1);
  const routing =
    decision === undefined
      ? null
      : RoutingDecision.safeParse({
          outcome: decision.outcome,
          score: decision.score,
          band: decision.band,
          reasons: decision.reasons,
          decidedAt: decision.decidedAt.toISOString(),
          settingsVersion: decision.settingsVersion,
        });
  return {
    id: lead.id,
    status: lead.status,
    fields,
    routing: routing?.success === true ? routing.data : null,
  };
}
