import { z } from "zod";

import {
  type AgencyId,
  AGENCY_ROLES,
  type BusinessId,
  CLIENT_ROLES,
  logger as rootLogger,
  type Role,
  UserId,
} from "@repo/core";
import {
  type AgencyRoleName,
  type BusinessContext,
  type BusinessTenant,
  changeAgencyRole,
  changeBusinessRole,
  type ClientRoleName,
  explainMembershipError,
  findBusinessRole,
  getDatabase,
  getVisibleBusiness,
  grantAgencyAccess,
  grantBusinessAccess,
  listAgencyPeople,
  listBusinessPeople,
  type PeopleActor,
  type PersonView,
  revokeAgencyAccess,
  revokeBusinessAccess,
  type UserContext,
} from "@repo/db";
import { loadSettings } from "@repo/settings/server";

import { ActionError } from "@/server/admin/result";
import { type SessionAccess, userDatabase } from "@/server/auth";

import type { Inviter } from "./inviter";

/*
 * People management (C18): who has access to an agency (agency_admin, agency_member) and to a
 * business (client_owner, client_staff), and the actions that add someone by email, change a
 * role and remove access. Functions of the session and their dependencies, so tests run them
 * without Next.js; the `"use server"` wrappers in `src/app/(admin)/_actions/people.ts` add the
 * cross-site check and the session (`runAction`).
 *
 * Who may do what (least privilege, DECISIONS 297):
 * - agency_admin: adds, changes and removes the agency's people and every client login of the
 *   agency's businesses; any role up to their own. Never their own row.
 * - agency_member: sees the lists, changes nothing.
 * - client_owner: when the business has client logins on and `client_portal.owner_manages_staff`
 *   (off by default), adds and removes the business's client_staff; never an owner, never
 *   themselves, never a role change. Otherwise sees nothing here.
 * - client_staff: nothing.
 *
 * The agency or business an action acts on is the page's, re-resolved on the server: an agency
 * id only picks among the person's own memberships, a business id is looked up as the person
 * under row-level security. The tenant ids written come from that lookup, never from the
 * request. Row-level security and the last-admin trigger (migration 0016) refuse the same
 * things again in the database.
 *
 * Privacy: the add form answers the same whether or not the address already had an account
 * (anywhere); emails are normalized; no email address is logged or put in an audit entry.
 */

const logger = rootLogger.child({ area: "people" });

/** Grants (adds) a person may make in a rolling 24 hours, across all their agencies. */
export const INVITATIONS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const ROLE_WORDS: Readonly<Record<Role, string>> = {
  agency_admin: "agency admin",
  agency_member: "agency member",
  client_owner: "business owner",
  client_staff: "business staff",
};

/** Lower-case, trimmed, Unicode-normalized; at most 254 characters. */
export const EmailAddress = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(z.email("That is not an email address.").max(254, "That address is too long."));

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const AgencyRef = z.strictObject({ agencyId: z.uuid() });
const BusinessRef = z.strictObject({ businessId: z.uuid() });
export const AddAgencyPersonInput = AgencyRef.extend({
  email: EmailAddress,
  role: z.enum(AGENCY_ROLES),
});
export const AgencyPersonInput = AgencyRef.extend({ userId: UserId });
export const ChangeAgencyRoleInput = AgencyPersonInput.extend({ role: z.enum(AGENCY_ROLES) });
export const AddBusinessPersonInput = BusinessRef.extend({
  email: EmailAddress,
  role: z.enum(CLIENT_ROLES),
});
export const BusinessPersonInput = BusinessRef.extend({ userId: UserId });
export const ChangeBusinessRoleInput = BusinessPersonInput.extend({ role: z.enum(CLIENT_ROLES) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ActionError(parsed.error.issues[0]?.message ?? "That request was not valid.");
  }
  return parsed.data;
}

export interface AddResult {
  readonly message: string;
  /** Local sign-in only: the link to hand to the person. */
  readonly link: string | null;
}

// --- who may manage --------------------------------------------------------------------------

export interface AgencyPeopleAccess {
  readonly agencyId: AgencyId;
  readonly role: AgencyRoleName;
  /** May add, change and remove. */
  readonly manage: boolean;
}

