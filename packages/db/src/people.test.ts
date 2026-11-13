import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgencyId, UserId } from "@repo/core";

import { hasAnyAccess, loadUserAccess } from "./access";
import { PG_ERROR, pgConstraintName, pgErrorCode } from "./errors";
import type { Transaction } from "./internal/client";
import {
  changeAgencyRole,
  grantAgencyAccess,
  grantBusinessAccess,
  LAST_ADMIN_CONSTRAINT,
  listAgencyPeople,
  listBusinessPeople,
  revokeAgencyAccess,
  revokeBusinessAccess,
} from "./repositories/people";
import { agencyMemberships, auditLog, businesses, businessMemberships } from "./schema/tables";
import {
  type CastName,
  createTestDatabase,
  createWorld,
  type TestDatabase,
  type World,
} from "./testing";

/*
 * People management in the database (C18): who may write the membership tables directly, as
 * Supabase's REST API would let a signed-in user try; the last-admin rule under concurrency;
 * removal taking effect on the very next transaction; the audit entries of the repository.
 */

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});

afterAll(async () => {
  await t?.dispose();
});

type Rows = readonly Record<string, unknown>[];
const ROLLBACK = Symbol("rollback");

type Outcome =
  | { readonly ok: true; readonly rows: number }
  | { readonly ok: false; readonly code: string | null; readonly constraint: string | null };

