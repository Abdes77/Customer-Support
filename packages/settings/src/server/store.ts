import {
  isAgencyRole,
  type Role,
  type SettingScope,
  type TraceId,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  agencyRoleOf,
  and,
  asc,
  type AuditEntry,
  businesses,
  businessRoleOf,
  type DbContext,
  desc,
  eq,
  inArray,
  loadUserAccess,
  max,
  recordSystemAudit,
  recordUserAudit,
  settingValues,
  settingVersions,
  type SQL,
  sql,
  type SystemContext,
  type UserAccess,
  type UserContext,
} from "@repo/db";

import { type EditDenial, settingEditDenial, type SettingsEditor } from "../access";
import { ALL_SCOPES, type SettingDefinition } from "../define";
import type { FieldProblem } from "../fields";
import { jsonEqual } from "../hash";
import { type ClientPermission, findSetting } from "../registry";
import { resolveSettings } from "../resolve";
import { describeTarget, type ScopeTarget, type SettingChange } from "../target";
import { checkSettingValue, type SettingIssueReason } from "../validate";
import { SettingsConflictError, SettingsPermissionError } from "./errors";
import { CLIENT_PORTAL_ENABLED_KEY, loadLayers, loadTargetFacts, targetRows } from "./rows";

/**
 * The store: the only code that writes settings.
 *
 * A call applies a list of changes to one scope target, all or nothing:
 *   1. every change is checked first: the editor may make it (`../access.ts`), the setting
 *      allows the scope, the value passes the setting's schema;
 *   2. writers of the same target are serialized with an advisory lock;
 *   3. each change that actually changes something gets the next version number of its key,
 *      a row in `setting_versions` (append-only history) and an entry in the audit log,
 *      in the same transaction as the change itself.
 *
 * Call it inside the caller's `run()`: `applySettingChangesAsUser` in a user context (agency
 * staff; row-level security checks the same rules again) or `applySettingChanges` in a
 * system context (jobs, imports, onboarding, and the checked writes of client users, who
 * have no row-level access to these tables). `SettingsService` picks the right one for a
 * signed-in user.
 */

/** What was wrong with one submitted change. Safe to show next to its control. */
export interface SettingChangeProblem {
  readonly key: string;
  readonly reason: SettingIssueReason;
  readonly message: string;
  readonly problems: readonly FieldProblem[];
}

/** Who makes a change through the system context. */
export type SettingsActor =
  /** A signed-in user whose request the server carries out. `role` is their role toward the target. */
  | {
      readonly type: "user";
      readonly userId: UserId;
      readonly role: Role;
      readonly label?: string | null;
    }
  /** A job, the onboarding flow, a seed. `label` names it in the audit log. */
  | { readonly type: "system"; readonly label: string }
  | { readonly type: "api_key"; readonly label: string };

export interface ApplyChangesInput {
  readonly target: ScopeTarget;
  readonly changes: readonly SettingChange[];
  /** Why, in the editor's words. Stored with every history row of this call. */
  readonly note?: string;
  readonly traceId?: TraceId;
}

export interface AppliedChange {
  readonly key: string;
  /** "unchanged": the value was already in force, or there was nothing to reset. Nothing was written. */
  readonly operation: "set" | "reset" | "unchanged";
  /** The version the key has at this target after the call. Null when it has no override and never had one. */
  readonly version: number | null;
}

export interface ApplyChangesResult {
  readonly target: ScopeTarget;
  readonly applied: readonly AppliedChange[];
}

const MAX_CHANGES = 200;
const HIDDEN = "[hidden: sensitive setting, see its history]";

interface Writer {
  readonly editor: SettingsEditor;
  readonly userId: UserId | null;
  readonly audit: (entry: AuditEntry) => Promise<void>;
}

/** A key that is stored but no longer declared: only staff may clean it up. */
function undeclared(key: string): Pick<SettingDefinition, "label" | "scopes" | "clientEditable"> {
  return { label: key, scopes: ALL_SCOPES, clientEditable: false };
}

function targetColumns(target: ScopeTarget) {
  return {
    agencyId: target.agencyId,
    scope: target.scope,
    segmentId: target.scope === "segment" ? target.segmentId : null,
    businessId: target.scope === "business" ? target.businessId : null,
  };
}

function targetId(target: ScopeTarget): string {
  switch (target.scope) {
    case "global":
      return target.agencyId;
    case "segment":
      return target.segmentId;
    case "business":
      return target.businessId;
  }
}

