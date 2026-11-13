import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AgencyId,
  type BusinessId,
  type ChannelConnectionId,
  type ContactId,
  type ConversationId,
  createLogger,
  type LogRecord,
  NotFoundError,
  TenantAccessError,
  type UserId,
  ValidationError,
} from "@repo/core";

import {
  agencyRoleOf,
  businessRoleOf,
  hasAnyAccess,
  loadUserAccess,
  requireAgencyRole,
  requireBusinessRole,
} from "./access";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "./api-keys";
import { createKeyring, SecretDecryptionError } from "./crypto/secrets";
import { createDatabase } from "./database";
import { isUniqueViolation, PG_ERROR, pgErrorCode } from "./errors";
import { recordSystemAudit, recordUserAudit } from "./repositories/audit";
import {
  apiKeys,
  auditLog,
  businesses,
  businessMemberships,
  channelConnections,
  channelConnectionSecrets,
  contacts,
  integrationConnections,
  conversations,
  knowledgeItems,
  messages,
  settingValues,
  takeoverLocks,
  users,
} from "./schema/tables";
import {
  createTestDatabase,
  createWorld,
  TEST_ENCRYPTION_KEY,
  type TestDatabase,
  type World,
} from "./testing";

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
const UNKNOWN_ID = "0c9f3d1e-52a7-4c1b-9e7a-6f1d2b3c4d5e";

