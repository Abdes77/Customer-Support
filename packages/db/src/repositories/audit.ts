import type { AgencyId, BusinessId, TraceId, UserId } from "@repo/core";

import type { SystemContext, UserContext } from "../context";
import { auditLog } from "../schema/tables";

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