function historyRows(target: ScopeTarget): SQL {
  const inAgency = eq(settingVersions.agencyId, target.agencyId);
  const where =
    target.scope === "global"
      ? and(inAgency, eq(settingVersions.scope, "global"))
      : target.scope === "segment"
        ? and(
            inAgency,
            eq(settingVersions.scope, "segment"),
            eq(settingVersions.segmentId, target.segmentId),
          )
        : and(
            inAgency,
            eq(settingVersions.scope, "business"),
            eq(settingVersions.businessId, target.businessId),
          );
  return where!;
}

/** A system scope may only write the tenant it entered. Row-level security agrees; this fails earlier and clearer. */
function assertTargetInScope(ctx: SystemContext, target: ScopeTarget): void {
  const sameAgency = ctx.tenant.agencyId === target.agencyId;
  const sameBusiness =
    ctx.kind === "agency" ||
    (target.scope === "business" && target.businessId === ctx.tenant.businessId);
  if (!sameAgency || !sameBusiness) {
    throw new SettingsPermissionError("These settings are outside the scope of this operation.", {
      scope: target.scope,
    });
  }
}

/** The user's role toward a target: their agency role, else their role in the target business. */
export function roleToward(access: UserAccess, target: ScopeTarget): Role | null {
  if (target.scope === "business") {
    return businessRoleOf(access, { businessId: target.businessId, agencyId: target.agencyId });
  }
  return agencyRoleOf(access, target.agencyId);
}

type Planned =
  | {
      readonly kind: "set";
      readonly change: SettingChange;
      readonly value: unknown;
      readonly definition: SettingDefinition;
    }
  | {
      readonly kind: "reset";
      readonly change: SettingChange;
      readonly definition: SettingDefinition | undefined;
    };

function denied(denial: EditDenial, key: string): SettingsPermissionError {
  return new SettingsPermissionError(denial.message, { key, reason: denial.reason });
}