/** The agency of a people page or action: one of the person's own staff memberships. */
export function agencyPeopleAccess(
  session: SessionAccess,
  agencyId: string | null | undefined,
): AgencyPeopleAccess | null {
  const membership = session.access.agencies.find((agency) => agency.agencyId === agencyId);
  if (membership === undefined) return null;
  return {
    agencyId: membership.agencyId,
    role: membership.role,
    manage: membership.role === "agency_admin",
  };
}

export interface BusinessPeopleAccess {
  readonly tenant: BusinessTenant;
  readonly businessName: string;
  readonly role: Role;
  /** Client logins switched on for the business (`client_portal.enabled`). */
  readonly portalEnabled: boolean;
  /** May see the page at all. */
  readonly view: boolean;
  /** Roles this person may give, change to, or remove. Empty: read only. */
  readonly manageRoles: readonly ClientRoleName[];
  /** May change a role (agency admins only). */
  readonly changeRoles: boolean;
}

/**
 * The client-login page of one business, as far as the person may use it. Null when the
 * business is not theirs to see (row-level security), or when they may not see the page.
 */
export async function businessPeopleAccess(
  session: SessionAccess,
  businessId: unknown,
): Promise<BusinessPeopleAccess | null> {
  const id = BusinessRef.safeParse({ businessId });
  if (!id.success) return null;
  const business = await userDatabase(session.user).run((ctx) =>
    getVisibleBusiness(ctx, id.data.businessId as BusinessId),
  );
  if (business === null) return null;
  const tenant = { agencyId: business.agencyId, businessId: business.id };
  const staffRole = session.access.agencies.find((a) => a.agencyId === business.agencyId)?.role;
  const base = {
    tenant,
    businessName: business.name,
    portalEnabled: business.clientPortalEnabled,
  };
  if (staffRole !== undefined) {
    const admin = staffRole === "agency_admin";
    return {
      ...base,
      role: staffRole,
      view: true,
      manageRoles: admin ? CLIENT_ROLES : [],
      changeRoles: admin,
    };
  }
  const membership = session.access.businesses.find(
    (candidate) => candidate.businessId === business.id && candidate.enabled,
  );
  if (membership?.role !== "client_owner") return null;
  const settings = await getDatabase()
    .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
    .run((ctx) => loadSettings(ctx, tenant));
  const owns =
    settings.values["client_portal.enabled"] === true &&
    settings.values["client_portal.owner_manages_staff"] === true;
  if (!owns) return null;
  return {
    ...base,
    role: "client_owner",
    view: true,
    manageRoles: ["client_staff"],
    changeRoles: false,
  };
}

// --- the actions -----------------------------------------------------------------------------

export interface PeopleDeps {
  /** Null when this deployment cannot invite anyone; `unavailable` says why. */
  readonly inviter: Inviter | null;
  readonly unavailable?: string;
  readonly now?: () => Date;
}

