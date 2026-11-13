import { type AgencyId, type BusinessId, isAgencyRole, type Role } from "@repo/core";
import { type BusinessTenant, businessRoleOf, getDatabase, listVisibleBusinesses } from "@repo/db";
import type { AppSettings } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { type SessionAccess, userDatabase } from "@/server/auth";

/*
 * What a person may see and do per business on the operational screens (C16). Agency staff
 * may do everything their role allows at every business of their agency. A client user
 * (client_owner, client_staff) gets what the business's client-portal settings allow, on top
 * of row-level security, which already limits them to their own business while client
 * logins are on. Decided on the server for every page, action and route, from the session
 * and the stored settings, never from anything the browser sends.
 *
 * Staff only, whatever the settings: internal notes, assignment, emergencies and alerts
 * (their rows carry the agency's contacts' phone numbers), follow-ups, opt-out, connections
 * and integrations, the audit log.
 */

export interface PortalPermissions {
  readonly staff: boolean;
  readonly viewConversations: boolean;
  readonly reply: boolean;
  readonly viewLeads: boolean;
  readonly viewReports: boolean;
  readonly exportLeads: boolean;
  readonly viewAnalytics: boolean;
}

export type PortalScreen = "conversations" | "leads" | "export" | "analytics";

export const STAFF_PERMISSIONS: PortalPermissions = {
  staff: true,
  viewConversations: true,
  reply: true,
  viewLeads: true,
  viewReports: true,
  exportLeads: true,
  viewAnalytics: true,
};

export const NO_PERMISSIONS: PortalPermissions = {
  staff: false,
  viewConversations: false,
  reply: false,
  viewLeads: false,
  viewReports: false,
  exportLeads: false,
  viewAnalytics: false,
};

type Who = "nobody" | "owner" | "owner_and_staff";

function allows(who: Who, role: Role): boolean {
  if (who === "owner_and_staff") return role === "client_owner" || role === "client_staff";
  if (who === "owner") return role === "client_owner";
  return false;
}

/** Pure: the permissions of `role` under one business's settings. */
export function permissionsFor(
  role: Role | null,
  values: Pick<
    AppSettings,
    | "client_portal.enabled"
    | "client_portal.view_conversations"
    | "client_portal.reply_and_take_over"
    | "client_portal.view_leads"
    | "client_portal.view_lead_reports"
    | "client_portal.export_leads"
    | "client_portal.view_analytics"
  >,
): PortalPermissions {
  if (role === null) return NO_PERMISSIONS;
  if (isAgencyRole(role)) return STAFF_PERMISSIONS;
  if (values["client_portal.enabled"] !== true) return NO_PERMISSIONS;
  const viewConversations = allows(values["client_portal.view_conversations"], role);
  const viewLeads = allows(values["client_portal.view_leads"], role);
  return {
    staff: false,
    viewConversations,
    // Replying needs reading the conversation.
    reply: viewConversations && allows(values["client_portal.reply_and_take_over"], role),
    viewLeads,
    viewReports: allows(values["client_portal.view_lead_reports"], role),
    exportLeads: viewLeads && allows(values["client_portal.export_leads"], role),
    viewAnalytics: allows(values["client_portal.view_analytics"], role),
  };
}

/** The permissions of the signed-in person at one business they can see. */
export async function businessPermissions(
  session: SessionAccess,
  tenant: BusinessTenant,
): Promise<PortalPermissions> {
  const role = businessRoleOf(session.access, tenant);
  if (role === null) return NO_PERMISSIONS;
  if (isAgencyRole(role)) return STAFF_PERMISSIONS;
  const settings = await getDatabase()
    .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
    .run((ctx) => loadSettings(ctx, tenant));
  return permissionsFor(role, settings.values);
}

const SCREEN_FLAG: Readonly<Record<PortalScreen, keyof PortalPermissions>> = {
  conversations: "viewConversations",
  leads: "viewLeads",
  export: "exportLeads",
  analytics: "viewAnalytics",
};

export interface ScreenBusiness {
  readonly id: BusinessId;
  readonly agencyId: AgencyId;
  readonly name: string;
  readonly permissions: PortalPermissions;
}

/**
 * The businesses whose `screen` the person may open, with their permissions: every business
 * of the person's agencies for staff, and each client business whose settings allow it.
 */
export async function screenBusinesses(
  session: SessionAccess,
  screen: PortalScreen,
): Promise<readonly ScreenBusiness[]> {
  const visible = await userDatabase(session.user).run((ctx) => listVisibleBusinesses(ctx));
  const out: ScreenBusiness[] = [];
  for (const business of visible) {
    const permissions = await businessPermissions(session, {
      agencyId: business.agencyId,
      businessId: business.id,
    });
    if (permissions[SCREEN_FLAG[screen]] === true) {
      out.push({ id: business.id, agencyId: business.agencyId, name: business.name, permissions });
    }
  }
  return out;
}

/**
 * What to pass a list query as its `businessIds`: null when the person is staff only (row
 * level security alone decides), otherwise the ids `screenBusinesses` allows.
 */
export function businessIdsFor(
  session: SessionAccess,
  allowed: readonly ScreenBusiness[],
): readonly BusinessId[] | null {
  return session.access.businesses.length === 0 ? null : allowed.map((business) => business.id);
}