async function write(
  ctx: DbContext,
  input: ApplyChangesInput,
  writer: Writer,
): Promise<ApplyChangesResult> {
  const { target, changes } = input;
  if (changes.length === 0) return { target, applied: [] };
  if (changes.length > MAX_CHANGES) {
    throw new ValidationError(`At most ${MAX_CHANGES} settings can be changed at once.`);
  }
  const keys = changes.map((change) => change.key);
  if (new Set(keys).size !== keys.length) {
    throw new ValidationError("A setting appears more than once in this change.");
  }
  if (input.note !== undefined && input.note.length > 500) {
    throw new ValidationError("The note is too long (500 characters at most).");
  }
  // PostgreSQL text and jsonb cannot hold U+0000; refuse it instead of failing the write.
  if ([...keys, input.note ?? ""].some((text) => text.includes("\u0000"))) {
    throw new ValidationError("The change contains a character that cannot be saved.");
  }

  const facts = await loadTargetFacts(ctx, target);

  // Client users edit under their business's own permission setting.
  let clientEditing: ClientPermission | undefined;
  if (writer.editor.kind === "user" && !isAgencyRole(writer.editor.role)) {
    if (target.scope !== "business" || facts.clientPortalEnabled !== true) {
      throw new SettingsPermissionError("You can only change settings of your own business.", {
        scope: target.scope,
      });
    }
    const { layers } = await loadLayers(ctx, target);
    clientEditing = resolveSettings(layers).values["client_portal.edit_settings"];
  }

  // 1. Check everything before writing anything.
  const planned: Planned[] = [];
  const problems: SettingChangeProblem[] = [];
  for (const change of changes) {
    const definition = findSetting(change.key);
    const isReset = "reset" in change;
    const denial = settingEditDenial({
      setting: definition ?? undeclared(change.key),
      scope: target.scope,
      editor: writer.editor,
      clientEditing,
      operation: isReset ? "reset" : "set",
    });
    // "Not at this scope" is a property of the setting, reported with the other validation
    // problems below; everything else is the editor overstepping.
    if (denial !== null && denial.reason !== "scope_not_allowed") throw denied(denial, change.key);
    if (isReset) {
      planned.push({ kind: "reset", change, definition });
      continue;
    }
    const checked = checkSettingValue(change.key, change.value, target.scope);
    if (!checked.ok) {
      problems.push({
        key: change.key,
        reason: checked.reason,
        message: checked.message,
        problems: checked.problems,
      });
      continue;
    }
    planned.push({ kind: "set", change, value: checked.value, definition: checked.definition });
  }
  if (problems.length > 0) {
    throw new ValidationError(
      problems.length === 1
        ? (problems[0]?.message ?? "A setting could not be saved.")
        : `${problems.length} settings could not be saved. Nothing was changed.`,
      { details: { problems } },
    );
  }

  // 2. One writer per target at a time, so version numbers never collide.
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`settings:${target.scope}:${targetId(target)}`}, 0))`,
  );
  // When this call's changes happen: read now, holding the lock, so the times of a target's
  // changes follow their version order. The columns' default, `now()`, is when the
  // transaction began, which can be before an earlier writer released the lock.
  const [clock] = await ctx.tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
  const changedAt = sql`${clock!.at}::timestamptz`;

  // 3. Where each key stands now.
  const currentRows = await ctx.tx
    .select({
      id: settingValues.id,
      key: settingValues.key,
      value: settingValues.value,
      version: settingValues.version,
    })
    .from(settingValues)
    .where(and(targetRows(target), inArray(settingValues.key, keys)));
  const current = new Map(currentRows.map((row) => [row.key, row]));
  const lastRows = await ctx.tx
    .select({ key: settingVersions.key, last: max(settingVersions.version) })
    .from(settingVersions)
    .where(and(historyRows(target), inArray(settingVersions.key, keys)))
    .groupBy(settingVersions.key);
  const lastVersion = new Map(lastRows.map((row) => [row.key, row.last ?? 0]));

  const applied: AppliedChange[] = [];
  for (const plan of planned) {
    const { key } = plan.change;
    const row = current.get(key);
    const highest = Math.max(lastVersion.get(key) ?? 0, row?.version ?? 0);
    const { expectedVersion } = plan.change;
    if (expectedVersion !== undefined && expectedVersion !== (row?.version ?? null)) {
      throw new SettingsConflictError(
        `"${plan.definition?.label ?? key}" was changed by someone else in the meantime. Reload and try again.`,
        { key, expectedVersion, currentVersion: row?.version ?? null },
      );
    }

    const columnBacked = key === CLIENT_PORTAL_ENABLED_KEY && target.scope === "business";
    if (plan.kind === "reset") {
      if (row === undefined && !(columnBacked && facts.clientPortalEnabled === true)) {
        applied.push({ key, operation: "unchanged", version: highest === 0 ? null : highest });
        continue;
      }
    } else if (
      row !== undefined &&
      jsonEqual(row.value, plan.value) &&
      !(columnBacked && facts.clientPortalEnabled !== plan.value)
    ) {
      applied.push({ key, operation: "unchanged", version: row.version });
      continue;
    }

    const version = highest + 1;
    const previous = row?.value ?? null;
    const value = plan.kind === "set" ? plan.value : null;

    if (plan.kind === "reset") {
      if (row !== undefined) await ctx.tx.delete(settingValues).where(eq(settingValues.id, row.id));
    } else if (row === undefined) {
      await ctx.tx.insert(settingValues).values({
        ...targetColumns(target),
        key,
        value,
        version,
        updatedBy: writer.userId,
        updatedAt: changedAt,
      });
    } else {
      await ctx.tx
        .update(settingValues)
        .set({ value, version, updatedBy: writer.userId, updatedAt: changedAt })
        .where(eq(settingValues.id, row.id));
    }

    await ctx.tx.insert(settingVersions).values({
      ...targetColumns(target),
      key,
      version,
      operation: plan.kind,
      value,
      previousValue: previous,
      changedBy: writer.userId,
      changeNote: input.note ?? null,
      createdAt: changedAt,
    });

    if (columnBacked) {
      // The column is what row-level security reads; keep it equal to the setting.
      const enabled = plan.kind === "set" ? plan.value === true : false;
      await ctx.tx
        .update(businesses)
        .set({ clientPortalEnabled: enabled })
        .where(eq(businesses.id, target.businessId));
    }

    const label = plan.definition?.label ?? key;
    const sensitive = plan.definition?.sensitive ?? false;
    await writer.audit({
      action: plan.kind === "set" ? "settings.set" : "settings.reset",
      targetType: "setting",
      targetId: key,
      summary: `${plan.kind === "set" ? "Changed" : "Reset"} "${label}" for ${describeTarget(target)}.`,
      before: sensitive ? HIDDEN : previous,
      after: sensitive ? HIDDEN : value,
      metadata: {
        scope: target.scope,
        segmentId: target.scope === "segment" ? target.segmentId : null,
        version,
        note: input.note ?? null,
      },
      traceId: input.traceId,
    });

    applied.push({ key, operation: plan.kind, version });
  }

  return { target, applied };
}

/**
 * Applies changes as the signed-in user of the context. The user must be staff of the
 * target's agency: an admin for agency-wide and segment settings, any staff for a business.
 * Row-level security enforces the same, and records the user as the author.
 *
 * Throws `SettingsPermissionError`, `ValidationError` (with `details.problems`, one entry
 * per rejected change), `SettingsConflictError` or `NotFoundError`. On any error nothing is
 * written, provided the caller lets the error leave its `run()`.
 */
export async function applySettingChangesAsUser(
  ctx: UserContext,
  input: ApplyChangesInput,
): Promise<ApplyChangesResult> {
  const role = roleToward(await loadUserAccess(ctx), input.target);
  if (role === null || !isAgencyRole(role)) {
    throw new SettingsPermissionError("You do not have access to these settings.", {
      scope: input.target.scope,
    });
  }
  const { target } = input;
  return write(ctx, input, {
    editor: { kind: "user", role },
    userId: ctx.user.id,
    audit: (entry) =>
      recordUserAudit(
        ctx,
        {
          agencyId: target.agencyId,
          businessId: target.scope === "business" ? target.businessId : null,
        },
        entry,
      ),
  });
}

/**
 * Applies changes inside a system context: for jobs and server flows (`actor.type`
 * "system" or "api_key"), and for a signed-in user whose request the server carries out
 * (`actor.type` "user"). The caller must have verified a user actor's role; the store then
 * applies the role's rules, including the client-editable flag for client users.
 *
 * The target must be inside the context: a business scope writes only its own business.
 */
export async function applySettingChanges(
  ctx: SystemContext,
  input: ApplyChangesInput & { readonly actor: SettingsActor },
): Promise<ApplyChangesResult> {
  assertTargetInScope(ctx, input.target);
  const { actor } = input;
  return write(ctx, input, {
    editor: actor.type === "user" ? { kind: "user", role: actor.role } : { kind: "system" },
    userId: actor.type === "user" ? actor.userId : null,
    audit: (entry) => recordSystemAudit(ctx, actor, entry),
  });
}

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

export interface SettingHistoryEntry {
  readonly key: string;
  readonly scope: SettingScope;
  readonly version: number;
  readonly operation: "set" | "reset";
  /** The value set; null for a reset. */
  readonly value: unknown;
  readonly previousValue: unknown;
  /** Null when a job made the change, or the user was deleted since. */
  readonly changedBy: UserId | null;
  readonly note: string | null;
  /** ISO 8601. */
  readonly changedAt: string;
}

/**
 * The history of one target, newest first: of one setting when `key` is given, otherwise of
 * all of them. To roll a setting back, apply a change with the `value` of an older entry.
 *
 * One setting's history is ordered by version, which the advisory lock in `write` hands out
 * in the order the changes were made. Across settings, versions do not compare, so the
 * order is by the time each change was written (read under the same lock), then by key.
 */
export async function listSettingHistory(
  ctx: DbContext,
  target: ScopeTarget,
  options: { readonly key?: string; readonly limit?: number } = {},
): Promise<SettingHistoryEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = await ctx.tx
    .select({
      key: settingVersions.key,
      scope: settingVersions.scope,
      version: settingVersions.version,
      operation: settingVersions.operation,
      value: settingVersions.value,
      previousValue: settingVersions.previousValue,
      changedBy: settingVersions.changedBy,
      changeNote: settingVersions.changeNote,
      createdAt: settingVersions.createdAt,
    })
    .from(settingVersions)
    .where(
      options.key === undefined
        ? historyRows(target)
        : and(historyRows(target), eq(settingVersions.key, options.key)),
    )
    .orderBy(
      ...(options.key === undefined
        ? [desc(settingVersions.createdAt), asc(settingVersions.key), desc(settingVersions.version)]
        : [desc(settingVersions.version)]),
    )
    .limit(limit);
  return rows.map((row) => ({
    key: row.key,
    scope: row.scope,
    version: row.version,
    operation: row.operation,
    value: row.value,
    previousValue: row.previousValue,
    changedBy: row.changedBy,
    note: row.changeNote,
    changedAt: row.createdAt.toISOString(),
  }));
}
