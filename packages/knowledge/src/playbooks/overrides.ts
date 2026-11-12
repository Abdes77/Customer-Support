import {
  type BusinessProfile,
  type Logger,
  PLAYBOOK_SECTIONS,
  type PlaybookDocument,
  type PlaybookSection,
  type PlaybookSnapshot,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  and,
  type AuditActor,
  type BusinessContext,
  businessPlaybookOverrides,
  type BusinessTenant,
  type DbContext,
  eq,
  recordSystemAudit,
  recordUserAudit,
  type UserContext,
} from "@repo/db";

import { parsePlaybookSection, type PlaybookIssue } from "./document";
import { getActivePlaybook, PlaybookValidationError } from "./store";

/**
 * Per-business overrides of the segment playbook. A business replaces whole sections (its
 * own objections, its own qualification questions); everything it does not replace follows
 * the segment's playbook, including later versions of it. The sources of a playbook are not
 * a section a business can replace: they say what the segment's document rests on.
 */

export const OVERRIDABLE_SECTIONS = PLAYBOOK_SECTIONS.filter(
  (section) => section !== "sources",
) as readonly Exclude<PlaybookSection, "sources">[];
export type OverridableSection = (typeof OVERRIDABLE_SECTIONS)[number];

export function isOverridableSection(value: string): value is OverridableSection {
  return (OVERRIDABLE_SECTIONS as readonly string[]).includes(value);
}

export interface PlaybookOverrideRecord {
  readonly section: string;
  /** Null when the stored content does not validate (it is then ignored by the engine). */
  readonly content: PlaybookDocument[OverridableSection] | null;
  readonly issues: readonly PlaybookIssue[];
  /** The playbook version the override was written against. */
  readonly baseVersion: number | null;
  readonly updatedBy: UserId | null;
  readonly updatedAt: string;
}

type BusinessWriteContext = UserContext | BusinessContext;

