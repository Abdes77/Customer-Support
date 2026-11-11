import {
  type AgencyId,
  type BusinessId,
  NotFoundError,
  type SegmentId,
  type SettingScope,
} from "@repo/core";
import {
  agencies,
  and,
  businesses,
  type DbContext,
  eq,
  or,
  segments,
  settingValues,
  type SQL,
  sql,
} from "@repo/db";

import type { SettingLayers, StoredSetting } from "../resolve";
import type { ScopeTarget } from "../target";
import { SettingsPermissionError } from "./errors";

/**
 * Reading setting rows. Everything here takes a database context, so it runs inside the
 * caller's transaction and under the caller's row-level security: as a signed-in member of
 * staff, or as the system inside one business or one agency.
 */

/**
 * The one setting whose value lives in a column: `businesses.client_portal_enabled` is read
 * by row-level security on every query of a client user, so the column is the truth. The
 * resolver reports the column's value for this key and the store writes the column whenever
 * the setting is changed (docs/DECISIONS.md, C1 #27 and C2).
 */
export const CLIENT_PORTAL_ENABLED_KEY = "client_portal.enabled";

export interface TargetFacts {
  /** The segment whose defaults apply. Null for a global target and for a business without a segment. */
  readonly segmentId: SegmentId | null;
  /** `businesses.client_portal_enabled`. Null unless the target is a business. */
  readonly clientPortalEnabled: boolean | null;
}

export interface LoadedLayers extends TargetFacts {
  readonly layers: SettingLayers;
}

/** Throws `NotFoundError` unless the target exists in the agency and the context may see it. */
export async function loadTargetFacts(ctx: DbContext, target: ScopeTarget): Promise<TargetFacts> {
  switch (target.scope) {
    case "global": {
      const [agency] = await ctx.tx
        .select({ id: agencies.id })
        .from(agencies)
        .where(eq(agencies.id, target.agencyId));
      if (agency === undefined) {
        throw new NotFoundError("Agency not found.", { details: { agencyId: target.agencyId } });
      }
      return { segmentId: null, clientPortalEnabled: null };
    }
    case "segment": {
      const [segment] = await ctx.tx
        .select({ id: segments.id })
        .from(segments)
        .where(and(eq(segments.id, target.segmentId), eq(segments.agencyId, target.agencyId)));
      if (segment === undefined) {
        throw new NotFoundError("Segment not found.", { details: { segmentId: target.segmentId } });
      }
      return { segmentId: segment.id, clientPortalEnabled: null };
    }
    case "business": {
      const [business] = await ctx.tx
        .select({
          segmentId: businesses.segmentId,
          clientPortalEnabled: businesses.clientPortalEnabled,
        })
        .from(businesses)
        .where(and(eq(businesses.id, target.businessId), eq(businesses.agencyId, target.agencyId)));
      if (business === undefined) {
        throw new NotFoundError("Business not found.", {
          details: { businessId: target.businessId },
        });
      }
      return business;
    }
  }
}

/** The predicate that selects the rows of exactly one scope target. */
export function targetRows(target: ScopeTarget): SQL {
  const inAgency = eq(settingValues.agencyId, target.agencyId);
  const where =
    target.scope === "global"
      ? and(inAgency, eq(settingValues.scope, "global"))
      : target.scope === "segment"
        ? and(
            inAgency,
            eq(settingValues.scope, "segment"),
            eq(settingValues.segmentId, target.segmentId),
          )
        : and(
            inAgency,
            eq(settingValues.scope, "business"),
            eq(settingValues.businessId, target.businessId),
          );
  return where!;
}

function chain(
  agencyId: AgencyId,
  segmentId: SegmentId | null,
  businessId: BusinessId | null,
): SQL {
  const scopes: (SQL | undefined)[] = [eq(settingValues.scope, "global")];
  if (segmentId !== null) {
    scopes.push(and(eq(settingValues.scope, "segment"), eq(settingValues.segmentId, segmentId)));
  }
  if (businessId !== null) {
    scopes.push(and(eq(settingValues.scope, "business"), eq(settingValues.businessId, businessId)));
  }
  return and(eq(settingValues.agencyId, agencyId), or(...scopes))!;
}

/**
 * Client users can see their business but none of its setting rows (row-level security
 * closes the settings tables to them). Read in their context, every setting would silently
 * resolve to its default. So a user context must be agency staff; settings for a client
 * user are read in the business's system scope, after the server has checked their role
 * (`SettingsService` does this).
 */
async function assertStaffContext(ctx: DbContext, target: ScopeTarget): Promise<void> {
  if (ctx.kind !== "user") return;
  const rows = (await ctx.tx.execute(
    sql`select ${target.agencyId}::uuid in (select app.staff_agency_ids()) as is_staff`,
  )) as unknown as readonly { is_staff: boolean }[];
  if (rows[0]?.is_staff !== true) {
    throw new SettingsPermissionError(
      "Settings can only be read as agency staff or in the system scope.",
      { scope: target.scope },
    );
  }
}

/**
 * The rows that apply at a target, by scope: the target's own rows and those of every scope
 * below it (a business gets its agency's global rows and its segment's rows).
 */
export async function loadLayers(ctx: DbContext, target: ScopeTarget): Promise<LoadedLayers> {
  await assertStaffContext(ctx, target);
  const facts = await loadTargetFacts(ctx, target);
  const rows = await ctx.tx
    .select({
      scope: settingValues.scope,
      key: settingValues.key,
      value: settingValues.value,
      version: settingValues.version,
      updatedAt: settingValues.updatedAt,
    })
    .from(settingValues)
    .where(
      chain(
        target.agencyId,
        facts.segmentId,
        target.scope === "business" ? target.businessId : null,
      ),
    )
    .orderBy(settingValues.key);

  const layers: Record<SettingScope, StoredSetting[]> = { global: [], segment: [], business: [] };
  for (const row of rows) {
    layers[row.scope].push({
      key: row.key,
      value: row.value,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  if (facts.clientPortalEnabled !== null) {
    layers.business = withColumnValue(layers.business, facts.clientPortalEnabled);
  }
  return { ...facts, layers };
}

/**
 * Replaces whatever is stored for `client_portal.enabled` with the column's value. There is
 * an override exactly when the column is on or a row was stored through the store.
 */
function withColumnValue(rows: readonly StoredSetting[], enabled: boolean): StoredSetting[] {
  const stored = rows.find((row) => row.key === CLIENT_PORTAL_ENABLED_KEY);
  const others = rows.filter((row) => row.key !== CLIENT_PORTAL_ENABLED_KEY);
  if (stored === undefined && !enabled) return others;
  return [
    ...others,
    {
      key: CLIENT_PORTAL_ENABLED_KEY,
      value: enabled,
      version: stored?.version ?? null,
      updatedAt: stored?.updatedAt ?? null,
    },
  ];
}