export function createPeopleActions(deps: PeopleDeps) {
  const now = deps.now ?? (() => new Date());

  function inviter(): Inviter {
    if (deps.inviter === null) {
      throw new ActionError(
        deps.unavailable ?? "Inviting people is not set up on this deployment.",
      );
    }
    return deps.inviter;
  }

  async function checkInvitationLimit(session: SessionAccess): Promise<void> {
    const since = new Date(now().getTime() - DAY_MS);
    const sent = await getDatabase().directory.countAccessGrantsSince(session.user.id, since);
    if (sent >= INVITATIONS_PER_DAY) {
      logger.warn("people.invite.limited", { userId: session.user.id });
      throw new ActionError(
        `You have added ${INVITATIONS_PER_DAY} people in the last 24 hours, the most allowed. Try again tomorrow.`,
      );
    }
  }

  function refuseSelf(session: SessionAccess, target: { email?: string; userId?: string }) {
    const own = session.user.email === null ? null : normalizeEmail(session.user.email);
    if (target.userId === session.user.id || (own !== null && target.email === own)) {
      throw new ActionError("You cannot change your own access. Ask another admin.");
    }
  }

  function addedMessage(email: string, role: Role, link: string | null): AddResult {
    const who = `${email} now has access as ${ROLE_WORDS[role]}.`;
    return {
      message:
        link === null
          ? `${who} We emailed them a link to sign in.`
          : `${who} Local sign-in sends no email: give them the link below.`,
      link,
    };
  }

  function requireAgencyAdmin(session: SessionAccess, agencyId: string): AgencyPeopleAccess {
    const access = agencyPeopleAccess(session, agencyId);
    if (access === null) throw new ActionError("That agency was not found.");
    if (!access.manage) throw new ActionError("Only agency admins can manage the agency's people.");
    return access;
  }

  async function requireBusinessManager(
    session: SessionAccess,
    businessId: string,
    role?: ClientRoleName,
  ): Promise<BusinessPeopleAccess> {
    const access = await businessPeopleAccess(session, businessId);
    if (access === null) throw new ActionError("That business was not found.");
    if (access.manageRoles.length === 0) {
      throw new ActionError("Only agency admins can manage this business's logins.");
    }
    if (role !== undefined && !access.manageRoles.includes(role)) {
      throw new ActionError(`You cannot give the role ${ROLE_WORDS[role]}.`);
    }
    return access;
  }

  /** Writes as the person (agency admin) or, for a client owner, in the business's scope. */
  function businessWrite<T>(
    session: SessionAccess,
    access: BusinessPeopleAccess,
    fn: (ctx: UserContext | BusinessContext, actor: PeopleActor | null) => Promise<T>,
  ): Promise<T> {
    if (access.changeRoles) return userDatabase(session.user).run((ctx) => fn(ctx, null));
    return getDatabase()
      .forBusiness(access.tenant.businessId, { agencyId: access.tenant.agencyId })
      .run((ctx) => fn(ctx, { userId: session.user.id, label: session.user.email }));
  }

  return {
    async listAgency(
      session: SessionAccess,
      agencyId: string,
    ): Promise<readonly PersonView<AgencyRoleName>[]> {
      const access = agencyPeopleAccess(session, agencyId);
      if (access === null) return [];
      return userDatabase(session.user).run((ctx) => listAgencyPeople(ctx, access.agencyId));
    },

    async listBusiness(
      session: SessionAccess,
      access: BusinessPeopleAccess,
    ): Promise<readonly PersonView<ClientRoleName>[]> {
      return userDatabase(session.user).run((ctx) =>
        listBusinessPeople(ctx, access.tenant.businessId),
      );
    },

    async addAgencyPerson(session: SessionAccess, input: unknown): Promise<AddResult> {
      const { agencyId, email, role } = parse(AddAgencyPersonInput, input);
      const access = requireAgencyAdmin(session, agencyId);
      refuseSelf(session, { email });
      const team = await userDatabase(session.user).run((ctx) =>
        listAgencyPeople(ctx, access.agencyId),
      );
      if (team.some((person) => person.email.toLowerCase() === email)) {
        throw new ActionError(
          `${email} is already on the agency's team. Change their role instead.`,
        );
      }
      await checkInvitationLimit(session);
      const invitation = await inviter().invite(email);
      refuseSelf(session, { userId: invitation.userId });
      const outcome = await userDatabase(session.user).run((ctx) =>
        grantAgencyAccess(ctx, { agencyId: access.agencyId, userId: invitation.userId, role }),
      );
      if (outcome === "exists") {
        throw new ActionError(
          `${email} is already on the agency's team. Change their role instead.`,
        );
      }
      logger.info("people.agency.added", {
        agencyId: access.agencyId,
        role,
        userId: invitation.userId,
      });
      return addedMessage(email, role, invitation.link);
    },

    async changeAgencyRole(session: SessionAccess, input: unknown): Promise<string> {
      const { agencyId, userId, role } = parse(ChangeAgencyRoleInput, input);
      const access = requireAgencyAdmin(session, agencyId);
      refuseSelf(session, { userId });
      const changed = await userDatabase(session.user)
        .run((ctx) => changeAgencyRole(ctx, { agencyId: access.agencyId, userId, role }))
        .catch((error: unknown) => {
          throw explainMembershipError(error);
        });
      if (!changed) throw new ActionError("That person is not on the agency's team.");
      logger.info("people.agency.role_changed", { agencyId: access.agencyId, role, userId });
      return `Role changed to ${ROLE_WORDS[role]}.`;
    },

    async removeAgencyPerson(session: SessionAccess, input: unknown): Promise<string> {
      const { agencyId, userId } = parse(AgencyPersonInput, input);
      const access = requireAgencyAdmin(session, agencyId);
      refuseSelf(session, { userId });
      const removed = await userDatabase(session.user)
        .run((ctx) => revokeAgencyAccess(ctx, { agencyId: access.agencyId, userId }))
        .catch((error: unknown) => {
          throw explainMembershipError(error);
        });
      if (!removed) throw new ActionError("That person is not on the agency's team.");
      logger.info("people.agency.removed", { agencyId: access.agencyId, userId });
      return "Access removed. It ends with their next click.";
    },

    async addBusinessPerson(session: SessionAccess, input: unknown): Promise<AddResult> {
      const { businessId, email, role } = parse(AddBusinessPersonInput, input);
      const access = await requireBusinessManager(session, businessId, role);
      refuseSelf(session, { email });
      const existing = await businessWrite(session, access, (ctx) =>
        listBusinessPeople(ctx, access.tenant.businessId),
      );
      if (existing.some((person) => person.email.toLowerCase() === email)) {
        throw new ActionError(`${email} already has a login for this business.`);
      }
      if (access.changeRoles) {
        // Agency staff already see every business; a client login would only confuse.
        const team = await userDatabase(session.user).run((ctx) =>
          listAgencyPeople(ctx, access.tenant.agencyId),
        );
        if (team.some((person) => person.email.toLowerCase() === email)) {
          throw new ActionError(`${email} is on the agency's team and already sees this business.`);
        }
      }
      await checkInvitationLimit(session);
      const invitation = await inviter().invite(email);
      refuseSelf(session, { userId: invitation.userId });
      const outcome = await businessWrite(session, access, (ctx, actor) =>
        grantBusinessAccess(ctx, { ...access.tenant, userId: invitation.userId, role }, actor),
      );
      if (outcome === "exists")
        throw new ActionError(`${email} already has a login for this business.`);
      logger.info("people.business.added", {
        agencyId: access.tenant.agencyId,
        businessId: access.tenant.businessId,
        role,
        userId: invitation.userId,
      });
      const result = addedMessage(email, role, invitation.link);
      return access.portalEnabled
        ? result
        : {
            ...result,
            message: `${result.message} Client logins are switched off for this business: they can sign in once you switch them on (Settings, Client portal).`,
          };
    },

    async changeBusinessRole(session: SessionAccess, input: unknown): Promise<string> {
      const { businessId, userId, role } = parse(ChangeBusinessRoleInput, input);
      const access = await requireBusinessManager(session, businessId, role);
      if (!access.changeRoles) throw new ActionError("Only agency admins change roles.");
      refuseSelf(session, { userId });
      const changed = await userDatabase(session.user).run((ctx) =>
        changeBusinessRole(ctx, { ...access.tenant, userId, role }),
      );
      if (!changed) throw new ActionError("That person has no login for this business.");
      logger.info("people.business.role_changed", {
        businessId: access.tenant.businessId,
        role,
        userId,
      });
      return `Role changed to ${ROLE_WORDS[role]}.`;
    },

    async removeBusinessPerson(session: SessionAccess, input: unknown): Promise<string> {
      const { businessId, userId } = parse(BusinessPersonInput, input);
      const access = await requireBusinessManager(session, businessId);
      refuseSelf(session, { userId });
      const removed = await businessWrite(session, access, async (ctx, actor) => {
        const current = await findBusinessRole(ctx, access.tenant.businessId, userId);
        if (current === null) return false;
        if (!access.manageRoles.includes(current)) {
          throw new ActionError(`You cannot remove a ${ROLE_WORDS[current]}.`);
        }
        return revokeBusinessAccess(ctx, { ...access.tenant, userId }, actor);
      });
      if (!removed) throw new ActionError("That person has no login for this business.");
      logger.info("people.business.removed", { businessId: access.tenant.businessId, userId });
      return "Access removed. It ends with their next click.";
    },
  };
}

export type PeopleActions = ReturnType<typeof createPeopleActions>;

export { ROLE_WORDS };
