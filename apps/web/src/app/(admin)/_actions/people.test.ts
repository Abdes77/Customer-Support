import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { addLogListener, type LogRecord, type UserId } from "@repo/core";
import {
  and,
  auditLog,
  eq,
  type Directory,
  loadUserAccess,
  type SupabaseAuthAdmin,
  type UserIdentity,
  hasAnyAccess,
  businesses as businessesTable,
} from "@repo/db";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";
import { applySettingChanges } from "@repo/settings/server";

import type { SessionAccess } from "@/server/auth";
import { createPeopleActions, INVITATIONS_PER_DAY } from "@/server/people";
import { createLocalInviter, createSupabaseInviter, type Inviter } from "@/server/people/inviter";

/*
 * People management (C18) as every role, against a real database: the server actions behind
 * the cross-site check and the session, with ids swapped for another tenant's, self-escalation,
 * the last admin, the invitation limit with an injected clock, the same answer for an address
 * with or without an account, and removal taking effect on the next request. Next.js is
 * replaced by the smallest stand-ins, as in inbox.test.ts.
 */

let t: TestDatabase;
let world: World;
let currentUser: UserIdentity | null = null;
let inviter: Inviter;
const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "sec-fetch-site": "same-origin",
};
let requestHeaders = new Headers(SAME_ORIGIN);
const SECRET = "people-test-local-auth-secret-0123456789";

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, getAll: () => [], set() {}, delete() {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => {
  const userDatabase = (user: UserIdentity) => t.db.asUser({ id: user.id, email: user.email });
  const getAccess = async () =>
    currentUser === null
      ? null
      : {
          user: { id: currentUser.id, email: currentUser.email ?? null },
          access: await userDatabase(currentUser).run((ctx) => loadUserAccess(ctx)),
        };
  return {
    getAccess,
    requireAccess: async () => {
      const session = await getAccess();
      if (session === null) throw new Error("signed out");
      return session;
    },
    userDatabase,
  };
});
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => t.db,
}));
vi.mock("@/server/people/inviter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inviterForDeployment: () => inviter,
}));

const people = () => import("./people");

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  inviter = createLocalInviter({
    store: t.db.localAuth,
    secret: SECRET,
    appUrl: "http://localhost:3000",
  });
});

afterAll(async () => {
  await t?.dispose();
});

beforeEach(() => {
  requestHeaders = new Headers(SAME_ORIGIN);
});

function as(user: UserIdentity | null): void {
  currentUser = user;
}

async function sessionOf(user: UserIdentity): Promise<SessionAccess> {
  return {
    user: { id: user.id, email: user.email ?? null },
    access: await t.db.asUser(user).run((ctx) => loadUserAccess(ctx)),
  };
}

