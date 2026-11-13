import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  type AgencyId,
  BusinessId,
  isAgencyRole,
  logger as rootLogger,
  type Role,
} from "@repo/core";
import { getEnv } from "@repo/core/env";
import {
  type BusinessDetails,
  type BusinessTenant,
  businessRoleOf,
  getDatabase,
  getVisibleBusiness,
  hasAnyAccess,
} from "@repo/db";
import { createSettingsService, type SettingsService } from "@repo/settings/server";

import { getAccess, requireAccess, type SessionAccess, userDatabase } from "@/server/auth";

import { isSameOriginHeaders } from "./origin";
import { ActionError, type ActionResult, toFailure } from "./result";
import { type AdminSettings, createAdminSettings } from "./settings-actions";

/*
 * The admin panel's server side (C15): who is asking, which business, and the services the
 * screens call. Every page and every server action starts here. Authorization is decided on
 * the server for every read and write: the business comes from what the signed-in user may
 * see under row-level security, never from a hidden field, and the role is checked again
 * by the service that does the work.
 */

export { type ActionResult, fail, ok } from "./result";
export const adminLogger = rootLogger.child({ area: "admin" });

let settingsService: SettingsService | undefined;
let adminSettings: AdminSettings | undefined;

/** The settings engine (C2) for the admin panel: view, update and history as a user. */
export function getSettings(): SettingsService {
  settingsService ??= createSettingsService({ db: getDatabase(), logger: adminLogger });
  return settingsService;
}

/** The settings screen's actions, on top of `getSettings()`. */
export function getAdminSettings(): AdminSettings {
  adminSettings ??= createAdminSettings({ db: getDatabase(), settings: getSettings() });
  return adminSettings;
}

/** The agencies where the user is staff, and the first one (the one agency pages show). */
export function staffAgency(session: SessionAccess): {
  readonly agencyId: AgencyId;
  readonly role: "agency_admin" | "agency_member";
} | null {
  return session.access.agencies[0] ?? null;
}

/** For agency pages (playbooks, agency settings): agency staff only; others go to their business. */
export async function requireStaffSession(next: string): Promise<
  SessionAccess & {
    readonly agencyId: AgencyId;
    readonly agencyRole: "agency_admin" | "agency_member";
  }
> {
  const session = await requireAccess(next);
  const agency = staffAgency(session);
  if (agency === null) redirect("/businesses");
  return { ...session, agencyId: agency.agencyId, agencyRole: agency.role };
}

export interface BusinessPage extends SessionAccess {
  readonly business: BusinessDetails;
  readonly tenant: BusinessTenant;
  readonly role: Role;
  readonly staff: boolean;
}

/**
 * The business of a page's URL, as far as the signed-in user may see it. A business that
 * does not exist, belongs to another agency or another client looks the same: not found.
 */
export async function requireBusinessPage(
  businessId: string,
  options: { readonly staffOnly?: boolean; readonly next?: string } = {},
): Promise<BusinessPage> {
  const session = await requireAccess(options.next ?? `/businesses/${businessId}`);
  const id = BusinessId.safeParse(businessId);
  if (!id.success) notFound();
  const business = await userDatabase(session.user).run((ctx) => getVisibleBusiness(ctx, id.data));
  if (business === null) notFound();
  const tenant = { agencyId: business.agencyId, businessId: business.id };
  const role = businessRoleOf(session.access, tenant);
  if (role === null) notFound();
  const staff = isAgencyRole(role);
  if (options.staffOnly === true && !staff) notFound();
  return { ...session, business, tenant, role, staff };
}

/** Throws unless the action's request came from this site (the sign-in forms' rule). */
async function assertSameOrigin(): Promise<void> {
  if (!isSameOriginHeaders(await headers(), getEnv().APP_URL)) {
    adminLogger.warn("admin.action.cross_site");
    throw new ActionError(
      "That request did not come from this site. Reload the page and try again.",
    );
  }
}

/** The signed-in session of a server action, after the cross-site check. */
export async function actionSession(): Promise<SessionAccess> {
  await assertSameOrigin();
  const session = await getAccess();
  if (session === null || !hasAnyAccess(session.access)) {
    throw new ActionError("Your session has ended. Sign in again.");
  }
  return session;
}

/**
 * Runs a server action's body with the cross-site check and the session, and turns every
 * error into a result the form can show.
 */
export async function runAction<T>(
  name: string,
  body: (session: SessionAccess) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const session = await actionSession();
    return { ok: true, value: await body(session) };
  } catch (error) {
    // `redirect()` and `notFound()` are thrown on purpose; let Next.js handle them.
    if (isNextControlFlow(error)) throw error;
    return toFailure(error, adminLogger, name);
  }
}

function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"))
  );
}

/** The business of an action, for agency staff (or any member when `anyRole`). */
export async function actionBusiness(
  session: SessionAccess,
  businessId: unknown,
  options: { readonly anyRole?: boolean } = {},
): Promise<{
  readonly business: BusinessDetails;
  readonly tenant: BusinessTenant;
  readonly role: Role;
}> {
  const id = BusinessId.safeParse(businessId);
  if (!id.success) throw new ActionError("That business was not found.");
  const business = await userDatabase(session.user).run((ctx) => getVisibleBusiness(ctx, id.data));
  if (business === null) throw new ActionError("That business was not found.");
  const tenant = { agencyId: business.agencyId, businessId: business.id };
  const role = businessRoleOf(session.access, tenant);
  if (role === null) throw new ActionError("That business was not found.");
  if (options.anyRole !== true && !isAgencyRole(role)) {
    throw new ActionError("Only agency staff can do that.");
  }
  return { business, tenant, role };
}