/** Runs one statement as the user in a savepoint that is always rolled back. */
async function attempt(
  actor: CastName | UserId,
  statement: ReturnType<typeof sql>,
): Promise<Outcome> {
  const user =
    typeof actor === "string" && actor in world.users
      ? world.users[actor as CastName]
      : { id: actor as UserId };
  return t.db.asUser(user).run(async ({ tx }) => {
    const result: { done?: Outcome } = {};
    try {
      await tx.transaction(async (inner: Transaction) => {
        const rows = (await inner.execute(statement)) as unknown as Rows;
        result.done = { ok: true, rows: rows.length };
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a sentinel
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK && result.done !== undefined) return result.done;
      return { ok: false, code: pgErrorCode(error), constraint: pgConstraintName(error) };
    }
    throw new Error("unreachable");
  });
}

const refused = (outcome: Outcome) =>
  outcome.ok ? outcome.rows === 0 : outcome.code === PG_ERROR.insufficientPrivilege;
const changed = (outcome: Outcome) => outcome.ok && outcome.rows === 1;

const id = (name: CastName) => world.users[name].id;

function insertAgencyMember(agencyId: AgencyId, userId: UserId, role: string) {
  return sql`insert into agency_memberships (agency_id, user_id, role)
             values (${agencyId}::uuid, ${userId}::uuid, ${role}) returning 1 as one`;
}
function setAgencyRole(agencyId: AgencyId, userId: UserId, role: string) {
  return sql`update agency_memberships set role = ${role}
              where agency_id = ${agencyId}::uuid and user_id = ${userId}::uuid returning 1 as one`;
}
function deleteAgencyMember(agencyId: AgencyId, userId: UserId) {
  return sql`delete from agency_memberships
              where agency_id = ${agencyId}::uuid and user_id = ${userId}::uuid returning 1 as one`;
}
function insertClient(key: "a1" | "a2" | "a3" | "b1", userId: UserId, role: string) {
  const { agencyId, businessId } = world.businesses[key].tenant;
  return sql`insert into business_memberships (agency_id, business_id, user_id, role)
             values (${agencyId}::uuid, ${businessId}::uuid, ${userId}::uuid, ${role}) returning 1 as one`;
}
function setClientRole(key: "a1" | "a2" | "a3" | "b1", userId: UserId, role: string) {
  return sql`update business_memberships set role = ${role}
              where business_id = ${world.businesses[key].tenant.businessId}::uuid
                and user_id = ${userId}::uuid returning 1 as one`;
}
function deleteClient(key: "a1" | "a2" | "a3" | "b1", userId: UserId) {
  return sql`delete from business_memberships
              where business_id = ${world.businesses[key].tenant.businessId}::uuid
                and user_id = ${userId}::uuid returning 1 as one`;
}

async function freshUser(label: string): Promise<UserId> {
  const user = await t.db.localAuth.upsertUser({
    email: `${label}-${Math.random().toString(36).slice(2)}@people.test`,
  });
  return user.id;
}

describe("direct writes to the membership tables", () => {
  it("an agency admin writes their agency's memberships, never their own row", async () => {
    const a = world.agencies.a.agencyId;
    expect(
      changed(await attempt("aAdmin", insertAgencyMember(a, id("outsider"), "agency_member"))),
    ).toBe(true);
    expect(changed(await attempt("aAdmin", setAgencyRole(a, id("aMember"), "agency_admin")))).toBe(
      true,
    );
    expect(changed(await attempt("aAdmin", deleteAgencyMember(a, id("aMember"))))).toBe(true);
    expect(
      changed(await attempt("aAdmin", insertClient("a1", id("outsider"), "client_owner"))),
    ).toBe(true);
    expect(
      changed(await attempt("aAdmin", setClientRole("a1", id("a1Staff"), "client_owner"))),
    ).toBe(true);
    expect(changed(await attempt("aAdmin", deleteClient("a1", id("a1Owner"))))).toBe(true);

    // Their own row: no self-demotion, no self-removal, no client login for themselves.
    expect(refused(await attempt("aAdmin", setAgencyRole(a, id("aAdmin"), "agency_member")))).toBe(
      true,
    );
    expect(refused(await attempt("aAdmin", deleteAgencyMember(a, id("aAdmin"))))).toBe(true);
    expect(refused(await attempt("aAdmin", insertClient("a1", id("aAdmin"), "client_owner")))).toBe(
      true,
    );
  });

  it("agency members and client users cannot grant anyone access", async () => {
    const a = world.agencies.a.agencyId;
    for (const actor of ["aMember", "a1Owner", "a1Staff", "outsider"] as const) {
      const where = actor;
      expect(
        refused(await attempt(actor, insertAgencyMember(a, id("outsider"), "agency_admin"))),
        where,
      ).toBe(true);
      expect(
        refused(await attempt(actor, insertAgencyMember(a, id(actor), "agency_admin"))),
        where,
      ).toBe(true);
      expect(
        refused(await attempt(actor, setAgencyRole(a, id("aMember"), "agency_admin"))),
        where,
      ).toBe(true);
      expect(refused(await attempt(actor, deleteAgencyMember(a, id("aAdmin")))), where).toBe(true);
      // A client owner may be allowed to manage staff by a setting; that goes through the
      // server, never through a direct write, so the database refuses it here either way.
      expect(
        refused(await attempt(actor, insertClient("a1", id("outsider"), "client_staff"))),
        where,
      ).toBe(true);
      expect(
        refused(await attempt(actor, setClientRole("a1", id("a1Staff"), "client_owner"))),
        where,
      ).toBe(true);
      expect(
        refused(await attempt(actor, setClientRole("a1", id(actor), "client_owner"))),
        where,
      ).toBe(true);
      expect(refused(await attempt(actor, deleteClient("a1", id("a1Staff")))), where).toBe(true);
    }
  });

  it("nobody reaches the memberships of another agency or its businesses", async () => {
    const { a, b } = world.agencies;
    for (const [actor, other, business] of [
      ["aAdmin", b.agencyId, "b1"],
      ["bAdmin", a.agencyId, "a1"],
    ] as const) {
      expect(
        refused(await attempt(actor, insertAgencyMember(other, id("outsider"), "agency_admin"))),
      ).toBe(true);
      expect(
        refused(await attempt(actor, insertAgencyMember(other, id(actor), "agency_admin"))),
      ).toBe(true);
      expect(
        refused(
          await attempt(
            actor,
            setAgencyRole(other, id(actor === "aAdmin" ? "bMember" : "aMember"), "agency_admin"),
          ),
        ),
      ).toBe(true);
      expect(
        refused(
          await attempt(
            actor,
            deleteAgencyMember(other, id(actor === "aAdmin" ? "bAdmin" : "aAdmin")),
          ),
        ),
      ).toBe(true);
      expect(
        refused(await attempt(actor, insertClient(business, id("outsider"), "client_owner"))),
      ).toBe(true);
      expect(
        refused(
          await attempt(
            actor,
            deleteClient(business, id(business === "b1" ? "b1Owner" : "a1Owner")),
          ),
        ),
      ).toBe(true);
    }
    // Moving a membership into another agency.
    const move = sql`update agency_memberships set agency_id = ${b.agencyId}::uuid
                      where agency_id = ${a.agencyId}::uuid and user_id = ${id("aMember")}::uuid returning 1 as one`;
    expect((await attempt("aAdmin", move)).ok).toBe(false);
  });
});

describe("an agency keeps one agency admin", () => {
  it("refuses removing or demoting the last admin, whoever asks", async () => {
    const a = world.agencies.a.agencyId;
    for (const statement of [
      deleteAgencyMember(a, id("aAdmin")),
      setAgencyRole(a, id("aAdmin"), "agency_member"),
    ]) {
      // The system scope has no "own row" rule; the trigger still says no.
      const outcome = await t.db.forAgency(a).run(async ({ tx }) => {
        try {
          await tx.transaction((inner) => inner.execute(statement));
          return null;
        } catch (error) {
          return { code: pgErrorCode(error), constraint: pgConstraintName(error) };
        }
      });
      expect(outcome).toEqual({ code: PG_ERROR.checkViolation, constraint: LAST_ADMIN_CONSTRAINT });
    }
    const [row] = await t.admin
      .select({ role: agencyMemberships.role })
      .from(agencyMemberships)
      .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.userId, id("aAdmin"))));
    expect(row?.role).toBe("agency_admin");
  });

  it("lets a second admin demote the first, and then not the other way round", async () => {
    const a = world.agencies.a.agencyId;
    const second = await freshUser("second-admin");
    await t.admin
      .insert(agencyMemberships)
      .values({ agencyId: a, userId: second, role: "agency_admin" });
    try {
      const outcome = await t.db.asUser({ id: second }).run(async ({ tx }) => {
        await tx.execute(setAgencyRole(a, id("aAdmin"), "agency_member"));
        // Now the second admin is the last one: the former admin is a member and cannot
        // write, and the system scope cannot demote the second one either.
        return "done";
      });
      expect(outcome).toBe("done");
      expect(refused(await attempt("aAdmin", setAgencyRole(a, second, "agency_member")))).toBe(
        true,
      );
      const last = await attempt(second, deleteAgencyMember(a, second));
      expect(refused(last)).toBe(true);
    } finally {
      await t.admin
        .update(agencyMemberships)
        .set({ role: "agency_admin" })
        .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.userId, id("aAdmin"))));
      await t.admin
        .delete(agencyMemberships)
        .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.userId, second)));
    }
  });

  it("two admins demoting each other at the same moment: exactly one succeeds", async () => {
    const a = world.agencies.a.agencyId;
    const second = await freshUser("racing-admin");
    await t.admin
      .insert(agencyMemberships)
      .values({ agencyId: a, userId: second, role: "agency_admin" });
    try {
      let firstUpdated!: () => void;
      const firstHasUpdated = new Promise<void>((resolve) => {
        firstUpdated = resolve;
      });
      // The second admin demotes aAdmin and keeps the transaction open until aAdmin's own
      // attempt is waiting for the agency's lock; only then does it commit.
      const first = t.db.asUser({ id: second }).run(async ({ tx }) => {
        await tx.execute(setAgencyRole(a, id("aAdmin"), "agency_member"));
        firstUpdated();
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = (await t.admin.execute(sql`
            select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'
               and query like '%agency_memberships%'`)) as unknown as Rows;
          if (Number(waiting[0]?.["n"]) > 0) break;
          if (Date.now() > deadline)
            throw new Error("The second demotion never waited for the lock.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return "committed";
      });
      await firstHasUpdated;
      const secondAttempt = t.db
        .asUser(world.users.aAdmin)
        .run(({ tx }) => tx.execute(setAgencyRole(a, second, "agency_member")))
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, constraint: pgConstraintName(error) }),
        );
      expect(await first).toBe("committed");
      expect(await secondAttempt).toEqual({ ok: false, constraint: LAST_ADMIN_CONSTRAINT });
      const admins = await t.admin
        .select({ userId: agencyMemberships.userId })
        .from(agencyMemberships)
        .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.role, "agency_admin")));
      expect(admins.map((row) => row.userId)).toEqual([second]);
    } finally {
      await t.admin
        .update(agencyMemberships)
        .set({ role: "agency_admin" })
        .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.userId, id("aAdmin"))));
      await t.admin
        .delete(agencyMemberships)
        .where(and(eq(agencyMemberships.agencyId, a), eq(agencyMemberships.userId, second)));
    }
  });

  it("still lets the platform delete an agency, or an account, that has a single admin", async () => {
    const owner = await freshUser("solo-admin");
    const agency = await t.db.platform.createAgency({ name: "Solo", slug: `solo-${Date.now()}` });
    await t.admin
      .insert(agencyMemberships)
      .values({ agencyId: agency.id, userId: owner, role: "agency_admin" });
    await t.db.platform.deleteAgency(agency.id);

    const other = await t.db.platform.createAgency({ name: "Solo 2", slug: `solo2-${Date.now()}` });
    await t.admin
      .insert(agencyMemberships)
      .values({ agencyId: other.id, userId: owner, role: "agency_admin" });
    await t.db.localAuth.deleteUser(owner);
    const left = await t.admin
      .select()
      .from(agencyMemberships)
      .where(eq(agencyMemberships.agencyId, other.id));
    expect(left).toEqual([]);
    await t.db.platform.deleteAgency(other.id);
  });
});

