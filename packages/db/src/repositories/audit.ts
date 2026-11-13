import { and, desc, eq, sql } from "drizzle-orm";

import type { AgencyId, BusinessId, TraceId, UserId } from "@repo/core";

import type { SystemContext, UserContext } from "../context";
import { auditLog, businesses, users } from "../schema/tables";

/**
 * Writing the audit log. Call these in the same `run()` as the change they describe, so the
 * change and its record commit or roll back together.
 *
 * Never put a secret or a decrypted credential in `before`, `after` or `metadata`.
 */
export interface AuditEntry {
  /** `area.verb`, for example "settings.update" or "business.create". */
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** One line a person can read in the audit log viewer. */
  readonly summary?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly traceId?: TraceId;
}

export type AuditActor =
  | { readonly type: "user"; readonly userId: UserId; readonly label?: string | null }
  | { readonly type: "system"; readonly label: string }
  | { readonly type: "api_key"; readonly label: string };

function columns(entry: AuditEntry) {
  return {
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    summary: entry.summary ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    metadata: entry.metadata ?? {},
    traceId: entry.traceId ?? null,
  };
}

/**
 * Records something the signed-in user did. The actor is always the user of the context:
 * row-level security refuses an entry under any other name, or for an agency the user is
 * not staff of.
 */
export async function recordUserAudit(
  ctx: UserContext,
  tenant: { readonly agencyId: AgencyId; readonly businessId?: BusinessId | null },
  entry: AuditEntry,
): Promise<void> {
  await ctx.tx.insert(auditLog).values({
    agencyId: tenant.agencyId,
    businessId: tenant.businessId ?? null,
    actorType: "user",
    actorUserId: ctx.user.id,
    actorLabel: ctx.user.email ?? null,
    ...columns(entry),
  });
}

/**
 * Records something done through the system scope: by a job (`{ type: "system" }`), by an
 * API key, or by a user whose request the server carried out in the system scope.
 */
export async function recordSystemAudit(
  ctx: SystemContext,
  actor: AuditActor,
  entry: AuditEntry,
): Promise<void> {
  await ctx.tx.insert(auditLog).values({
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.kind === "business" ? ctx.tenant.businessId : null,
    actorType: actor.type,
    actorUserId: actor.type === "user" ? actor.userId : null,
    actorLabel: actor.label ?? null,
    ...columns(entry),
  });
}

/** Field names whose values the audit log viewer never shows, wherever they appear. */
const HIDDEN_FIELD =
  /secret|token|password|passwd|apikey|api_key|ciphertext|credential|pin$|authorization/i;

/**
 * Replaces values under secret-sounding field names with "[hidden]", at any depth. Writers
 * must never put a secret in an entry; this is the viewer's second line of defence.
 */
export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = HIDDEN_FIELD.test(key) ? "[hidden]" : redactAuditValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditRow {
  readonly id: string;
  readonly createdAt: string;
  readonly agencyId: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly actorType: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  /**
   * For an entry about a person (people management, C18): their email while the reader can
   * still see the person (row-level security on profiles), otherwise null. Entries store the
   * user id only.
   */
  readonly targetName: string | null;
  readonly summary: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * The audit log as the signed-in user may read it: row-level security lets agency admins read
 * their agency's entries and nobody else any. Newest first; values under secret-sounding names
 * are hidden (`redactAuditValue`).
 */
export async function listAuditLog(
  ctx: UserContext,
  filter: {
    readonly agencyId?: AgencyId;
    readonly businessId?: BusinessId | null;
    readonly action?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<{ readonly rows: readonly AuditRow[]; readonly more: boolean }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const where = [];
  if (filter.agencyId !== undefined) where.push(eq(auditLog.agencyId, filter.agencyId));
  if (filter.businessId != null) where.push(eq(auditLog.businessId, filter.businessId));
  if (filter.action !== undefined && filter.action !== "") {
    where.push(
      sql`${auditLog.action} like ${`${filter.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`,
    );
  }
  const rows = await ctx.tx
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      agencyId: auditLog.agencyId,
      businessId: auditLog.businessId,
      businessName: sql<
        string | null
      >`(select b.name from ${businesses} b where b.id = ${auditLog.businessId})`,
      actorType: auditLog.actorType,
      actorName: sql<
        string | null
      >`coalesce((select coalesce(u.full_name, u.email) from ${users} u where u.id = ${auditLog.actorUserId}), ${auditLog.actorLabel})`,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      targetName: sql<
        string | null
      >`(select u.email from ${users} u where ${auditLog.targetType} = 'user' and u.id::text = ${auditLog.targetId})`,
      summary: auditLog.summary,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1)
    .offset(Math.max(filter.offset ?? 0, 0));
  return {
    more: rows.length > limit,
    rows: rows.slice(0, limit).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      before: redactAuditValue(row.before),
      after: redactAuditValue(row.after),
    })),
  };
}