describe("forBusiness", () => {
  it("hands the callback the tenant of the business", async () => {
    const { a1 } = world.businesses;
    const tenant = await t.db.forBusiness(a1.tenant.businessId).run(async (ctx) => ctx.tenant);
    expect(tenant).toEqual(a1.tenant);
  });

  it("runs as app_system with the tenant in transaction-local settings", async () => {
    const { a1 } = world.businesses;
    const rows = await t.db.forBusiness(a1.tenant.businessId).run(
      async ({ tx }) =>
        (await tx.execute(sql`
          select current_user as role,
                 app.scope_agency_id() as agency,
                 app.scope_business_id() as business,
                 app.scope_agency_wide_id() as agency_wide,
                 current_setting('request.jwt.claims', true) as claims`)) as unknown as Rows,
    );
    expect(rows[0]).toEqual({
      role: "app_system",
      agency: a1.tenant.agencyId,
      business: a1.tenant.businessId,
      agency_wide: null,
      claims: "",
    });
  });

  it("fails with NotFoundError for an unknown business", async () => {
    await expect(
      t.db.forBusiness(UNKNOWN_ID as BusinessId).run(async () => "reached"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an id that is not a UUID before touching the database", () => {
    expect(() => t.db.forBusiness("1; drop table users" as BusinessId)).toThrow(TenantAccessError);
    expect(() => t.db.forAgency("" as AgencyId)).toThrow(TenantAccessError);
    expect(() => t.db.asUser({ id: "nobody" as UserId })).toThrow(TenantAccessError);
  });

  it("refuses a business that is not in the expected agency", async () => {
    const { a1 } = world.businesses;
    const { b } = world.agencies;
    await expect(
      t.db.forBusiness(a1.tenant.businessId, { agencyId: b.agencyId }).run(async () => "reached"),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      t.db
        .forBusiness(a1.tenant.businessId, { agencyId: a1.tenant.agencyId })
        .run(async () => "reached"),
    ).resolves.toBe("reached");
  });

  it("commits when the callback resolves and rolls back when it throws", async () => {
    const { a1 } = world.businesses;
    const scope = t.db.forBusiness(a1.tenant.businessId);
    await scope.run(async ({ tx, tenant }) => {
      await tx.insert(contacts).values({ ...tenant, displayName: "Committed" });
    });
    await expect(
      scope.run(async ({ tx, tenant }) => {
        await tx.insert(contacts).values({ ...tenant, displayName: "Rolled back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const names = await scope.run(({ tx }) =>
      tx.select({ name: contacts.displayName }).from(contacts),
    );
    expect(names.map((row) => row.name)).toContain("Committed");
    expect(names.map((row) => row.name)).not.toContain("Rolled back");
  });

  it("turns a refusal by row-level security into a TenantAccessError", async () => {
    const { a1, b1 } = world.businesses;
    const attempt = t.db.forBusiness(a1.tenant.businessId).run(async ({ tx }) => {
      await tx.insert(contacts).values({ ...b1.tenant, displayName: "Smuggled" });
    });
    await expect(attempt).rejects.toBeInstanceOf(TenantAccessError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect(pgErrorCode(error)).toBe(PG_ERROR.insufficientPrivilege);
    expect((error as TenantAccessError).retryable).toBe(false);
    expect((error as TenantAccessError).details).toEqual({ table: "contacts" });
  });

  it("a query without any tenant predicate still sees only its own business", async () => {
    const { a1, a2 } = world.businesses;
    for (const business of [a1, a2]) {
      const rows = await t.db
        .forBusiness(business.tenant.businessId)
        .run(({ tx }) => tx.select({ businessId: messages.businessId }).from(messages));
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.businessId))).toEqual(
        new Set([business.tenant.businessId]),
      );
    }
  });

  it("leaves nothing behind on the connection for the next transaction", async () => {
    // One connection, so every run reuses it.
    const single = createDatabase({
      url: t.url,
      max: 1,
      keyring: createKeyring({ id: "test", key: TEST_ENCRYPTION_KEY }),
    });
    try {
      const { a1 } = world.businesses;
      await single.forBusiness(a1.tenant.businessId).run(async () => undefined);
      await single.asUser(world.users.aAdmin).run(async () => undefined);
      const rows = await single.forAgency(world.agencies.b.agencyId).run(
        async ({ tx }) =>
          (await tx.execute(sql`
            select app.scope_business_id() as business,
                   current_setting('request.jwt.claim.sub', true) as sub,
                   app.scope_agency_id() as agency`)) as unknown as Rows,
      );
      expect(rows[0]).toEqual({ business: null, sub: "", agency: world.agencies.b.agencyId });
      await single.ping();
    } finally {
      await single.close();
    }
  });

  it("keeps concurrent scopes apart", async () => {
    const targets = [world.businesses.a1, world.businesses.a2, world.businesses.b1];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) => {
        const business = targets[index % targets.length]!;
        return t.db.forBusiness(business.tenant.businessId).run(async ({ tx }) => {
          const rows = await tx.select({ businessId: contacts.businessId }).from(contacts);
          return {
            expected: business.tenant.businessId,
            seen: new Set(rows.map((r) => r.businessId)),
          };
        });
      }),
    );
    for (const result of results) {
      expect(result.seen).toEqual(new Set([result.expected]));
    }
  });

  it("supports read-only transactions", async () => {
    const { a1 } = world.businesses;
    const attempt = t.db.forBusiness(a1.tenant.businessId).run(
      async ({ tx, tenant }) => {
        await tx.insert(contacts).values({ ...tenant, displayName: "No" });
      },
      { readOnly: true },
    );
    await expect(attempt).rejects.toSatisfy((error) => pgErrorCode(error) === "25006");
  });
});

describe("errors of failed statements", () => {
  // The database library words a failed statement as "Failed query: <sql> params: <values>".
  // The values are customer data; an error's text goes to logs, Sentry, the job runner's run
  // history and stored error messages, so they must be gone before the error leaves `run()`.
  const NAME = "Priya Private-Person";
  const EMAIL = "priya.private@example.com";
  const PHONE = "+13035550142";

  function everyText(error: unknown): string {
    const parts: string[] = [];
    for (let current = error, depth = 0; depth < 6 && current instanceof Error; depth += 1) {
      parts.push(current.message, current.stack ?? "", JSON.stringify(current));
      current = current.cause;
    }
    return parts.join("\n");
  }

  function logged(error: unknown): string {
    const records: LogRecord[] = [];
    createLogger({ sink: (record) => records.push(record) }).error("job.failed", { error });
    return JSON.stringify(records);
  }

  it("never carry the statement's values, whatever refused the statement", async () => {
    const { a1, b1 } = world.businesses;
    const id = "5a0c7b1e-3f2d-4e6a-9b8c-7d6e5f4a3b2c" as ContactId;
    const row = { id, displayName: NAME, email: EMAIL, phone: PHONE };
    const scope = t.db.forBusiness(a1.tenant.businessId);
    await scope.run(({ tx }) => tx.insert(contacts).values({ ...a1.tenant, ...row }));

    // A constraint (the same id again), and row-level security (another agency's tenant).
    const failures = [
      () => scope.run(({ tx }) => tx.insert(contacts).values({ ...a1.tenant, ...row })),
      () =>
        scope.run(({ tx }) =>
          tx.insert(contacts).values({ ...b1.tenant, ...row, id: UNKNOWN_ID as never }),
        ),
    ];
    const errors: unknown[] = [];
    for (const failure of failures) {
      await failure().catch((error: unknown) => errors.push(error));
    }
    expect(errors).toHaveLength(2);
    expect(pgErrorCode(errors[0])).toBe(PG_ERROR.uniqueViolation);
    expect(errors[1]).toBeInstanceOf(TenantAccessError);
    for (const error of errors) {
      const text = `${everyText(error)}\n${logged(error)}`;
      // Still says which statement failed, without what it was given.
      expect(text).toContain("Failed query");
      expect(text).toContain('insert into "contacts"');
      for (const leak of [NAME, "Private-Person", EMAIL, PHONE]) {
        expect(text, leak).not.toContain(leak);
      }
    }
  });

  it("holds for the cross-tenant helpers too", async () => {
    const value = "not-an-id-but-a-customer's-words";
    const error = await t.db.directory
      .findBusiness(value as BusinessId)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed query");
    expect((error as Error).message).not.toContain(value);
    expect((error as Error).stack ?? "").not.toContain(`params: ${value}`);
  });
});

describe("forAgency", () => {
  it("covers every business of the agency and nothing else", async () => {
    const { a } = world.agencies;
    const rows = await t.db.forAgency(a.agencyId).run(async ({ tx, tenant }) => {
      expect(tenant).toEqual({ agencyId: a.agencyId });
      return tx.select({ id: businesses.id, agencyId: businesses.agencyId }).from(businesses);
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.agencyId))).toEqual(new Set([a.agencyId]));
  });

  it("fails with NotFoundError for an unknown agency", async () => {
    await expect(
      t.db.forAgency(UNKNOWN_ID as AgencyId).run(async () => "reached"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("asUser", () => {
  it("runs as authenticated with the user's claims", async () => {
    const user = world.users.aMember;
    const rows = await t.db.asUser(user).run(
      async ({ tx }) =>
        (await tx.execute(sql`
          select current_user as role, auth.uid() as uid, auth.role() as claim_role,
                 auth.jwt() ->> 'email' as email,
                 current_setting('app.agency_id', true) as scope`)) as unknown as Rows,
    );
    expect(rows[0]).toEqual({
      role: "authenticated",
      uid: user.id,
      claim_role: "authenticated",
      email: user.email,
      scope: "",
    });
  });

  it("each restricted role can call only its own helper functions", async () => {
    const asUser = t.db
      .asUser(world.users.aAdmin)
      .run(({ tx }) => tx.execute(sql`select app.scope_agency_id()`));
    await expect(asUser).rejects.toBeInstanceOf(TenantAccessError);
    const asSystem = t.db
      .forAgency(world.agencies.a.agencyId)
      .run(({ tx }) => tx.execute(sql`select app.staff_agency_ids()`));
    await expect(asSystem).rejects.toBeInstanceOf(TenantAccessError);
    for (const fn of ["sync_table_privileges", "reject_update", "sync_auth_user"]) {
      const attempt = t.db
        .asUser(world.users.aAdmin)
        .run(({ tx }) => tx.execute(sql.raw(`select app.${fn}()`)));
      await expect(attempt, fn).rejects.toBeInstanceOf(TenantAccessError);
    }
  });

  it("cannot reach the credential tables at all", async () => {
    const attempt = t.db
      .asUser(world.users.aAdmin)
      .run(({ tx }) => tx.select().from(channelConnectionSecrets));
    await expect(attempt).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("a write the user may not make fails loudly", async () => {
    const { a1 } = world.businesses;
    const attempt = t.db.asUser(world.users.a1Owner).run(async ({ tx }) => {
      await tx.insert(knowledgeItems).values({ ...a1.tenant, category: "faq", content: "Mine" });
    });
    await expect(attempt).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe("loadUserAccess", () => {
  const accessOf = (name: keyof World["users"]) =>
    t.db.asUser(world.users[name]).run((ctx) => loadUserAccess(ctx));

  it("reports agency staff with their role", async () => {
    const { a, b } = world.agencies;
    const { a1, b1 } = world.businesses;
    const admin = await accessOf("aAdmin");
    expect(admin.agencies).toEqual([{ agencyId: a.agencyId, role: "agency_admin" }]);
    expect(admin.businesses).toEqual([]);
    expect(hasAnyAccess(admin)).toBe(true);
    expect(agencyRoleOf(admin, a.agencyId)).toBe("agency_admin");
    expect(agencyRoleOf(admin, b.agencyId)).toBeNull();
    expect(businessRoleOf(admin, a1.tenant)).toBe("agency_admin");
    expect(businessRoleOf(admin, b1.tenant)).toBeNull();

    const member = await accessOf("aMember");
    expect(requireAgencyRole(member, a.agencyId)).toBe("agency_member");
    expect(() => requireAgencyRole(member, a.agencyId, ["agency_admin"])).toThrow(
      TenantAccessError,
    );
    expect(() => requireAgencyRole(member, b.agencyId)).toThrow(TenantAccessError);
    expect(requireBusinessRole(member, a1.tenant)).toBe("agency_member");
    expect(() => requireBusinessRole(member, b1.tenant)).toThrow(TenantAccessError);
  });

  it("reports client users with their business, and whether logins are on", async () => {
    const { a1, a2, a3 } = world.businesses;
    const owner = await accessOf("a1Owner");
    expect(owner.agencies).toEqual([]);
    expect(owner.businesses).toEqual([{ ...a1.tenant, role: "client_owner", enabled: true }]);
    expect(businessRoleOf(owner, a1.tenant)).toBe("client_owner");
    expect(businessRoleOf(owner, a2.tenant)).toBeNull();
    expect(() => requireBusinessRole(owner, a1.tenant, ["agency_admin", "agency_member"])).toThrow(
      TenantAccessError,
    );

    const staff = await accessOf("a1Staff");
    expect(requireBusinessRole(staff, a1.tenant)).toBe("client_staff");

    const lockedOut = await accessOf("a3Owner");
    expect(lockedOut.businesses).toEqual([{ ...a3.tenant, role: "client_owner", enabled: false }]);
    expect(hasAnyAccess(lockedOut)).toBe(false);
    expect(businessRoleOf(lockedOut, a3.tenant)).toBeNull();
  });

  it("reports nothing for a user without memberships", async () => {
    const outsider = await accessOf("outsider");
    expect(outsider).toEqual({ userId: world.users.outsider.id, agencies: [], businesses: [] });
    expect(hasAnyAccess(outsider)).toBe(false);
  });

  it("never lists other people's memberships, even for staff who can see them", async () => {
    const access = await accessOf("aAdmin");
    expect(access.businesses).toEqual([]);
    const visible = await t.db
      .asUser(world.users.aAdmin)
      .run(({ tx }) => tx.select({ id: businessMemberships.id }).from(businessMemberships));
    expect(visible.length).toBeGreaterThan(0);
  });
});

describe("credential stores", () => {
  const Credentials = z.object({ accessToken: z.string(), refreshToken: z.string() });
  const connectionOf = (key: keyof World["businesses"], which: "fixture" | "spare" = "spare") =>
    world.businesses[key].rows.get("channel_connections")?.[which] as ChannelConnectionId;

  it("stores credentials encrypted and reads them back in the owning business only", async () => {
    const { a1, a2 } = world.businesses;
    const connectionId = connectionOf("a1");
    const credentials = { accessToken: "EAAG-very-secret", refreshToken: "refresh-me" };

    await t.db.forBusiness(a1.tenant.businessId).run(async (ctx) => {
      await t.db.secrets.channel.write(ctx, connectionId, credentials);
      expect(await t.db.secrets.channel.read(ctx, connectionId, Credentials)).toEqual(credentials);
    });

    const [stored] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, connectionId));
    expect(stored?.keyId).toBe("test");
    expect(stored?.ciphertext).toMatch(/^v1\.test\./);
    expect(JSON.stringify(stored)).not.toContain("EAAG-very-secret");
    expect(JSON.stringify(stored)).not.toContain("refresh-me");

    // Another business's scope does not see the row.
    const fromSibling = await t.db
      .forBusiness(a2.tenant.businessId)
      .run((ctx) => t.db.secrets.channel.read(ctx, connectionId));
    expect(fromSibling).toBeNull();
  });

  it("cannot write credentials for another business's connection", async () => {
    const { a1, a2 } = world.businesses;
    const refusedCodes: (string | null)[] = [
      PG_ERROR.foreignKeyViolation,
      PG_ERROR.insufficientPrivilege,
    ];
    // a1's connection already has credentials: the overwrite is refused by row-level security.
    const overwrite = t.db
      .forBusiness(a2.tenant.businessId)
      .run((ctx) => t.db.secrets.channel.write(ctx, connectionOf("a1"), { stolen: true }));
    await expect(overwrite).rejects.toSatisfy((error) => refusedCodes.includes(pgErrorCode(error)));
    // a3's connection has none: the new row is refused by the connection foreign key.
    const plant = t.db
      .forBusiness(a2.tenant.businessId)
      .run((ctx) => t.db.secrets.channel.write(ctx, connectionOf("a3"), { planted: true }));
    await expect(plant).rejects.toSatisfy((error) => refusedCodes.includes(pgErrorCode(error)));

    const untouched = await t.db
      .forBusiness(a1.tenant.businessId)
      .run((ctx) => t.db.secrets.channel.read(ctx, connectionOf("a1")));
    expect(untouched).toEqual({ accessToken: "EAAG-very-secret", refreshToken: "refresh-me" });
  });

  it("an envelope copied onto another tenant's row does not decrypt", async () => {
    const { a1, b1 } = world.businesses;
    const source = connectionOf("a1");
    const target = connectionOf("b1");
    await t.db
      .forBusiness(a1.tenant.businessId)
      .run((ctx) =>
        t.db.secrets.channel.write(ctx, source, { accessToken: "a", refreshToken: "b" }),
      );
    const [stored] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, source));
    await t.admin.insert(channelConnectionSecrets).values({
      connectionId: target,
      ...b1.tenant,
      ciphertext: stored?.ciphertext ?? "",
      keyId: "test",
    });
    try {
      await expect(
        t.db.forBusiness(b1.tenant.businessId).run((ctx) => t.db.secrets.channel.read(ctx, target)),
      ).rejects.toBeInstanceOf(SecretDecryptionError);
    } finally {
      await t.admin
        .delete(channelConnectionSecrets)
        .where(eq(channelConnectionSecrets.connectionId, target));
    }
  });

  it("serialises concurrent updates, so a token is refreshed once at a time", async () => {
    const { a2 } = world.businesses;
    const connectionId = connectionOf("a2");
    const Counter = z.object({ refreshes: z.number() });
    const scope = t.db.forBusiness(a2.tenant.businessId);
    await scope.run((ctx) => t.db.secrets.channel.write(ctx, connectionId, { refreshes: 0 }));

    const refresh = () =>
      scope.run((ctx) =>
        t.db.secrets.channel.update(
          ctx,
          connectionId,
          async (current) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { refreshes: (current?.refreshes ?? 0) + 1 };
          },
          Counter,
        ),
      );
    await Promise.all([refresh(), refresh(), refresh()]);
    const result = await scope.run((ctx) => t.db.secrets.channel.read(ctx, connectionId, Counter));
    expect(result).toEqual({ refreshes: 3 });
  });

  it("re-encrypts with the new primary key after a rotation", async () => {
    const { b1 } = world.businesses;
    const connectionId = connectionOf("b1");
    await t.db
      .forBusiness(b1.tenant.businessId)
      .run((ctx) =>
        t.db.secrets.channel.write(ctx, connectionId, { accessToken: "x", refreshToken: "y" }),
      );

    const rotated = createDatabase({
      url: t.url,
      max: 1,
      keyring: createKeyring({ id: "next", key: Buffer.alloc(32, 9).toString("base64") }, [
        { id: "test", key: TEST_ENCRYPTION_KEY },
      ]),
    });
    try {
      const scope = rotated.forBusiness(b1.tenant.businessId);
      expect(await scope.run((ctx) => rotated.secrets.channel.read(ctx, connectionId))).toEqual({
        accessToken: "x",
        refreshToken: "y",
      });
      expect(await scope.run((ctx) => rotated.secrets.channel.reencrypt(ctx, connectionId))).toBe(
        true,
      );
      expect(await scope.run((ctx) => rotated.secrets.channel.reencrypt(ctx, connectionId))).toBe(
        false,
      );
      const [stored] = await t.admin
        .select({ keyId: channelConnectionSecrets.keyId })
        .from(channelConnectionSecrets)
        .where(eq(channelConnectionSecrets.connectionId, connectionId));
      expect(stored?.keyId).toBe("next");
      expect(
        await scope.run((ctx) => rotated.secrets.channel.read(ctx, connectionId, Credentials)),
      ).toEqual({
        accessToken: "x",
        refreshToken: "y",
      });
      await scope.run((ctx) => rotated.secrets.channel.remove(ctx, connectionId));
      expect(await scope.run((ctx) => rotated.secrets.channel.read(ctx, connectionId))).toBeNull();
    } finally {
      await rotated.close();
    }
  });

  it("stores integration credentials the same way", async () => {
    const { a1 } = world.businesses;
    const connectionId = a1.rows.get("integration_connections")?.spare as never;
    await t.db.forBusiness(a1.tenant.businessId).run(async (ctx) => {
      await t.db.secrets.integration.write(ctx, connectionId, { apiKey: "crm-key" });
      expect(await t.db.secrets.integration.read(ctx, connectionId)).toEqual({ apiKey: "crm-key" });
      await t.db.secrets.integration.remove(ctx, connectionId);
    });
  });
});

describe("audit helpers", () => {
  it("records a user's action under the user's own name", async () => {
    const { a1 } = world.businesses;
    await t.db.asUser(world.users.aMember).run((ctx) =>
      recordUserAudit(ctx, a1.tenant, {
        action: "knowledge.update",
        targetType: "knowledge_item",
        targetId: "k-1",
        summary: "Edited the service area",
        before: { content: "old" },
        after: { content: "new" },
      }),
    );
    const [row] = await t.admin
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "knowledge.update"));
    expect(row).toMatchObject({
      ...a1.tenant,
      actorType: "user",
      actorUserId: world.users.aMember.id,
      actorLabel: world.users.aMember.email,
      targetId: "k-1",
      before: { content: "old" },
      after: { content: "new" },
    });
  });

  it("refuses an entry from a client user or for another agency", async () => {
    const { a1, b1 } = world.businesses;
    await expect(
      t.db
        .asUser(world.users.a1Owner)
        .run((ctx) => recordUserAudit(ctx, a1.tenant, { action: "x.y" })),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      t.db
        .asUser(world.users.aAdmin)
        .run((ctx) => recordUserAudit(ctx, b1.tenant, { action: "x.y" })),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("records system actions with the scope's tenant", async () => {
    const { a1 } = world.businesses;
    await t.db
      .forBusiness(a1.tenant.businessId)
      .run((ctx) =>
        recordSystemAudit(
          ctx,
          { type: "system", label: "pipeline-reply" },
          { action: "job.business" },
        ),
      );
    await t.db
      .forAgency(a1.tenant.agencyId)
      .run((ctx) =>
        recordSystemAudit(
          ctx,
          { type: "user", userId: world.users.aAdmin.id, label: "admin" },
          { action: "job.agency" },
        ),
      );
    const rows = await t.admin
      .select({
        action: auditLog.action,
        businessId: auditLog.businessId,
        actorType: auditLog.actorType,
        actorUserId: auditLog.actorUserId,
        actorLabel: auditLog.actorLabel,
      })
      .from(auditLog)
      .where(sql`${auditLog.action} like 'job.%'`)
      .orderBy(auditLog.action);
    expect(rows).toEqual([
      {
        action: "job.agency",
        businessId: null,
        actorType: "user",
        actorUserId: world.users.aAdmin.id,
        actorLabel: "admin",
      },
      {
        action: "job.business",
        businessId: a1.tenant.businessId,
        actorType: "system",
        actorUserId: null,
        actorLabel: "pipeline-reply",
      },
    ]);
  });
});

describe("directory", () => {
  it("maps a channel account to its tenant, and an unknown account to nothing", async () => {
    const { a1 } = world.businesses;
    const connectionId = a1.rows.get("channel_connections")?.fixture;
    const [connection] = (await t.db
      .forBusiness(a1.tenant.businessId)
      .run(({ tx }) =>
        tx.execute(
          sql`select external_account_id from channel_connections where id = ${connectionId}::uuid`,
        ),
      )) as unknown as Rows;
    const found = await t.db.directory.findChannelConnection(
      "test",
      connection?.["external_account_id"] as string,
    );
    expect(found).toEqual({
      connectionId,
      ...a1.tenant,
      channel: "test",
      status: "active",
      businessStatus: "active",
    });
    expect(await t.db.directory.findChannelConnection("test", "no-such-account")).toBeNull();
    // The same account id on another channel is another account.
    expect(
      await t.db.directory.findChannelConnection(
        "whatsapp",
        connection?.["external_account_id"] as string,
      ),
    ).toBeNull();
  });

  it("finds every connection under a provider business account, across tenants", async () => {
    const { a1, b1 } = world.businesses;
    const waba = `waba-${Date.now()}`;
    const insert = (tenant: typeof a1.tenant, account: string, config: Record<string, unknown>) =>
      t.admin
        .insert(channelConnections)
        .values({ ...tenant, channel: "whatsapp", externalAccountId: account, config })
        .returning({ id: channelConnections.id });
    const [first] = await insert(a1.tenant, `${waba}-1`, { businessAccountId: waba });
    const [second] = await insert(b1.tenant, `${waba}-2`, { businessAccountId: waba });
    await insert(a1.tenant, `${waba}-3`, { businessAccountId: `${waba}-other` });
    const found = await t.db.directory.findChannelConnectionsByBusinessAccount("whatsapp", waba);
    expect(found.map((row) => [row.connectionId, row.businessId])).toEqual([
      [first!.id, a1.tenant.businessId],
      [second!.id, b1.tenant.businessId],
    ]);
    expect(await t.db.directory.findChannelConnectionsByBusinessAccount("messenger", waba)).toEqual(
      [],
    );
    expect(await t.db.directory.findChannelConnectionsByBusinessAccount("whatsapp", "")).toEqual(
      [],
    );
  });

  it("finds the connection of a provider subscription, which names exactly one (C11)", async () => {
    const { a1, b1 } = world.businesses;
    const subscription = `sub-${Date.now()}`;
    const [row] = await t.admin
      .insert(channelConnections)
      .values({
        ...a1.tenant,
        channel: "email",
        externalAccountId: `${subscription}@acme.example`,
        state: { subscriptionId: subscription },
      })
      .returning({ id: channelConnections.id });
    expect(
      await t.db.directory.findChannelConnectionBySubscription("email", subscription),
    ).toMatchObject({ connectionId: row!.id, ...a1.tenant, channel: "email" });
    expect(
      await t.db.directory.findChannelConnectionBySubscription("whatsapp", subscription),
    ).toBeNull();
    expect(await t.db.directory.findChannelConnectionBySubscription("email", "")).toBeNull();
    expect(await t.db.directory.findChannelConnectionBySubscription("email", "other")).toBeNull();
    // A second connection, even of another business, cannot claim the same subscription.
    await expect(
      t.admin.insert(channelConnections).values({
        ...b1.tenant,
        channel: "email",
        externalAccountId: `${subscription}@other.example`,
        state: { subscriptionId: subscription },
      }),
    ).rejects.toThrow();
  });

  it("finds the integration connection of a webhook key, which names exactly one (C12)", async () => {
    const { a1, b1 } = world.businesses;
    const key = `hook-${Date.now()}`;
    const [row] = await t.admin
      .insert(integrationConnections)
      .values({ ...a1.tenant, provider: "calendly", config: { webhookKey: key } })
      .returning({ id: integrationConnections.id });
    expect(
      await t.db.directory.findIntegrationConnectionByWebhookKey("calendly", key),
    ).toMatchObject({ connectionId: row!.id, ...a1.tenant, provider: "calendly" });
    expect(
      await t.db.directory.findIntegrationConnectionByWebhookKey("google_calendar", key),
    ).toBeNull();
    expect(await t.db.directory.findIntegrationConnectionByWebhookKey("calendly", "")).toBeNull();
    expect(
      await t.db.directory.findIntegrationConnectionByWebhookKey("calendly", "other"),
    ).toBeNull();
    // A second connection, even of another business, cannot claim the same key.
    await expect(
      t.admin
        .insert(integrationConnections)
        .values({ ...b1.tenant, provider: "calendly", config: { webhookKey: key } }),
    ).rejects.toThrow();
  });

  it("finds a business's agency and lists active businesses for cron runs", async () => {
    const { a1, a2, a3, b1 } = world.businesses;
    expect(await t.db.directory.findBusiness(a1.tenant.businessId)).toEqual({
      ...a1.tenant,
      status: "active",
    });
    expect(await t.db.directory.findBusiness(UNKNOWN_ID as BusinessId)).toBeNull();

    await t.admin
      .update(businesses)
      .set({ status: "paused" })
      .where(eq(businesses.id, a2.tenant.businessId));
    try {
      const active = await t.db.directory.listBusinesses();
      const ids = active.map((row) => row.businessId);
      expect(ids).toEqual(
        expect.arrayContaining([a1.tenant.businessId, a3.tenant.businessId, b1.tenant.businessId]),
      );
      expect(ids).not.toContain(a2.tenant.businessId);
      const ofAgencyB = await t.db.directory.listBusinesses({ agencyId: b1.tenant.agencyId });
      expect(ofAgencyB.map((row) => row.businessId)).toEqual([b1.tenant.businessId]);
      const paused = await t.db.directory.listBusinesses({ statuses: ["paused"] });
      expect(paused.map((row) => row.businessId)).toEqual([a2.tenant.businessId]);
      expect(await t.db.directory.listBusinesses({ statuses: [] })).toEqual([]);
    } finally {
      await t.admin
        .update(businesses)
        .set({ status: "active" })
        .where(eq(businesses.id, a2.tenant.businessId));
    }
  });

  it("authenticates API keys by hash, and refuses revoked, expired and malformed keys", async () => {
    const { a1 } = world.businesses;
    const good = generateApiKey();
    const revoked = generateApiKey();
    const expired = generateApiKey();
    expect(looksLikeApiKey(good.key)).toBe(true);
    expect(good.hash).toBe(hashApiKey(good.key));
    expect(good.key.startsWith(good.prefix)).toBe(true);

    await t.db.forAgency(a1.tenant.agencyId).run(async ({ tx }) => {
      await tx.insert(apiKeys).values([
        {
          ...a1.tenant,
          name: "Good",
          keyPrefix: good.prefix,
          keyHash: good.hash,
          scopes: ["knowledge:import"],
        },
        {
          agencyId: a1.tenant.agencyId,
          name: "Revoked",
          keyPrefix: revoked.prefix,
          keyHash: revoked.hash,
          revokedAt: new Date(),
        },
        {
          agencyId: a1.tenant.agencyId,
          name: "Expired",
          keyPrefix: expired.prefix,
          keyHash: expired.hash,
          expiresAt: new Date(Date.now() - 1000),
        },
      ]);
    });

    const now = new Date();
    expect(await t.db.directory.authenticateApiKey(good.key, now)).toEqual({
      id: expect.any(String) as string,
      ...a1.tenant,
      name: "Good",
      scopes: ["knowledge:import"],
    });
    const [used] = await t.admin
      .select({ lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, good.hash));
    expect(used?.lastUsedAt?.getTime()).toBe(now.getTime());

    expect(await t.db.directory.authenticateApiKey(revoked.key)).toBeNull();
    expect(await t.db.directory.authenticateApiKey(expired.key)).toBeNull();
    expect(await t.db.directory.authenticateApiKey(generateApiKey().key)).toBeNull();
    expect(await t.db.directory.authenticateApiKey("' or 1=1 --")).toBeNull();
    expect(await t.db.directory.authenticateApiKey(good.hash)).toBeNull();

    // The stored row never contains the key itself.
    const rows = await t.admin.select().from(apiKeys).where(eq(apiKeys.keyHash, good.hash));
    expect(JSON.stringify(rows)).not.toContain(good.key);
  });

  it("finds a profile by email, ignoring case", async () => {
    const found = await t.db.directory.findUserByEmail("AADMIN@world.test ");
    expect(found?.id).toBe(world.users.aAdmin.id);
    expect(await t.db.directory.findUserByEmail("nobody@world.test")).toBeNull();
  });

  it("never takes a look-alike address for the plain one an admin typed", async () => {
    // "\u212A" is the Kelvin sign, which PostgreSQL's lower() can fold into "k".
    await t.admin.execute(
      sql`insert into auth.users (id, email) values (gen_random_uuid(), ${"ja\u212Ae@world.test"})`,
    );
    expect(await t.db.directory.findUserByEmail("jake@world.test")).toBeNull();
  });
});

describe("platform", () => {
  it("validates agency slugs and refuses duplicates", async () => {
    await expect(
      t.db.platform.createAgency({ name: "Bad", slug: "Not A Slug" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      t.db.platform.createAgency({ name: "Again", slug: "agency-a" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.platform.findAgencyBySlug("agency-a")).toEqual({
      id: world.agencies.a.agencyId,
      name: "Agency A",
    });
    expect(await t.db.platform.findAgencyBySlug("nope")).toBeNull();
  });

  it("deleting an agency removes everything below it and nothing beside it", async () => {
    const { id } = await t.db.platform.createAgency({ name: "Temp", slug: "temp-agency" });
    await t.db.forAgency(id).run(async ({ tx, tenant }) => {
      const [business] = await tx
        .insert(businesses)
        .values({ agencyId: tenant.agencyId, name: "Temp business", slug: "temp" })
        .returning({ id: businesses.id });
      await tx
        .insert(contacts)
        .values({ agencyId: tenant.agencyId, businessId: business!.id, displayName: "Temp" });
    });
    const before = await t.admin.select({ n: sql<number>`count(*)::int` }).from(contacts);
    await t.db.platform.deleteAgency(id);
    const after = await t.admin.select({ n: sql<number>`count(*)::int` }).from(contacts);
    expect(after[0]?.n).toBe((before[0]?.n ?? 0) - 1);
    expect(await t.db.platform.findAgencyBySlug("temp-agency")).toBeNull();
    expect(await t.db.platform.findAgencyBySlug("agency-a")).not.toBeNull();
  });
});

describe("local sign-in store", () => {
  it("is available on a bootstrapped database", async () => {
    expect(await t.db.localAuth.isAvailable()).toBe(true);
  });

  it("creates a user with a profile and checks the password", async () => {
    const created = await t.db.localAuth.upsertUser({
      email: "  New.Person@Example.com ",
      password: "correct horse battery",
      fullName: "New Person",
    });
    expect(created.email).toBe("new.person@example.com");

    const [profile] = await t.admin.select().from(users).where(eq(users.id, created.id));
    expect(profile).toMatchObject({ email: "new.person@example.com", fullName: "New Person" });

    expect(
      await t.db.localAuth.verifyPassword("NEW.person@example.com", "correct horse battery"),
    ).toEqual(created);
    expect(await t.db.localAuth.verifyPassword("new.person@example.com", "wrong")).toBeNull();
    expect(
      await t.db.localAuth.verifyPassword("nobody@example.com", "correct horse battery"),
    ).toBeNull();
    expect(await t.db.localAuth.findUserById(created.id)).toEqual(created);

    const stored = (await t.admin.execute(
      sql`select encrypted_password from auth.users where id = ${created.id}::uuid`,
    )) as unknown as Rows;
    expect(stored[0]?.["encrypted_password"]).toMatch(/^scrypt\$/);
    expect(String(stored[0]?.["encrypted_password"])).not.toContain("correct horse battery");
  });

  it("updates the same user on a second upsert and keeps the id", async () => {
    const first = await t.db.localAuth.upsertUser({
      email: "repeat@example.com",
      password: "first-password",
    });
    const second = await t.db.localAuth.upsertUser({
      email: "REPEAT@example.com",
      password: "second-password",
      fullName: "Renamed",
    });
    expect(second.id).toBe(first.id);
    expect(second.fullName).toBe("Renamed");
    expect(await t.db.localAuth.verifyPassword("repeat@example.com", "first-password")).toBeNull();
    expect((await t.db.localAuth.verifyPassword("repeat@example.com", "second-password"))?.id).toBe(
      first.id,
    );
    const [profile] = await t.admin.select().from(users).where(eq(users.id, first.id));
    expect(profile?.fullName).toBe("Renamed");
  });

  it("a user without a password cannot sign in with any password", async () => {
    await t.db.localAuth.upsertUser({ email: "magic-only@example.com" });
    expect(await t.db.localAuth.verifyPassword("magic-only@example.com", "")).toBeNull();
    expect(await t.db.localAuth.verifyPassword("magic-only@example.com", "null")).toBeNull();
  });

  it("rejects something that is not an email address", async () => {
    await expect(t.db.localAuth.upsertUser({ email: "not-an-email" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("schema guarantees the pipeline relies on", () => {
  const refsOf = (key: keyof World["businesses"]) => {
    const business = world.businesses[key];
    return {
      tenant: business.tenant,
      conversationId: business.rows.get("conversations")?.spare as ConversationId,
      connectionId: business.rows.get("channel_connections")?.fixture as ChannelConnectionId,
      contactId: business.rows.get("contacts")?.fixture as never,
    };
  };

  it("stores a provider message once, however often it is delivered (I2)", async () => {
    const { tenant, conversationId, connectionId } = refsOf("a1");
    const deliver = (sequence: number) =>
      t.db.forBusiness(tenant.businessId).run(({ tx }) =>
        tx
          .insert(messages)
          .values({
            ...tenant,
            conversationId,
            channelConnectionId: connectionId,
            direction: "inbound",
            author: "customer",
            text: "Hello?",
            externalMessageId: "wamid.DUPLICATE",
            sequence,
            status: "received",
          })
          .onConflictDoNothing({
            target: [messages.channelConnectionId, messages.externalMessageId],
          })
          .returning({ id: messages.id }),
      );
    expect(await deliver(9001)).toHaveLength(1);
    expect(await deliver(9002)).toHaveLength(0);
    const stored = await t.admin
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.externalMessageId, "wamid.DUPLICATE"));
    expect(stored).toHaveLength(1);
  });

  it("hands out sequence numbers without gaps or duplicates under concurrency", async () => {
    const { tenant, conversationId } = refsOf("a2");
    const next = () =>
      t.db.forBusiness(tenant.businessId).run(async ({ tx }) => {
        const [row] = await tx
          .update(conversations)
          .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
          .where(eq(conversations.id, conversationId))
          .returning({ sequence: conversations.messageSeq });
        return row?.sequence;
      });
    const sequences = await Promise.all(Array.from({ length: 12 }, next));
    expect([...sequences].sort((x, y) => Number(x) - Number(y))).toEqual(
      Array.from({ length: 12 }, (_unused, index) => index + 1),
    );
  });

  it("lets exactly one run take the turn lease", async () => {
    const { tenant, conversationId } = refsOf("b1");
    const take = (owner: string) =>
      t.db.forBusiness(tenant.businessId).run(async ({ tx }) => {
        const rows = await tx
          .update(conversations)
          .set({ turnLeaseOwner: owner, turnLeaseExpiresAt: sql`now() + interval '2 minutes'` })
          .where(
            and(
              eq(conversations.id, conversationId),
              sql`(${conversations.turnLeaseOwner} is null or ${conversations.turnLeaseExpiresAt} < now())`,
            ),
          )
          .returning({ id: conversations.id });
        return rows.length === 1 ? owner : null;
      });
    const winners = (await Promise.all(["run-1", "run-2", "run-3", "run-4"].map(take))).filter(
      Boolean,
    );
    expect(winners).toHaveLength(1);
  });

  it("allows one open conversation per contact and thread, and one active takeover", async () => {
    const { tenant, connectionId, contactId, conversationId } = refsOf("a1");
    const open = () =>
      t.db.forBusiness(tenant.businessId).run(({ tx }) =>
        tx.insert(conversations).values({
          ...tenant,
          contactId,
          channelConnectionId: connectionId,
          channel: "test",
          externalThreadId: "thread-dup",
        }),
      );
    await open();
    await expect(open()).rejects.toSatisfy((error) =>
      isUniqueViolation(error, "conversations_open_thread_key"),
    );

    const lock = () =>
      t.db
        .forBusiness(tenant.businessId)
        .run(({ tx }) =>
          tx.insert(takeoverLocks).values({ ...tenant, conversationId, source: "rule" }),
        );
    await lock();
    await expect(lock()).rejects.toSatisfy((error) =>
      isUniqueViolation(error, "takeover_locks_active_key"),
    );
  });

  it("rejects values outside the vocabularies and impossible combinations", async () => {
    const { tenant, conversationId, connectionId } = refsOf("a1");
    const insertMessage = (values: Record<string, unknown>) =>
      t.db.forBusiness(tenant.businessId).run(({ tx }) =>
        tx.insert(messages).values({
          ...tenant,
          conversationId,
          channelConnectionId: connectionId,
          direction: "inbound",
          author: "customer",
          sequence: Math.floor(Math.random() * 1e9),
          status: "received",
          ...values,
        } as never),
      );
    const isCheck = (error: unknown) => pgErrorCode(error) === PG_ERROR.checkViolation;
    await expect(insertMessage({ status: "exploded" })).rejects.toSatisfy(isCheck);
    await expect(insertMessage({ author: "bot" })).rejects.toSatisfy(isCheck);
    await expect(
      insertMessage({ direction: "outbound", author: "bot", status: "received" }),
    ).rejects.toSatisfy(isCheck);
    await expect(
      insertMessage({ direction: "outbound", author: "bot", status: "queued" }),
    ).resolves.toBeDefined();

    const setSetting = (values: Record<string, unknown>) =>
      t.db.forAgency(tenant.agencyId).run(({ tx }) =>
        tx.insert(settingValues).values({
          agencyId: tenant.agencyId,
          key: `k.${Math.random()}`,
          value: 1,
          ...values,
        } as never),
      );
    await expect(setSetting({ scope: "global", businessId: tenant.businessId })).rejects.toSatisfy(
      isCheck,
    );
    await expect(setSetting({ scope: "business" })).rejects.toSatisfy(isCheck);
    await expect(setSetting({ scope: "segment" })).rejects.toSatisfy(isCheck);
    await expect(
      setSetting({ scope: "business", businessId: tenant.businessId }),
    ).resolves.toBeDefined();

    await expect(
      t.db.forAgency(tenant.agencyId).run(({ tx }) =>
        tx.insert(businesses).values({
          agencyId: tenant.agencyId,
          name: "No segment",
          slug: "no-segment",
          status: "active",
        }),
      ),
    ).rejects.toSatisfy(isCheck);
  });

  it("moves updated_at forward on every update", async () => {
    const { tenant, contactId } = refsOf("a1");
    const read = async () =>
      (
        await t.admin
          .select({ at: contacts.updatedAt })
          .from(contacts)
          .where(eq(contacts.id, contactId))
      )[0]?.at;
    const before = await read();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await t.db
      .forBusiness(tenant.businessId)
      .run(({ tx }) =>
        tx.update(contacts).set({ displayName: "Renamed again" }).where(eq(contacts.id, contactId)),
      );
    const after = await read();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it("indexes knowledge for full-text search", async () => {
    const { tenant } = refsOf("a1");
    const found = await t.db.forBusiness(tenant.businessId).run(async ({ tx }) => {
      await tx.insert(knowledgeItems).values({
        ...tenant,
        category: "warranties",
        title: "Workmanship warranty",
        content: "Every replacement comes with a ten year workmanship warranty.",
      });
      return tx
        .select({ title: knowledgeItems.title })
        .from(knowledgeItems)
        .where(
          sql`${knowledgeItems.search} @@ websearch_to_tsquery('english', ${"warranties on replacements"})`,
        );
    });
    expect(found.map((row) => row.title)).toEqual(["Workmanship warranty"]);
  });
});
