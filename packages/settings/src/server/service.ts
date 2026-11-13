import { isAgencyRole, type Logger, type Role } from "@repo/core";
import {
  and,
  type BusinessContext,
  businessMemberships,
  type Database,
  type DbContext,
  eq,
  loadUserAccess,
  type UserContext,
  type UserIdentity,
} from "@repo/db";

import { isVisibleToClients } from "../access";
import { findSetting } from "../registry";
import {
  buildSettingsView,
  resolveSettings,
  type SettingsView,
  type SettingsViewer,
} from "../resolve";
import type { ScopeTarget } from "../target";
import { SettingsPermissionError } from "./errors";
import { type AppSettingsResolver, createSettingsResolver } from "./resolver";
import { loadLayers } from "./rows";
import {
  type ApplyChangesInput,
  type ApplyChangesResult,
  applySettingChanges,
  applySettingChangesAsUser,
  listSettingHistory,
  roleToward,
  type SettingHistoryEntry,
} from "./store";

/**
 * Everything the settings screen shows for a target, read inside the caller's transaction.
 * `viewer` decides which settings are listed and which are editable.
 */
export async function loadSettingsView(
  ctx: DbContext,
  target: ScopeTarget,
  viewer: SettingsViewer,
): Promise<SettingsView> {
  const { layers } = await loadLayers(ctx, target);
  return buildSettingsView(target.scope, layers, viewer);
}

export interface SettingsViewForUser extends SettingsView {
  /** The role the view was built for. */
  readonly role: Role;
}

/**
 * The settings engine for callers that hold no database context: the resolver for the
 * pipeline, and view, update and history on behalf of a signed-in user. The caller verifies
 * the session; this service works out the user's role toward the target and takes the right
 * access path:
 *
 * - agency staff act as themselves, so row-level security applies the same rules again;
 * - client users cannot reach the settings tables at all, so after the role and the
 *   business's portal permission are checked the work is done in the business's system
 *   scope, limited to the settings marked client-editable.
 */
export interface SettingsService extends AppSettingsResolver {
  viewForUser(user: UserIdentity, target: ScopeTarget): Promise<SettingsViewForUser>;
  updateForUser(user: UserIdentity, input: ApplyChangesInput): Promise<ApplyChangesResult>;
  historyForUser(
    user: UserIdentity,
    target: ScopeTarget,
    options?: { readonly key?: string; readonly limit?: number },
  ): Promise<SettingHistoryEntry[]>;
}

type ClientRole = "client_owner" | "client_staff";

export function createSettingsService(options: {
  readonly db: Database;
  readonly logger?: Logger;
}): SettingsService {
  const { db } = options;
  const resolver = createSettingsResolver(options);

  /**
   * Runs `asStaff` as the user when they are staff of the target's agency, otherwise
   * `asClient` in the business's system scope when they are a client user of the business.
   */
  async function dispatch<T>(
    user: UserIdentity,
    target: ScopeTarget,
    asStaff: (ctx: UserContext, role: Role) => Promise<T>,
    asClient: (ctx: BusinessContext, role: ClientRole) => Promise<T>,
  ): Promise<T> {
    const first = await db.asUser(user).run(async (ctx) => {
      const role = roleToward(await loadUserAccess(ctx), target);
      if (role === null) {
        throw new SettingsPermissionError("You do not have access to these settings.", {
          scope: target.scope,
        });
      }
      return isAgencyRole(role)
        ? { staff: true as const, value: await asStaff(ctx, role) }
        : { staff: false as const };
    });
    if (first.staff) return first.value;
    if (target.scope !== "business") {
      throw new SettingsPermissionError("You can only see settings of your own business.");
    }
    return db.forBusiness(target.businessId, { agencyId: target.agencyId }).run(async (ctx) => {
      // Read the membership again inside this transaction: the role must hold where the
      // work happens, not only in the transaction that looked it up.
      const [membership] = await ctx.tx
        .select({ role: businessMemberships.role })
        .from(businessMemberships)
        .where(
          and(
            eq(businessMemberships.businessId, target.businessId),
            eq(businessMemberships.userId, user.id),
          ),
        );
      if (membership === undefined) {
        throw new SettingsPermissionError("You do not have access to these settings.");
      }
      return asClient(ctx, membership.role);
    });
  }

  async function clientViewer(
    ctx: BusinessContext,
    target: ScopeTarget,
    role: ClientRole,
  ): Promise<SettingsViewer> {
    const { layers, clientPortalEnabled } = await loadLayers(ctx, target);
    if (clientPortalEnabled !== true) {
      throw new SettingsPermissionError("Client logins are switched off for this business.");
    }
    return {
      editor: { kind: "user", role },
      clientEditing: resolveSettings(layers).values["client_portal.edit_settings"],
      only: (key) => isVisibleToClients(findSetting(key) ?? { clientEditable: false }),
    };
  }

  return {
    resolve: (target) => resolver.resolve(target),

    viewForUser(user, target) {
      return dispatch(
        user,
        target,
        async (ctx, role) => ({
          ...(await loadSettingsView(ctx, target, { editor: { kind: "user", role } })),
          role,
        }),
        async (ctx, role) => ({
          ...(await loadSettingsView(ctx, target, await clientViewer(ctx, target, role))),
          role,
        }),
      );
    },

    updateForUser(user, input) {
      return dispatch(
        user,
        input.target,
        (ctx) => applySettingChangesAsUser(ctx, input),
        (ctx, role) =>
          applySettingChanges(ctx, {
            ...input,
            actor: { type: "user", userId: user.id, role, label: user.email ?? null },
          }),
      );
    },

    historyForUser(user, target, historyOptions = {}) {
      return dispatch(
        user,
        target,
        (ctx) => listSettingHistory(ctx, target, historyOptions),
        async (ctx, role) => {
          const viewer = await clientViewer(ctx, target, role);
          const entries = await listSettingHistory(ctx, target, historyOptions);
          void viewer;
          return entries.filter((entry) => {
            const definition = findSetting(entry.key);
            return definition !== undefined && isVisibleToClients(definition);
          });
        },
      );
    },
  };
}