describe("removing access", () => {
  it("takes effect on the person's next request, not at the end of their session", async () => {
    const { a1 } = world.businesses;
    const person = await freshUser("removed-owner");
    await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) =>
        grantBusinessAccess(ctx, { ...a1.tenant, userId: person, role: "client_owner" }),
      );
    const request = () =>
      t.db.asUser({ id: person }).run(async (ctx) => ({
        access: await loadUserAccess(ctx),
        businesses: await ctx.tx.select({ id: businesses.id }).from(businesses),
      }));
    const before = await request();
    expect(hasAnyAccess(before.access)).toBe(true);
    expect(before.businesses.map((row) => row.id)).toEqual([a1.tenant.businessId]);

    await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => revokeBusinessAccess(ctx, { ...a1.tenant, userId: person }));
    const after = await request();
    expect(hasAnyAccess(after.access)).toBe(false);
    expect(after.businesses).toEqual([]);
  });

  it("an agency member removed from the team loses every business at once", async () => {
    const { a } = world.agencies;
    const person = await freshUser("removed-member");
    await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) =>
        grantAgencyAccess(ctx, { agencyId: a.agencyId, userId: person, role: "agency_member" }),
      );
    const see = () =>
      t.db
        .asUser({ id: person })
        .run(({ tx }) => tx.select({ id: businesses.id }).from(businesses));
    expect(await see()).toHaveLength(3);
    await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => revokeAgencyAccess(ctx, { agencyId: a.agencyId, userId: person }));
    expect(await see()).toHaveLength(0);
  });
});