const agencyA = () => world.agencies.a.agencyId;
const tenant = (key: "a1" | "a2" | "a3" | "b1") => world.businesses[key].tenant;
const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}@people.test`;

async function userIdOf(email: string): Promise<UserId> {
  const found = await t.db.directory.findUserByEmail(email);
  if (found === null) throw new Error("no such user");
  return found.id;
}

async function setPortal(key: "a1" | "a2" | "a3" | "b1", values: Record<string, unknown>) {
  const target = tenant(key);
  await t.db.forBusiness(target.businessId, { agencyId: target.agencyId }).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...target },
      changes: Object.entries(values).map(([key, value]) => ({ key, value })),
      actor: { type: "system", label: "test" },
    }),
  );
}

async function auditFor(userId: UserId) {
  return t.admin
    .select({ action: auditLog.action, actor: auditLog.actorUserId, summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, userId)));
}

describe("agency people", () => {
  it("an admin adds someone by a normalized email, changes the role and removes access, all audited", async () => {
    const { addAgencyPersonAction, changeAgencyRoleAction, removeAgencyPersonAction } =
      await people();
    as(world.users.aAdmin);
    const email = unique("new.person");
    const added = await addAgencyPersonAction({
      agencyId: agencyA(),
      email: `  ${email.toUpperCase()} `,
      role: "agency_member",
    });
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;
    expect(added.value.message).toBe(
      `${email} now has access as agency member. Local sign-in sends no email: give them the link below.`,
    );
    expect(added.value.link).toMatch(/^\/auth\/confirm\?token_hash=[^&]+&type=magiclink$/);
    const userId = await userIdOf(email);

    const again = await addAgencyPersonAction({ agencyId: agencyA(), email, role: "agency_admin" });
    expect(again).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already on the agency/),
    });

    expect(
      await changeAgencyRoleAction({ agencyId: agencyA(), userId, role: "agency_admin" }),
    ).toEqual({ ok: true, value: "Role changed to agency admin." });
    expect(await removeAgencyPersonAction({ agencyId: agencyA(), userId })).toMatchObject({
      ok: true,
    });
    expect((await auditFor(userId)).map((row) => [row.action, row.actor])).toEqual([
      ["agency_membership.grant", world.users.aAdmin.id],
      ["agency_membership.role_change", world.users.aAdmin.id],
      ["agency_membership.revoke", world.users.aAdmin.id],
    ]);
    expect(JSON.stringify(await auditFor(userId))).not.toContain("@");
  });

  it("answers the same whether or not the address already has an account in another agency", async () => {
    const { addAgencyPersonAction, removeAgencyPersonAction } = await people();
    as(world.users.aAdmin);
    const fresh = unique("fresh");
    const existing = world.users.bMember.email!; // staff of agency B
    const first = await addAgencyPersonAction({
      agencyId: agencyA(),
      email: fresh,
      role: "agency_member",
    });
    const second = await addAgencyPersonAction({
      agencyId: agencyA(),
      email: existing,
      role: "agency_member",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.message.replace(fresh, "X")).toBe(
      second.value.message.replace(existing, "X"),
    );
    expect(typeof first.value.link).toBe(typeof second.value.link);
    // Nothing about agency B leaks, and B keeps its member.
    const bAccess = await t.db.asUser(world.users.bMember).run((ctx) => loadUserAccess(ctx));
    expect(bAccess.agencies.map((agency) => agency.agencyId).sort()).toEqual(
      [world.agencies.a.agencyId, world.agencies.b.agencyId].sort(),
    );
    await removeAgencyPersonAction({ agencyId: agencyA(), userId: world.users.bMember.id });
    await removeAgencyPersonAction({ agencyId: agencyA(), userId: await userIdOf(fresh) });
  });

  it("nobody changes their own access", async () => {
    const { addAgencyPersonAction, changeAgencyRoleAction, removeAgencyPersonAction } =
      await people();
    as(world.users.aAdmin);
    const own = { agencyId: agencyA(), userId: world.users.aAdmin.id };
    const refusal = { ok: false, error: "You cannot change your own access. Ask another admin." };
    expect(await changeAgencyRoleAction({ ...own, role: "agency_member" })).toEqual(refusal);
    expect(await removeAgencyPersonAction(own)).toEqual(refusal);
    expect(
      await addAgencyPersonAction({
        agencyId: agencyA(),
        email: world.users.aAdmin.email!.toUpperCase(),
        role: "agency_admin",
      }),
    ).toMatchObject({ ok: false });
  });

  it("refuses members, client users, other agencies, signed-out and cross-site requests", async () => {
    const { addAgencyPersonAction, changeAgencyRoleAction, removeAgencyPersonAction } =
      await people();
    const add = { agencyId: agencyA(), email: unique("nope"), role: "agency_admin" };
    const change = { agencyId: agencyA(), userId: world.users.aMember.id, role: "agency_admin" };
    const remove = { agencyId: agencyA(), userId: world.users.aMember.id };
    as(world.users.aMember);
    for (const result of [
      await addAgencyPersonAction(add),
      await changeAgencyRoleAction(change),
      await removeAgencyPersonAction(remove),
    ]) {
      expect(result).toEqual({
        ok: false,
        error: "Only agency admins can manage the agency's people.",
      });
    }
    for (const user of [world.users.bAdmin, world.users.a1Owner]) {
      as(user);
      for (const result of [
        await addAgencyPersonAction(add),
        await changeAgencyRoleAction(change),
        await removeAgencyPersonAction(remove),
      ]) {
        expect(result).toEqual({ ok: false, error: "That agency was not found." });
      }
    }
    as(world.users.outsider);
    expect(await addAgencyPersonAction(add)).toEqual({
      ok: false,
      error: "Your session has ended. Sign in again.",
    });
    as(world.users.aAdmin);
    requestHeaders = new Headers({
      ...SAME_ORIGIN,
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(await addAgencyPersonAction(add)).toMatchObject({ ok: false });
    requestHeaders = new Headers(SAME_ORIGIN);
    // The member is still a member, and nobody was created.
    const memberAccess = await sessionOf(world.users.aMember);
    expect(memberAccess.access.agencies[0]?.role).toBe("agency_member");
    expect(await t.db.directory.findUserByEmail(add.email)).toBeNull();
  });

  it("two admins demoting each other at once: exactly one wins and the agency keeps an admin", async () => {
    const second = unique("second-admin");
    const adminActions = createPeopleActions({ inviter });
    await adminActions.addAgencyPerson(await sessionOf(world.users.aAdmin), {
      agencyId: agencyA(),
      email: second,
      role: "agency_admin",
    });
    const secondId = await userIdOf(second);
    const secondUser = { id: secondId, email: second };
    const [secondSession, firstSession] = await Promise.all([
      sessionOf(secondUser),
      sessionOf(world.users.aAdmin),
    ]);
    const [one, two] = await Promise.allSettled([
      adminActions.changeAgencyRole(secondSession, {
        agencyId: agencyA(),
        userId: world.users.aAdmin.id,
        role: "agency_member",
      }),
      adminActions.changeAgencyRole(firstSession, {
        agencyId: agencyA(),
        userId: secondId,
        role: "agency_member",
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
    const team = await t.db
      .asUser(world.users.aMember)
      .run(async (ctx) => (await import("@repo/db")).listAgencyPeople(ctx, agencyA()));
    expect(team.filter((person) => person.role === "agency_admin")).toHaveLength(1);
    // Put agency A back as it was: aAdmin the admin, the second person gone.
    const winner = team.find((person) => person.role === "agency_admin")!;
    const winnerUser = winner.userId === secondId ? secondUser : world.users.aAdmin;
    const loser = winner.userId === secondId ? world.users.aAdmin.id : secondId;
    await adminActions.changeAgencyRole(await sessionOf(winnerUser), {
      agencyId: agencyA(),
      userId: loser,
      role: "agency_admin",
    });
    await adminActions.removeAgencyPerson(await sessionOf(world.users.aAdmin), {
      agencyId: agencyA(),
      userId: secondId,
    });
  });
});

describe("client logins", () => {
  it("an admin adds a client owner who then sees only their business; removal ends access on the next request", async () => {
    const { addBusinessPersonAction, removeBusinessPersonAction, changeBusinessRoleAction } =
      await people();
    as(world.users.aAdmin);
    const email = unique("owner");
    const added = await addBusinessPersonAction({
      businessId: tenant("a1").businessId,
      email,
      role: "client_owner",
    });
    expect(added).toMatchObject({
      ok: true,
      value: { link: expect.stringMatching(/^\/auth\/confirm/) },
    });
    const owner = { id: await userIdOf(email), email };
    const session = await sessionOf(owner);
    expect(hasAnyAccess(session.access)).toBe(true);
    const visible = await t.db
      .asUser(owner)
      .run(({ tx }) => tx.select({ id: businessesTable.id }).from(businessesTable));
    expect(visible.map((row) => row.id)).toEqual([tenant("a1").businessId]);

    expect(
      await changeBusinessRoleAction({
        businessId: tenant("a1").businessId,
        userId: owner.id,
        role: "client_staff",
      }),
    ).toEqual({ ok: true, value: "Role changed to business staff." });
    expect(
      await removeBusinessPersonAction({ businessId: tenant("a1").businessId, userId: owner.id }),
    ).toMatchObject({ ok: true });

    // The very next request of the removed person: no access, no session for actions.
    as(owner);
    expect(
      await addBusinessPersonAction({
        businessId: tenant("a1").businessId,
        email: unique("x"),
        role: "client_staff",
      }),
    ).toEqual({
      ok: false,
      error: "Your session has ended. Sign in again.",
    });
    expect(hasAnyAccess((await sessionOf(owner)).access)).toBe(false);
    expect(
      await t.db
        .asUser(owner)
        .run(({ tx }) => tx.select({ id: businessesTable.id }).from(businessesTable)),
    ).toEqual([]);
  });

  it("agency members, client staff, other businesses and other agencies cannot manage client logins", async () => {
    const { addBusinessPersonAction, removeBusinessPersonAction, changeBusinessRoleAction } =
      await people();
    const businessId = tenant("a1").businessId;
    const add = { businessId, email: unique("blocked"), role: "client_staff" };
    const remove = { businessId, userId: world.users.a1Staff.id };
    const change = { businessId, userId: world.users.a1Staff.id, role: "client_owner" };
    as(world.users.aMember);
    for (const result of [
      await addBusinessPersonAction(add),
      await removeBusinessPersonAction(remove),
      await changeBusinessRoleAction(change),
    ]) {
      expect(result).toEqual({
        ok: false,
        error: "Only agency admins can manage this business's logins.",
      });
    }
    for (const user of [
      world.users.a1Staff,
      world.users.a1Owner, // the setting is off by default
      world.users.a2Owner,
      world.users.bAdmin,
      world.users.b1Owner,
    ]) {
      as(user);
      for (const result of [
        await addBusinessPersonAction(add),
        await removeBusinessPersonAction(remove),
        await changeBusinessRoleAction(change),
      ]) {
        expect(result, user.email ?? "").toEqual({
          ok: false,
          error: "That business was not found.",
        });
      }
    }
    // An admin cannot give themselves a client login either.
    as(world.users.aAdmin);
    expect(
      await addBusinessPersonAction({
        businessId,
        email: world.users.aAdmin.email!,
        role: "client_owner",
      }),
    ).toEqual({ ok: false, error: "You cannot change your own access. Ask another admin." });
    expect(await t.db.directory.findUserByEmail(add.email)).toBeNull();
    const staffStill = await sessionOf(world.users.a1Staff);
    expect(staffStill.access.businesses[0]?.role).toBe("client_staff");
  });

  it("a client owner manages their staff only with the setting on and client logins on, and only staff", async () => {
    const { addBusinessPersonAction, removeBusinessPersonAction, changeBusinessRoleAction } =
      await people();
    await setPortal("a1", { "client_portal.owner_manages_staff": true });
    await setPortal("a3", { "client_portal.owner_manages_staff": true });
    try {
      const businessId = tenant("a1").businessId;
      as(world.users.a1Owner);
      const email = unique("staff");
      const added = await addBusinessPersonAction({ businessId, email, role: "client_staff" });
      expect(added).toMatchObject({ ok: true });
      const staffId = await userIdOf(email);
      expect((await auditFor(staffId)).map((row) => [row.action, row.actor])).toEqual([
        ["business_membership.grant", world.users.a1Owner.id],
      ]);
      expect(
        await addBusinessPersonAction({ businessId, email: unique("o"), role: "client_owner" }),
      ).toEqual({
        ok: false,
        error: "You cannot give the role business owner.",
      });
      expect(
        await changeBusinessRoleAction({ businessId, userId: staffId, role: "client_staff" }),
      ).toEqual({
        ok: false,
        error: "Only agency admins change roles.",
      });
      expect(
        await removeBusinessPersonAction({ businessId, userId: world.users.a1Owner.id }),
      ).toEqual({
        ok: false,
        error: "You cannot change your own access. Ask another admin.",
      });
      // Another owner, added by the agency: the owner cannot remove them.
      as(world.users.aAdmin);
      const coOwnerEmail = unique("co-owner");
      await addBusinessPersonAction({ businessId, email: coOwnerEmail, role: "client_owner" });
      const coOwner = await userIdOf(coOwnerEmail);
      as(world.users.a1Owner);
      expect(await removeBusinessPersonAction({ businessId, userId: coOwner })).toEqual({
        ok: false,
        error: "You cannot remove a business owner.",
      });
      expect(await removeBusinessPersonAction({ businessId, userId: staffId })).toMatchObject({
        ok: true,
      });
      expect((await auditFor(staffId)).map((row) => row.action)).toEqual([
        "business_membership.grant",
        "business_membership.revoke",
      ]);
      // Not another business, and not with client logins off.
      expect(
        await addBusinessPersonAction({
          businessId: tenant("a2").businessId,
          email: unique("z"),
          role: "client_staff",
        }),
      ).toEqual({ ok: false, error: "That business was not found." });
      as(world.users.a3Owner);
      expect(
        await addBusinessPersonAction({
          businessId: tenant("a3").businessId,
          email: unique("z"),
          role: "client_staff",
        }),
      ).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
      as(world.users.aAdmin);
      await removeBusinessPersonAction({ businessId, userId: coOwner });
    } finally {
      await setPortal("a1", { "client_portal.owner_manages_staff": false });
      await setPortal("a3", { "client_portal.owner_manages_staff": false });
    }
  });

  it("tells the admin when the business has client logins switched off", async () => {
    const { addBusinessPersonAction, removeBusinessPersonAction } = await people();
    as(world.users.aAdmin);
    const email = unique("off");
    const added = await addBusinessPersonAction({
      businessId: tenant("a3").businessId,
      email,
      role: "client_owner",
    });
    expect(added).toMatchObject({
      ok: true,
      value: { message: expect.stringMatching(/switched off/) },
    });
    const id = await userIdOf(email);
    expect(hasAnyAccess((await sessionOf({ id, email })).access)).toBe(false);
    await removeBusinessPersonAction({ businessId: tenant("a3").businessId, userId: id });
  });
});

describe("invitations", () => {
  it("are limited per person over a rolling day, by the injected clock", async () => {
    let now = new Date();
    const actions = createPeopleActions({ inviter, now: () => now });
    const session = await sessionOf(world.users.bAdmin);
    const agencyId = world.agencies.b.agencyId;
    const added: UserId[] = [];
    for (let index = 0; index < INVITATIONS_PER_DAY; index += 1) {
      const email = unique(`limit-${index}`);
      await actions.addAgencyPerson(session, { agencyId, email, role: "agency_member" });
      added.push(await userIdOf(email));
    }
    const blocked = unique("over-limit");
    await expect(
      actions.addAgencyPerson(session, { agencyId, email: blocked, role: "agency_member" }),
    ).rejects.toThrow(/the most allowed/);
    // Refused before any account was made or email sent.
    expect(await t.db.directory.findUserByEmail(blocked)).toBeNull();
    // Removing people does not give invitations back; a day later there are new ones.
    await actions.removeAgencyPerson(session, { agencyId, userId: added[0]! });
    await expect(
      actions.addAgencyPerson(session, { agencyId, email: blocked, role: "agency_member" }),
    ).rejects.toThrow(/the most allowed/);
    now = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await actions.addAgencyPerson(session, { agencyId, email: blocked, role: "agency_member" });
    for (const userId of [...added.slice(1), await userIdOf(blocked)]) {
      await actions.removeAgencyPerson(session, { agencyId, userId });
    }
  });

  it("never logs an email address", async () => {
    const records: LogRecord[] = [];
    const stop = addLogListener((record) => records.push(record));
    try {
      const actions = createPeopleActions({ inviter });
      const session = await sessionOf(world.users.aAdmin);
      const email = unique("logged");
      await actions.addAgencyPerson(session, { agencyId: agencyA(), email, role: "agency_member" });
      const userId = await userIdOf(email);
      await actions.changeAgencyRole(session, {
        agencyId: agencyA(),
        userId,
        role: "agency_admin",
      });
      await actions.removeAgencyPerson(session, { agencyId: agencyA(), userId });
      await actions
        .addAgencyPerson(session, {
          agencyId: agencyA(),
          email: world.users.aMember.email!,
          role: "agency_member",
        })
        .catch(() => undefined);
    } finally {
      stop();
    }
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toMatch(/@people\.test|@world\.test/);
  });
});

describe("the Supabase inviter", () => {
  function fakeAdmin() {
    const calls: string[] = [];
    const admin: SupabaseAuthAdmin = {
      ensureUser: () => Promise.reject(new Error("not used")),
      async inviteUser({ email }) {
        calls.push("invite");
        return email.startsWith("taken")
          ? "exists"
          : { id: "00000000-0000-4000-8000-000000000001" as UserId };
      },
      async sendSignInLink() {
        calls.push("link");
      },
    };
    return { admin, calls };
  }

  it("invites a new address, sends a sign-in link to an existing account, and answers the same", async () => {
    const known = new Map<string, UserId>([
      ["known@example.com", "00000000-0000-4000-8000-000000000002" as UserId],
    ]);
    let lateId: UserId | null = null;
    const directory: Pick<Directory, "findUserByEmail"> = {
      async findUserByEmail(email) {
        const id = known.get(email) ?? (email.startsWith("taken") ? lateId : null);
        return id === null || id === undefined ? null : { id, email };
      },
    };
    const { admin, calls } = fakeAdmin();
    const supabase = createSupabaseInviter({ admin, directory, appUrl: "https://app.example.com" });
    const fresh = await supabase.invite("new@example.com");
    const existing = await supabase.invite("known@example.com");
    expect(fresh).toEqual({ userId: "00000000-0000-4000-8000-000000000001", link: null });
    expect(existing).toEqual({ userId: "00000000-0000-4000-8000-000000000002", link: null });
    expect(calls).toEqual(["invite", "link"]);
    // Supabase says "already registered" but the profile is not there yet: a clear error.
    await expect(supabase.invite("taken@example.com")).rejects.toThrow(/no profile/);
    lateId = "00000000-0000-4000-8000-000000000003" as UserId;
    // The profile shows up: the first lookup finds it and only a link is sent.
    expect(await supabase.invite("taken@example.com")).toEqual({ userId: lateId, link: null });
  });
});
