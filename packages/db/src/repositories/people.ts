import { and, asc, eq, ne, sql } from "drizzle-orm";

import {
  type AgencyId,
  type AGENCY_ROLES,
  type BusinessId,
  type CLIENT_ROLES,
  ValidationError,
  type UserId,
} from "@repo/core";

import type { BusinessContext, UserContext } from "../context";
import { pgConstraintName } from "../errors";
import { agencyMemberships, businessMemberships, users } from "../schema/tables";
import { recordSystemAudit, recordUserAudit } from "./audit";

/*
 * Who has access (C18, people management): the membership rows of an agency (agency_admin,
 * agency_member) and of a business (client_owner, client_staff), read and written as the
 * signed-in person under row-level security. Every grant, role change and removal writes an
 * audit entry in the same transaction, with the person who did it as the actor and the
 * affected user by id only: no email address goes into the entry.
 *
 * The rules the database enforces on its own (migration 0016): only agency admins write as a
 * user, never their own row, and an agency always keeps one agency_admin. The caller (the
 * people service in apps/web) decides everything finer, such as which roles a person may give.
 *
 * Client logins can also be written in a business's system scope: that is the path for a
 * client owner who may manage their staff (`client_portal.owner_manages_staff`), after the
 * server checked it. No client user writes these tables directly.
 */

export type AgencyRoleName = (typeof AGENCY_ROLES)[number];
export type ClientRoleName = (typeof CLIENT_ROLES)[number];

/** Raised by the trigger of migration 0016. */
export const LAST_ADMIN_CONSTRAINT = "agency_memberships_last_admin";
export const LAST_ADMIN_MESSAGE =
  "An agency needs at least one agency admin. Make someone else an admin first.";

export interface PersonView<R extends string = string> {
  readonly userId: UserId;
  readonly email: string;
  readonly role: R;
  /** When the access was granted. */
  readonly since: string;
}

/** Who did it, for the audit entry of a change made in a system scope. */
export interface PeopleActor {
  readonly userId: UserId;
  readonly label: string | null;
}

/** The agency's staff, admins first, then by email. Staff of the agency see it. */
export async function listAgencyPeople(
  ctx: UserContext,
  agencyId: AgencyId,
): Promise<readonly PersonView<AgencyRoleName>[]> {
  const rows = await ctx.tx
    .select({
      userId: agencyMemberships.userId,
      email: users.email,
      role: agencyMemberships.role,
      since: agencyMemberships.createdAt,
    })
    .from(agencyMemberships)
    .innerJoin(users, eq(users.id, agencyMemberships.userId))
    .where(eq(agencyMemberships.agencyId, agencyId))
    .orderBy(asc(agencyMemberships.role), asc(sql`lower(${users.email})`));
  return rows.map((row) => ({ ...row, since: row.since.toISOString() }));
}

/** The business's client logins, owners first, then by email. */
export async function listBusinessPeople(
  ctx: UserContext | BusinessContext,
  businessId: BusinessId,
): Promise<readonly PersonView<ClientRoleName>[]> {
  const rows = await ctx.tx
    .select({
      userId: businessMemberships.userId,
      email: users.email,
      role: businessMemberships.role,
      since: businessMemberships.createdAt,
    })
    .from(businessMemberships)
    .innerJoin(users, eq(users.id, businessMemberships.userId))
    .where(eq(businessMemberships.businessId, businessId))
    .orderBy(asc(businessMemberships.role), asc(sql`lower(${users.email})`));
  return rows.map((row) => ({ ...row, since: row.since.toISOString() }));
}

