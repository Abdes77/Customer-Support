import type { AgencyId, BusinessId, Logger, SettingsResolver } from "@repo/core";
import type { Database, DbContext } from "@repo/db";

import type { AppSettings } from "../registry";
import { type AppResolvedSettings, resolveSettings } from "../resolve";
import { loadLayers } from "./rows";

export interface BusinessTarget {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
}

/**
 * Resolves every setting for one business inside the caller's transaction. Use this from
 * code that already holds a context (a pipeline step, a server action); use
 * `createSettingsResolver` when there is none.
 *
 * Rows that fail validation are skipped and listed in `issues`; they are also logged, by key
 * and reason only, because a skipped row means someone wrote a setting behind the store's
 * back or the registry changed under stored data.
 */
export async function loadSettings(
  ctx: DbContext,
  target: BusinessTarget,
  options: { readonly logger?: Logger } = {},
): Promise<AppResolvedSettings> {
  const { layers } = await loadLayers(ctx, { scope: "business", ...target });
  const resolved = resolveSettings(layers);
  if (resolved.issues.length > 0) {
    options.logger?.warn("settings.rows_skipped", {
      agencyId: target.agencyId,
      businessId: target.businessId,
      skipped: resolved.issues.map((issue) => ({
        key: issue.key,
        scope: issue.scope,
        reason: issue.reason,
      })),
    });
  }
  return resolved;
}

/** The resolver of this product: `SettingsResolver` from `@repo/core`, plus the skipped rows. */
export interface AppSettingsResolver extends SettingsResolver<AppSettings> {
  resolve(target: BusinessTarget): Promise<AppResolvedSettings>;
}

/**
 * A resolver that opens its own transaction in the business's system scope. A business that
 * does not belong to the agency is refused (`TenantAccessError`), an unknown one is
 * `NotFoundError`.
 *
 * Nothing is cached: a turn resolves once and keeps its snapshot, and an edit in the admin
 * panel must apply to the very next turn.
 */
export function createSettingsResolver(options: {
  readonly db: Database;
  readonly logger?: Logger;
}): AppSettingsResolver {
  const { db, logger } = options;
  return {
    resolve(target) {
      return db
        .forBusiness(target.businessId, { agencyId: target.agencyId })
        .run((ctx) => loadSettings(ctx, target, { logger }), { readOnly: true });
    },
  };
}
