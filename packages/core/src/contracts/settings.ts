import type { AgencyId, BusinessId, IsoDateTime } from "../ids";

/**
 * Settings resolver contract (owner: C2, package `@repo/settings`).
 *
 * Every tunable behaviour is a declared setting. Values resolve in this order, later wins:
 * registry default, agency-wide ("global") override, segment default, business override.
 * Consumers never read setting rows themselves; they ask the resolver and get typed values
 * plus where each value came from.
 */

export const SETTING_SCOPES = ["global", "segment", "business"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/** Where a resolved value came from. "default" is the value declared in the registry. */
export interface SettingSource {
  readonly scope: SettingScope | "default";
  /** Version of the stored override that supplied the value; null for registry defaults. */
  readonly version: number | null;
  readonly updatedAt: IsoDateTime | null;
}

/**
 * A resolved snapshot. `@repo/settings` exports the concrete `TValues` (one property per
 * setting key); core only knows the shape.
 */
export interface ResolvedSettings<
  TValues extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly values: Readonly<TValues>;
  readonly sources: Readonly<Record<keyof TValues & string, SettingSource>>;
  /** Stable hash of `values`. Recorded on every turn and model call for audits and evals. */
  readonly version: string;
}

export interface SettingsResolver<
  TValues extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Resolves every setting for one business. The business must belong to the agency. */
  resolve(target: {
    readonly agencyId: AgencyId;
    readonly businessId: BusinessId;
  }): Promise<ResolvedSettings<TValues>>;
}
