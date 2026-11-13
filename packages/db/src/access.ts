import { eq } from "drizzle-orm";

import {
  type AGENCY_ROLES,
  type AgencyId,
  type BusinessId,
  type CLIENT_ROLES,
  type Role,
  TenantAccessError,
  type UserId,
} from "@repo/core";

import type { UserContext } from "./context";
import { agencyMemberships, businesses, businessMemberships } from "./schema/tables";

/**
 * What a signed-in user may reach, read from the membership tables under the user's own
 * row-level security. This is the server-side half of the defence in depth: the database
 * refuses what the user may not touch, and server code uses these helpers to decide what to
 * show and to fail early with a clear error.
 */

export type AgencyRole = (typeof AGENCY_ROLES)[number];
export type ClientRole = (typeof CLIENT_ROLES)[number];

export interface AgencyAccess {
  readonly agencyId: AgencyId;
  readonly role: AgencyRole;
}

export interface BusinessAccess {
  readonly businessId: BusinessId;
  readonly agencyId: AgencyId;
  readonly role: ClientRole;
  /** False when the business has client logins switched off (or is archived). */
  readonly enabled: boolean;
}

export interface UserAccess {
  readonly userId: UserId;
  /** Agencies where the user is staff. */
  readonly agencies: readonly AgencyAccess[];
  /** Businesses where the user is a client user. */
  readonly businesses: readonly BusinessAccess[];
}

/** Loads the user's memberships. Two indexed queries; cache the result per request. */
export async function loadUserAccess(ctx: UserContext): Promise<UserAccess> {
  const userId = ctx.user.id;
  const agencies = await ctx.tx
    .select({ agencyId: agencyMemberships.agencyId, role: agencyMemberships.role })
    .from(agencyMemberships)
    .where(eq(agencyMemberships.userId, userId))
    // Membership order, then the id: "the user's first agency" must not change between requests.
    .orderBy(agencyMemberships.createdAt, agencyMemberships.agencyId);
  // The membership row is always visible to its user; the business row only while client
  // logins are enabled.
  const memberships = await ctx.tx
    .select({
      businessId: businessMemberships.businessId,
      agencyId: businessMemberships.agencyId,
      role: businessMemberships.role,
      portalEnabled: businesses.clientPortalEnabled,
      status: businesses.status,
    })
    .from(businessMemberships)
    .leftJoin(businesses, eq(businesses.id, businessMemberships.businessId))
    .where(eq(businessMemberships.userId, userId))
    .orderBy(businessMemberships.createdAt);

  return {
    userId,
    agencies,
    businesses: memberships.map((membership) => ({
      businessId: membership.businessId,
      agencyId: membership.agencyId,
      role: membership.role,
      // A client user cannot see the business row at all while logins are off (both
      // columns come back null); a user who is also staff sees it, so check the flag too.
      enabled: membership.portalEnabled === true && membership.status !== "archived",
    })),
  };
}

/** True when the user can sign in to something: any agency, or an enabled business. */
export function hasAnyAccess(access: UserAccess): boolean {
  return access.agencies.length > 0 || access.businesses.some((business) => business.enabled);
}

/** The user's role in the agency, or null when they are not staff there. */
export function agencyRoleOf(access: UserAccess, agencyId: AgencyId): AgencyRole | null {
  return access.agencies.find((agency) => agency.agencyId === agencyId)?.role ?? null;
}

/**
 * The role under which the user may act on a business: their agency role when they are
 * staff of the business's agency, otherwise their client role when client logins are
 * enabled, otherwise null.
 */
export function businessRoleOf(
  access: UserAccess,
  business: { readonly businessId: BusinessId; readonly agencyId: AgencyId },
): Role | null {
  const staffRole = agencyRoleOf(access, business.agencyId);
  if (staffRole !== null) return staffRole;
  const membership = access.businesses.find(
    (candidate) => candidate.businessId === business.businessId && candidate.enabled,
  );
  return membership?.role ?? null;
}

/** Throws `TenantAccessError` unless the user has one of the roles in the agency. */
export function requireAgencyRole(
  access: UserAccess,
  agencyId: AgencyId,
  allowed: readonly AgencyRole[] = ["agency_admin", "agency_member"],
): AgencyRole {
  const role = agencyRoleOf(access, agencyId);
  if (role === null || !allowed.includes(role)) {
    throw new TenantAccessError("You do not have access to this agency.", {
      details: { agencyId, userId: access.userId },
    });
  }
  return role;
}

/** Throws `TenantAccessError` unless the user may act on the business with an allowed role. */
export function requireBusinessRole(
  access: UserAccess,
  business: { readonly businessId: BusinessId; readonly agencyId: AgencyId },
  allowed: readonly Role[] = ["agency_admin", "agency_member", "client_owner", "client_staff"],
): Role {
  const role = businessRoleOf(access, business);
  if (role === null || !allowed.includes(role)) {
    throw new TenantAccessError("You do not have access to this business.", {
      details: { businessId: business.businessId, userId: access.userId },
    });
  }
  return role;
}
