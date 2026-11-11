import type { SegmentId } from "@repo/core";
import { type AgencyContext, settingValues } from "@repo/db";

import { segmentPresetFor, type SegmentPresetId } from "../presets";
import type { ScopeTarget } from "../target";
import { targetRows } from "./rows";
import { type AppliedChange, applySettingChanges, type SettingsActor } from "./store";

export interface AppliedPreset {
  /** The preset that matched the slug, or null when the trade has none. */
  readonly preset: SegmentPresetId | null;
  readonly applied: readonly AppliedChange[];
}

/**
 * Gives a segment its recommended starting values (`SEGMENT_PRESETS`), as ordinary segment
 * overrides: validated, versioned and audited like any other change, and free to be edited
 * or reset afterwards. Call it once, when a segment is first served (C6 does, next to
 * generating the segment's playbook).
 *
 * It never overwrites: a setting that already has a segment override keeps it, so calling
 * it again is harmless.
 */
export async function applySegmentPreset(
  ctx: AgencyContext,
  input: {
    readonly segmentId: SegmentId;
    /** The segment's slug, for example "roofing" or "kitchen-bath-remodeling". */
    readonly slug: string;
    readonly actor?: SettingsActor;
  },
): Promise<AppliedPreset> {
  const match = segmentPresetFor(input.slug);
  if (match === null) return { preset: null, applied: [] };

  const target: ScopeTarget = {
    scope: "segment",
    agencyId: ctx.tenant.agencyId,
    segmentId: input.segmentId,
  };
  const existing = await ctx.tx
    .select({ key: settingValues.key })
    .from(settingValues)
    .where(targetRows(target));
  const taken = new Set(existing.map((row) => row.key));
  const changes = Object.entries(match.preset)
    .filter(([key]) => !taken.has(key))
    .map(([key, value]) => ({ key, value }));

  const result = await applySettingChanges(ctx, {
    target,
    changes,
    actor: input.actor ?? { type: "system", label: "segment-preset" },
    note: `Starting values for ${match.id}`,
  });
  return { preset: match.id, applied: result.applied };
}