/** The agency role of a user, as the caller can see it, or null. */
export async function findAgencyRole(
  ctx: UserContext,
  agencyId: AgencyId,
  userId: UserId,
): Promise<AgencyRoleName | null> {
  const rows = await ctx.tx
    .select({ role: agencyMemberships.role })
    .from(agencyMemberships)
    .where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/** The client role of a user at a business, as the caller can see it, or null. */
export async function findBusinessRole(
  ctx: UserContext | BusinessContext,
  businessId: BusinessId,
  userId: UserId,
): Promise<ClientRoleName | null> {
  const rows = await ctx.tx
    .select({ role: businessMemberships.role })
    .from(businessMemberships)
    .where(
      and(eq(businessMemberships.businessId, businessId), eq(businessMemberships.userId, userId)),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

/** Turns the last-admin trigger's error into a sentence; other errors pass through. */
export function explainMembershipError(error: unknown): unknown {
  if (pgConstraintName(error) === LAST_ADMIN_CONSTRAINT) {
    return new ValidationError(LAST_ADMIN_MESSAGE, { cause: error });
  }
  return error;
}

async function auditAgency(
  ctx: UserContext,
  agencyId: AgencyId,
  entry: { action: string; userId: UserId; summary: string; before?: unknown; after?: unknown },
): Promise<void> {
  await recordUserAudit(
    ctx,
    { agencyId },
    {
      action: entry.action,
      targetType: "user",
      targetId: entry.userId,
      summary: entry.summary,
      before: entry.before,
      after: entry.after,
    },
  );
}

async function auditBusiness(
  ctx: UserContext | BusinessContext,
  tenant: { readonly agencyId: AgencyId; readonly businessId: BusinessId },
  actor: PeopleActor | null,
  entry: { action: string; userId: UserId; summary: string; before?: unknown; after?: unknown },
): Promise<void> {
  const record = {
    action: entry.action,
    targetType: "user",
    targetId: entry.userId,
    summary: entry.summary,
    before: entry.before,
    after: entry.after,
  };
  if (ctx.kind === "user") {
    await recordUserAudit(ctx, tenant, record);
    return;
  }
  if (actor === null) throw new Error("A change in the system scope needs the person behind it.");
  await recordSystemAudit(ctx, { type: "user", userId: actor.userId, label: actor.label }, record);
}

/**
 * Gives a user a role in the agency. "exists" when they already have one (nothing changes,
 * nothing is audited).
 */
export async function grantAgencyAccess(
  ctx: UserContext,
  input: { readonly agencyId: AgencyId; readonly userId: UserId; readonly role: AgencyRoleName },
): Promise<"granted" | "exists"> {
  const rows = await ctx.tx
    .insert(agencyMemberships)
    .values({ agencyId: input.agencyId, userId: input.userId, role: input.role })
    .onConflictDoNothing({ target: [agencyMemberships.agencyId, agencyMemberships.userId] })
    .returning({ id: agencyMemberships.id });
  if (rows.length === 0) return "exists";
  await auditAgency(ctx, input.agencyId, {
    action: "agency_membership.grant",
    userId: input.userId,
    summary: `Gave ${input.role} access to the agency`,
    after: { role: input.role },
  });
  return "granted";
}

/** Changes a user's agency role. False when there was no such membership in reach. */
export async function changeAgencyRole(
  ctx: UserContext,
  input: { readonly agencyId: AgencyId; readonly userId: UserId; readonly role: AgencyRoleName },
): Promise<boolean> {
  const before = await findAgencyRole(ctx, input.agencyId, input.userId);
  if (before === null) return false;
  if (before === input.role) return true;
  const rows = await ctx.tx
    .update(agencyMemberships)
    .set({ role: input.role, updatedAt: sql`now()` })
    .where(
      and(
        eq(agencyMemberships.agencyId, input.agencyId),
        eq(agencyMemberships.userId, input.userId),
        ne(agencyMemberships.role, input.role),
      ),
    )
    .returning({ id: agencyMemberships.id });
  if (rows.length === 0) return false;
  await auditAgency(ctx, input.agencyId, {
    action: "agency_membership.role_change",
    userId: input.userId,
    summary: `Changed agency role from ${before} to ${input.role}`,
    before: { role: before },
    after: { role: input.role },
  });
  return true;
}

/** Removes a user's agency access. False when there was no such membership in reach. */
export async function revokeAgencyAccess(
  ctx: UserContext,
  input: { readonly agencyId: AgencyId; readonly userId: UserId },
): Promise<boolean> {
  const rows = await ctx.tx
    .delete(agencyMemberships)
    .where(
      and(
        eq(agencyMemberships.agencyId, input.agencyId),
        eq(agencyMemberships.userId, input.userId),
      ),
    )
    .returning({ role: agencyMemberships.role });
  const removed = rows[0];
  if (removed === undefined) return false;
  await auditAgency(ctx, input.agencyId, {
    action: "agency_membership.revoke",
    userId: input.userId,
    summary: `Removed ${removed.role} access to the agency`,
    before: { role: removed.role },
  });
  return true;
}

type BusinessTarget = {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  readonly userId: UserId;
};

/** Gives a user a client role at the business. "exists" when they already have one. */
export async function grantBusinessAccess(
  ctx: UserContext | BusinessContext,
  input: BusinessTarget & { readonly role: ClientRoleName },
  actor: PeopleActor | null = null,
): Promise<"granted" | "exists"> {
  const rows = await ctx.tx
    .insert(businessMemberships)
    .values({
      agencyId: input.agencyId,
      businessId: input.businessId,
      userId: input.userId,
      role: input.role,
    })
    .onConflictDoNothing({ target: [businessMemberships.businessId, businessMemberships.userId] })
    .returning({ id: businessMemberships.id });
  if (rows.length === 0) return "exists";
  await auditBusiness(ctx, input, actor, {
    action: "business_membership.grant",
    userId: input.userId,
    summary: `Gave ${input.role} access to the business`,
    after: { role: input.role },
  });
  return "granted";
}

/** Changes a user's client role at the business. False when there was no such membership. */
export async function changeBusinessRole(
  ctx: UserContext | BusinessContext,
  input: BusinessTarget & { readonly role: ClientRoleName },
  actor: PeopleActor | null = null,
): Promise<boolean> {
  const before = await findBusinessRole(ctx, input.businessId, input.userId);
  if (before === null) return false;
  if (before === input.role) return true;
  const rows = await ctx.tx
    .update(businessMemberships)
    .set({ role: input.role, updatedAt: sql`now()` })
    .where(
      and(
        eq(businessMemberships.businessId, input.businessId),
        eq(businessMemberships.userId, input.userId),
        ne(businessMemberships.role, input.role),
      ),
    )
    .returning({ id: businessMemberships.id });
  if (rows.length === 0) return false;
  await auditBusiness(ctx, input, actor, {
    action: "business_membership.role_change",
    userId: input.userId,
    summary: `Changed business role from ${before} to ${input.role}`,
    before: { role: before },
    after: { role: input.role },
  });
  return true;
}

/** Removes a user's client access to the business. False when there was no such membership. */
export async function revokeBusinessAccess(
  ctx: UserContext | BusinessContext,
  input: BusinessTarget,
  actor: PeopleActor | null = null,
): Promise<boolean> {
  const rows = await ctx.tx
    .delete(businessMemberships)
    .where(
      and(
        eq(businessMemberships.businessId, input.businessId),
        eq(businessMemberships.userId, input.userId),
      ),
    )
    .returning({ role: businessMemberships.role });
  const removed = rows[0];
  if (removed === undefined) return false;
  await auditBusiness(ctx, input, actor, {
    action: "business_membership.revoke",
    userId: input.userId,
    summary: `Removed ${removed.role} access to the business`,
    before: { role: removed.role },
  });
  return true;
}
