import { z } from "zod";

import {
  AgencyId,
  BusinessId,
  NotFoundError,
  SegmentId,
  TenantAccessError,
  ValidationError,
} from "@repo/core";
import {
  type Database,
  eq,
  getVisibleBusiness,
  segments,
  type UserAccess,
  type UserIdentity,
} from "@repo/db";
import { findSetting, type ScopeTarget } from "@repo/settings";
import { SettingsConflictError, type SettingsService } from "@repo/settings/server";

import { type SettingsScreenView, toScreenView } from "./settings-view";

/*
 * What the settings screen's server actions do, without Next.js around them, so it can be
 * tested against a real database. The browser names a target by what it sees (a business,
 * a segment, the agency); the scope target with its agency is always worked out here from
 * what the signed-in user may see, never taken from the request.
 */

export interface AdminSession {
  readonly user: UserIdentity;
  readonly access: UserAccess;
}

export const ScreenTarget = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("global"), agencyId: AgencyId }),
  z.strictObject({ scope: z.literal("segment"), segmentId: SegmentId }),
  z.strictObject({ scope: z.literal("business"), businessId: BusinessId }),
]);
export type ScreenTarget = z.infer<typeof ScreenTarget>;

const Version = z.number().int().positive().nullable();
const Key = z.string().min(1).max(200);

export const SaveSettingInput = z.strictObject({
  target: ScreenTarget,
  key: Key,
  value: z.json(),
  expectedVersion: Version,
});
export const ResetSettingInput = z.strictObject({
  target: ScreenTarget,
  key: Key,
  expectedVersion: Version,
});
export const AddEntryInput = z.strictObject({
  target: ScreenTarget,
  key: Key,
  entry: z.json(),
  expectedVersion: Version,
});
export const RemoveEntryInput = z.strictObject({
  target: ScreenTarget,
  key: Key,
  index: z.number().int().min(0).max(1000),
  expectedVersion: Version,
});

export interface AdminSettingsDeps {
  readonly db: Database;
  readonly settings: SettingsService;
}

export function createAdminSettings(deps: AdminSettingsDeps) {
  const { db, settings } = deps;

  async function resolveTarget(session: AdminSession, target: ScreenTarget): Promise<ScopeTarget> {
    switch (target.scope) {
      case "business": {
        const business = await db
          .asUser(session.user)
          .run((ctx) => getVisibleBusiness(ctx, target.businessId));
        if (business === null) throw new NotFoundError("Business not found.");
        return { scope: "business", agencyId: business.agencyId, businessId: business.id };
      }
      case "segment": {
        const [segment] = await db
          .asUser(session.user)
          .run(({ tx }) =>
            tx
              .select({ id: segments.id, agencyId: segments.agencyId })
              .from(segments)
              .where(eq(segments.id, target.segmentId))
              .limit(1),
          );
        if (segment === undefined) throw new NotFoundError("Segment not found.");
        return { scope: "segment", agencyId: segment.agencyId, segmentId: segment.id };
      }
      case "global": {
        if (!session.access.agencies.some((agency) => agency.agencyId === target.agencyId)) {
          throw new TenantAccessError("You do not have access to this agency.");
        }
        return { scope: "global", agencyId: target.agencyId };
      }
    }
  }

  async function view(session: AdminSession, target: ScreenTarget): Promise<SettingsScreenView> {
    const scope = await resolveTarget(session, target);
    return toScreenView(await settings.viewForUser(session.user, scope));
  }

  /** The value in force at the target and the target's own override version, on the server. */
  async function current(session: AdminSession, scope: ScopeTarget, key: string) {
    const full = await settings.viewForUser(session.user, scope);
    const entry = full.entries.find((candidate) => candidate.key === key);
    if (entry === undefined) throw new NotFoundError("That setting is not available here.");
    return entry;
  }

  function listOf(key: string): { readonly maxItems: number } {
    const definition = findSetting(key);
    if (definition?.field.kind !== "list") {
      throw new ValidationError("That setting is not a list.");
    }
    return { maxItems: definition.field.maxItems };
  }

  return {
    resolveTarget,
    view,

    async save(session: AdminSession, input: z.infer<typeof SaveSettingInput>) {
      const scope = await resolveTarget(session, input.target);
      return settings.updateForUser(session.user, {
        target: scope,
        changes: [{ key: input.key, value: input.value, expectedVersion: input.expectedVersion }],
      });
    },

    async reset(session: AdminSession, input: z.infer<typeof ResetSettingInput>) {
      const scope = await resolveTarget(session, input.target);
      return settings.updateForUser(session.user, {
        target: scope,
        changes: [{ key: input.key, reset: true, expectedVersion: input.expectedVersion }],
      });
    },

    /**
     * Adds one entry to a list setting. For a sensitive list this is how an entry is added
     * without the browser ever holding the others: the server reads the list in force and
     * stores it with the new entry as this scope's override.
     */
    async addEntry(session: AdminSession, input: z.infer<typeof AddEntryInput>) {
      const scope = await resolveTarget(session, input.target);
      const { maxItems } = listOf(input.key);
      const entry = await current(session, scope, input.key);
      const ownVersion = entry.override?.version ?? null;
      if (ownVersion !== input.expectedVersion) {
        throw new SettingsConflictError("Someone changed this list meanwhile. Reload the page.");
      }
      const list: unknown[] = Array.isArray(entry.value) ? (entry.value as unknown[]) : [];
      if (list.length >= maxItems) {
        throw new ValidationError(`This list holds at most ${maxItems} entries.`);
      }
      return settings.updateForUser(session.user, {
        target: scope,
        changes: [
          { key: input.key, value: [...list, input.entry], expectedVersion: input.expectedVersion },
        ],
      });
    },

    /** Removes the entry at `index` of the list in force (masked on screen, so by position). */
    async removeEntry(session: AdminSession, input: z.infer<typeof RemoveEntryInput>) {
      const scope = await resolveTarget(session, input.target);
      listOf(input.key);
      const entry = await current(session, scope, input.key);
      const ownVersion = entry.override?.version ?? null;
      if (ownVersion !== input.expectedVersion) {
        throw new SettingsConflictError("Someone changed this list meanwhile. Reload the page.");
      }
      const list: unknown[] = Array.isArray(entry.value) ? (entry.value as unknown[]) : [];
      if (input.index >= list.length) throw new NotFoundError("That entry no longer exists.");
      return settings.updateForUser(session.user, {
        target: scope,
        changes: [
          {
            key: input.key,
            value: list.filter((_, index) => index !== input.index),
            expectedVersion: input.expectedVersion,
          },
        ],
      });
    },

    /** One entry of a list in force, on the server, for those who may change the list. */
    async entryAt(session: AdminSession, target: ScreenTarget, key: string, index: number) {
      const scope = await resolveTarget(session, target);
      listOf(key);
      const entry = await current(session, scope, key);
      if (!entry.editable) {
        throw new TenantAccessError("You cannot use this contact list.");
      }
      const list = Array.isArray(entry.value) ? (entry.value as unknown[]) : [];
      const value = list[index];
      if (value === undefined) throw new NotFoundError("That entry no longer exists.");
      return { scope, value };
    },
  };
}

export type AdminSettings = ReturnType<typeof createAdminSettings>;
