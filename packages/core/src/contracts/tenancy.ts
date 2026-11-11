import { z } from "zod";

/** The four roles from the spec. Agency roles see every business of their agency. */
export const ROLES = ["agency_admin", "agency_member", "client_owner", "client_staff"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const AGENCY_ROLES = ["agency_admin", "agency_member"] as const satisfies readonly Role[];
export const CLIENT_ROLES = ["client_owner", "client_staff"] as const satisfies readonly Role[];

export function isAgencyRole(role: Role): role is (typeof AGENCY_ROLES)[number] {
  return (AGENCY_ROLES as readonly Role[]).includes(role);
}