describe("the people repository", () => {
  it("audits every grant, role change and removal with the person who did it, by user id only", async () => {
    const { a } = world.agencies;
    const { a2 } = world.businesses;
    const person = await freshUser("audited");
    await t.db.asUser(world.users.aAdmin).run(async (ctx) => {
      expect(
        await grantAgencyAccess(ctx, {
          agencyId: a.agencyId,
          userId: person,
          role: "agency_member",
        }),
      ).toBe("granted");
      expect(
        await grantAgencyAccess(ctx, {
          agencyId: a.agencyId,
          userId: person,
          role: "agency_admin",
        }),
      ).toBe("exists");
      expect(
        await changeAgencyRole(ctx, { agencyId: a.agencyId, userId: person, role: "agency_admin" }),
      ).toBe(true);
      expect(await revokeAgencyAccess(ctx, { agencyId: a.agencyId, userId: person })).toBe(true);
      expect(await revokeAgencyAccess(ctx, { agencyId: a.agencyId, userId: person })).toBe(false);
    });
    // A client owner's change made by the server in the business's system scope.
    await t.db.forBusiness(a2.tenant.businessId).run(async (ctx) => {
      expect(
        await grantBusinessAccess(
          ctx,
          { ...a2.tenant, userId: person, role: "client_staff" },
          { userId: id("a2Owner"), label: null },
        ),
      ).toBe("granted");
      expect((await listBusinessPeople(ctx, a2.tenant.businessId)).map((p) => p.userId)).toContain(
        person,
      );
    });
    const entries = await t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, person)));
    expect(entries.map((entry) => [entry.action, entry.actorUserId]).sort()).toEqual(
      [
        ["agency_membership.grant", id("aAdmin")],
        ["agency_membership.role_change", id("aAdmin")],
        ["agency_membership.revoke", id("aAdmin")],
        ["business_membership.grant", id("a2Owner")],
      ].sort(),
    );
    expect(
      JSON.stringify(
        entries.map((entry) => [entry.summary, entry.before, entry.after, entry.metadata]),
      ),
    ).not.toMatch(/@/);
    const since = new Date(Date.now() - 60_000);
    expect(await t.db.directory.countAccessGrantsSince(id("aAdmin"), since)).toBeGreaterThanOrEqual(
      1,
    );
    expect(await t.db.directory.countAccessGrantsSince(id("a2Owner"), since)).toBe(1);
    expect(await t.db.directory.countAccessGrantsSince(id("bAdmin"), since)).toBe(0);
    await t.admin.delete(businessMemberships).where(eq(businessMemberships.userId, person));
  });

  it("lists people with their roles, as far as the person asking may see", async () => {
    const { a, b } = world.agencies;
    const team = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => listAgencyPeople(ctx, a.agencyId));
    expect(team.map((person) => person.role)).toEqual(["agency_admin", "agency_member"]);
    expect(team.map((person) => person.userId)).toEqual([id("aAdmin"), id("aMember")]);
    const foreign = await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => listAgencyPeople(ctx, b.agencyId));
    expect(foreign).toEqual([]);
    const ownTeam = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => listBusinessPeople(ctx, world.businesses.a1.tenant.businessId));
    expect(ownTeam.map((person) => person.role)).toEqual(["client_owner", "client_staff"]);
    const staffView = await t.db
      .asUser(world.users.a1Staff)
      .run((ctx) => listBusinessPeople(ctx, world.businesses.a1.tenant.businessId));
    expect(staffView.map((person) => person.userId)).toEqual([id("a1Staff")]);
  });
});