/** The business's overrides, in section order. Reads under the caller's row-level security. */
export async function listPlaybookOverrides(
  ctx: DbContext,
  businessId: BusinessTenant["businessId"],
): Promise<PlaybookOverrideRecord[]> {
  const rows = await ctx.tx
    .select()
    .from(businessPlaybookOverrides)
    .where(eq(businessPlaybookOverrides.businessId, businessId));
  const order = (section: string) => {
    const index = (PLAYBOOK_SECTIONS as readonly string[]).indexOf(section);
    return index === -1 ? PLAYBOOK_SECTIONS.length : index;
  };
  return rows
    .sort((a, b) => order(a.section) - order(b.section) || a.section.localeCompare(b.section))
    .map((row) => {
      const parsed = isOverridableSection(row.section)
        ? parsePlaybookSection(row.section, row.content)
        : {
            ok: false as const,
            issues: [
              {
                section: null,
                path: row.section,
                message: "This is not a section a business can override.",
              },
            ],
          };
      return {
        section: row.section,
        content: parsed.ok ? parsed.content : null,
        issues: parsed.ok ? [] : parsed.issues,
        baseVersion: row.baseVersion,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
}

async function audit(
  ctx: BusinessWriteContext,
  tenant: BusinessTenant,
  actor: AuditActor | undefined,
  entry: { readonly action: string; readonly section: string; readonly summary: string },
): Promise<void> {
  const body = {
    action: entry.action,
    targetType: "business",
    targetId: tenant.businessId,
    summary: entry.summary,
    metadata: { section: entry.section },
  };
  if (ctx.kind === "user") await recordUserAudit(ctx, tenant, body);
  else await recordSystemAudit(ctx, actor ?? { type: "system", label: "knowledge" }, body);
}

/**
 * Replaces one section of the playbook for one business. The content is checked like the
 * section of a playbook (schema, no dollar figure outside the price norms).
 */
export async function setPlaybookOverride(
  ctx: BusinessWriteContext,
  input: {
    readonly tenant: BusinessTenant;
    readonly section: string;
    readonly content: unknown;
    /** The segment's active version the override was written against. */
    readonly baseVersion?: number | null;
    readonly actor?: AuditActor;
  },
): Promise<PlaybookOverrideRecord> {
  if (!isOverridableSection(input.section)) {
    throw new ValidationError(`"${input.section}" is not a section a business can override.`, {
      details: { section: input.section, allowed: OVERRIDABLE_SECTIONS },
    });
  }
  const parsed = parsePlaybookSection(input.section, input.content);
  if (!parsed.ok) throw new PlaybookValidationError(parsed.issues);
  const updatedBy =
    ctx.kind === "user" ? ctx.user.id : input.actor?.type === "user" ? input.actor.userId : null;
  const [row] = await ctx.tx
    .insert(businessPlaybookOverrides)
    .values({
      ...input.tenant,
      section: input.section,
      content: parsed.content,
      baseVersion: input.baseVersion ?? null,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: [businessPlaybookOverrides.businessId, businessPlaybookOverrides.section],
      set: { content: parsed.content, baseVersion: input.baseVersion ?? null, updatedBy },
    })
    .returning();
  if (row === undefined) throw new Error("Upsert of a playbook override returned no row");
  await audit(ctx, input.tenant, input.actor, {
    action: "playbook.override_set",
    section: input.section,
    summary: `Playbook override: ${input.section} (${parsed.content.length} ${parsed.content.length === 1 ? "entry" : "entries"})`,
  });
  return {
    section: row.section,
    content: parsed.content,
    issues: [],
    baseVersion: row.baseVersion,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Removes an override: the business follows the segment's section again. */
export async function clearPlaybookOverride(
  ctx: BusinessWriteContext,
  input: { readonly tenant: BusinessTenant; readonly section: string; readonly actor?: AuditActor },
): Promise<boolean> {
  const removed = await ctx.tx
    .delete(businessPlaybookOverrides)
    .where(
      and(
        eq(businessPlaybookOverrides.businessId, input.tenant.businessId),
        eq(businessPlaybookOverrides.section, input.section),
      ),
    )
    .returning({ id: businessPlaybookOverrides.id });
  if (removed.length === 0) return false;
  await audit(ctx, input.tenant, input.actor, {
    action: "playbook.override_cleared",
    section: input.section,
    summary: `Playbook override removed: ${input.section}`,
  });
  return true;
}

/** A document with the valid overrides swapped in, and which sections they were. */
export function applyOverrides(
  document: PlaybookDocument,
  overrides: readonly Pick<PlaybookOverrideRecord, "section" | "content">[],
): { readonly document: PlaybookDocument; readonly overridden: OverridableSection[] } {
  let merged = document;
  const overridden: OverridableSection[] = [];
  for (const override of overrides) {
    if (override.content === null || !isOverridableSection(override.section)) continue;
    merged = { ...merged, [override.section]: override.content };
    overridden.push(override.section);
  }
  return { document: merged, overridden };
}

/**
 * The playbook in force for a business: the segment's active version with the business's
 * overrides swapped in. Null when the segment has no usable playbook (the engine then falls
 * back to its built-in placeholder). An override that does not validate is skipped and
 * logged by section name: agency staff can write that table directly, and one bad row must
 * neither be obeyed nor silence the bot.
 */
export async function loadPlaybookForBusiness(
  ctx: DbContext,
  business: Pick<BusinessProfile, "id" | "segment">,
  options: { readonly logger?: Logger } = {},
): Promise<PlaybookSnapshot | null> {
  const active = await getActivePlaybook(ctx, business.segment.id);
  if (active === null) return null;
  if (active.document === null) {
    options.logger?.warn("playbook.active_version_invalid", {
      segmentId: business.segment.id,
      version: active.version,
      issues: active.issues.slice(0, 5).map((issue) => issue.path),
    });
    return null;
  }
  const overrides = await listPlaybookOverrides(ctx, business.id);
  const skipped = overrides.filter((override) => override.content === null);
  if (skipped.length > 0) {
    options.logger?.warn("playbook.overrides_skipped", {
      businessId: business.id,
      sections: skipped.map((override) => override.section),
    });
  }
  const { document, overridden } = applyOverrides(active.document, overrides);
  return {
    segmentId: business.segment.id,
    segmentSlug: business.segment.slug,
    version: active.version,
    document,
    ...(overridden.length > 0 ? { overriddenSections: overridden } : {}),
  };
}
