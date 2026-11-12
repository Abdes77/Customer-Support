import { type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgencyId, BusinessId, UserId } from "@repo/core";

import { PG_ERROR, pgErrorCode } from "./errors";
import type { Transaction } from "./internal/client";
import { agencies, agencyMemberships, businesses, users } from "./schema/tables";
import {
  type AccessLevel,
  type AgencyWorld,
  type BusinessWorld,
  CAST,
  CAST_SPEC,
  type CastName,
  createTestDatabase,
  createWorld,
  ISOLATION_MATRIX,
  type MatrixEntry,
  TABLES_WITH_DEDICATED_TESTS,
  type TestDatabase,
  type World,
} from "./testing";

/*
 * Tenant isolation, proven against PostgreSQL.
 *
 * Part 1 reads the catalog: every table is covered, row-level security is on and forced,
 * and no role holds a privilege that a policy does not back.
 * Part 2 walks the isolation matrix as every role: read, insert, update, delete and "move
 * the row to another tenant", in the user's own tenant and in everyone else's.
 * Part 3 does the same for the system scopes of `forBusiness()` and `forAgency()`.
 * Part 4 covers the tables and rules that are not "one row per tenant".
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

// --- helpers ---------------------------------------------------------------------------

type Rows = readonly Record<string, unknown>[];

const ROLLBACK = Symbol("rollback");

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string | null; readonly error: unknown };

/** Runs `fn` in a savepoint that is always rolled back, and reports what happened. */
async function probe<T>(tx: Transaction, fn: (tx: Transaction) => Promise<T>): Promise<Outcome<T>> {
  const result: { success?: Outcome<T> } = {};
  try {
    await tx.transaction(async (inner) => {
      result.success = { ok: true, value: await fn(inner) };
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a sentinel, not an error
      throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK && result.success !== undefined) return result.success;
    return { ok: false, code: pgErrorCode(error), error };
  }
  throw new Error("unreachable: the probe always rolls back");
}

const tableOf = (entry: MatrixEntry) => sql.identifier(entry.name);
const pkOf = (entry: MatrixEntry) => sql.identifier(entry.pk ?? "id");

async function count(tx: Transaction, entry: MatrixEntry, where: SQL): Promise<number> {
  const rows = (await tx.execute(
    sql`select count(*)::int as n from ${tableOf(entry)} where ${where}`,
  )) as unknown as Rows;
  return Number(rows[0]?.["n"]);
}

/** What a role sees: the number of rows, or "no privilege" when it may not even ask. */
async function visibleCount(
  tx: Transaction,
  entry: MatrixEntry,
  where: SQL,
): Promise<number | "no privilege"> {
  const outcome = await probe(tx, (inner) => count(inner, entry, where));
  if (outcome.ok) return outcome.value;
  if (outcome.code === PG_ERROR.insufficientPrivilege) return "no privilege";
  throw outcome.error;
}

const inBusiness = (business: BusinessWorld) =>
  sql`business_id = ${business.tenant.businessId}::uuid`;
const agencyLevel = (agency: AgencyWorld) =>
  sql`agency_id = ${agency.agencyId}::uuid and business_id is null`;
const inAgency = (agency: AgencyWorld) => sql`agency_id = ${agency.agencyId}::uuid`;

async function insertRow(tx: Transaction, entry: MatrixEntry, values: Record<string, unknown>) {
  await tx.insert(entry.table).values(values as never);
}

async function updateRow(tx: Transaction, entry: MatrixEntry, id: string): Promise<number> {
  const rows = (await tx.execute(
    sql`update ${tableOf(entry)} set ${sql.identifier(entry.change.column)} = ${entry.change.value}
        where ${pkOf(entry)} = ${id}::uuid returning 1 as one`,
  )) as unknown as Rows;
  return rows.length;
}

async function deleteRow(tx: Transaction, entry: MatrixEntry, id: string): Promise<number> {
  const rows = (await tx.execute(
    sql`delete from ${tableOf(entry)} where ${pkOf(entry)} = ${id}::uuid returning 1 as one`,
  )) as unknown as Rows;
  return rows.length;
}

/** Tries to hand a row to another tenant by rewriting its tenant columns. */
async function moveRow(
  tx: Transaction,
  entry: MatrixEntry,
  id: string,
  target: { agencyId: AgencyId; businessId?: BusinessId },
): Promise<number> {
  const set =
    entry.kind === "agency" || target.businessId === undefined
      ? sql`agency_id = ${target.agencyId}::uuid`
      : sql`agency_id = ${target.agencyId}::uuid, business_id = ${target.businessId}::uuid`;
  const rows = (await tx.execute(
    sql`update ${tableOf(entry)} set ${set} where ${pkOf(entry)} = ${id}::uuid returning 1 as one`,
  )) as unknown as Rows;
  return rows.length;
}

/** A write "went through" when it changed a row, or when only a later constraint stopped it. */
function wentThrough(outcome: Outcome<number>): boolean {
  if (outcome.ok) return outcome.value === 1;
  // Row-level security let the statement reach the row; a foreign key then refused it.
  return outcome.code === PG_ERROR.foreignKeyViolation;
}

/** Refused by row-level security: no row touched, or "insufficient privilege". */
function refused(outcome: Outcome<number>): boolean {
  if (outcome.ok) return outcome.value === 0;
  return outcome.code === PG_ERROR.insufficientPrivilege;
}

function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `succeeded (${JSON.stringify(outcome.value)})`
    : `failed with ${outcome.code ?? String(outcome.error)}`;
}

function levelAllows(level: AccessLevel | undefined, role: string | null): boolean {
  if (level === "staff") return role === "agency_admin" || role === "agency_member";
  if (level === "admin") return role === "agency_admin";
  return false;
}

/** The actor's role in an agency, when they are staff of it. */
function staffRoleIn(actor: CastName, agency: AgencyWorld) {
  const spec = CAST_SPEC[actor];
  return spec.agency === agency.key ? (spec.role as "agency_admin" | "agency_member") : null;
}

const businessEntries = ISOLATION_MATRIX.filter((entry) => entry.kind !== "agency");
const agencyEntries = ISOLATION_MATRIX.filter((entry) => entry.kind === "agency");

const allBusinesses = () => Object.values(world.businesses);
const allAgencies = () => Object.values(world.agencies);
const otherAgency = (agency: AgencyWorld) => world.agencies[agency.key === "a" ? "b" : "a"];
/** A business of a different agency: the classic cross-tenant target. */
const foreignBusiness = (business: BusinessWorld) =>
  business.agency.key === "a" ? world.businesses.b1 : world.businesses.a1;

function fixtureId(rows: Map<string, { fixture?: string }>, entry: MatrixEntry): string {
  const id = rows.get(entry.name)?.fixture;
  if (id === undefined) throw new Error(`No fixture row for ${entry.name}`);
  return id;
}

/** For deletes, prefer the childless spare row so the delete itself can succeed. */
function deletableId(rows: Map<string, { fixture?: string; spare?: string }>, entry: MatrixEntry) {
  const refs = rows.get(entry.name);
  const id = refs?.spare ?? refs?.fixture;
  if (id === undefined) throw new Error(`No fixture row for ${entry.name}`);
  return id;
}

// --- part 1: the catalog ---------------------------------------------------------------

describe("catalog", () => {
  async function publicTables(): Promise<string[]> {
    const rows = (await t.admin.execute(sql`
      select c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by 1`)) as unknown as Rows;
    return rows.map((row) => row["name"] as string);
  }

  it("has every table with a business_id column in the isolation matrix", async () => {
    const rows = (await t.admin.execute(sql`
      select table_name as name from information_schema.columns
       where table_schema = 'public' and column_name = 'business_id'
       order by 1`)) as unknown as Rows;
    const inCatalog = rows.map((row) => row["name"] as string);
    const inMatrix = businessEntries.map((entry) => entry.name).sort();
    // A failure here means a table was added without an entry in
    // src/testing/isolation-matrix.ts (or an entry outlived its table).
    expect(inMatrix).toEqual(inCatalog);
  });

  it("covers every table, in the matrix or by a dedicated test", async () => {
    const covered = [
      ...ISOLATION_MATRIX.map((entry) => entry.name),
      ...TABLES_WITH_DEDICATED_TESTS,
    ].sort();
    expect(covered).toEqual(await publicTables());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("declares each matrix entry with the kind its columns have", async () => {
    const rows = (await t.admin.execute(sql`
      select table_name as name, column_name as col, is_nullable = 'YES' as nullable
        from information_schema.columns
       where table_schema = 'public' and column_name in ('agency_id', 'business_id')`)) as unknown as Rows;
    const column = (table: string, name: string) =>
      rows.find((row) => row["name"] === table && row["col"] === name);
    for (const entry of ISOLATION_MATRIX) {
      const business = column(entry.name, "business_id");
      const agency = column(entry.name, "agency_id");
      expect(agency, `${entry.name}.agency_id`).toBeDefined();
      if (entry.kind === "agency") {
        expect(business, `${entry.name} is declared "agency" but has business_id`).toBeUndefined();
      } else {
        expect(business?.["nullable"], `${entry.name}.business_id nullability`).toBe(
          entry.kind === "shared",
        );
      }
    }
  });

  it("has row-level security enabled and forced on every table", async () => {
    const rows = (await t.admin.execute(sql`
      select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')`)) as unknown as Rows;
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      expect(row, `row-level security on ${String(row["name"])}`).toMatchObject({
        enabled: true,
        forced: true,
      });
    }
  });

  it("has at least one policy on every table, and only for the two restricted roles", async () => {
    const rows = (await t.admin.execute(sql`
      select tablename as name, policyname as policy, roles::text[] as roles
        from pg_policies where schemaname = 'public'`)) as unknown as Rows;
    const withPolicy = new Set(rows.map((row) => row["name"] as string));
    for (const table of await publicTables()) {
      expect(withPolicy.has(table), `${table} has no policy`).toBe(true);
    }
    for (const row of rows) {
      const roles = row["roles"] as string[];
      expect(roles, `roles of policy ${String(row["policy"])}`).toHaveLength(1);
      expect(["authenticated", "app_system"]).toContain(roles[0]);
    }
  });

  it("gives each restricted role exactly the commands its policies cover", async () => {
    const grants = (await t.admin.execute(sql`
      select table_name as name, grantee, privilege_type as privilege
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('authenticated', 'app_system', 'anon', 'PUBLIC')`)) as unknown as Rows;
    const policies = (await t.admin.execute(sql`
      select tablename as name, roles::text[] as roles, cmd from pg_policies
       where schemaname = 'public'`)) as unknown as Rows;

    const expected = new Set<string>();
    for (const policy of policies) {
      const commands =
        policy["cmd"] === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [policy["cmd"]];
      for (const role of policy["roles"] as string[]) {
        for (const command of commands) {
          expected.add(`${String(policy["name"])}:${role}:${String(command)}`);
        }
      }
    }
    const actual = new Set(
      grants.map(
        (grant) =>
          `${String(grant["name"])}:${String(grant["grantee"])}:${String(grant["privilege"])}`,
      ),
    );
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("grants the anonymous role nothing, and it can read no table", async () => {
    for (const table of await publicTables()) {
      const outcome = await t.admin
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('role', 'anon', true)`);
          await tx.execute(sql`select 1 from ${sql.identifier(table)} limit 1`);
          return "read";
        })
        .catch((error: unknown) => pgErrorCode(error));
      expect(outcome, `anon reading ${table}`).toBe(PG_ERROR.insufficientPrivilege);
    }
  });

  it("gives signed-in users no way to the credential tables", async () => {
    const rows = (await t.admin.execute(sql`
      select tablename as name from pg_policies
       where schemaname = 'public' and 'authenticated' = any(roles::text[])
         and tablename like '%secrets'`)) as unknown as Rows;
    expect(rows).toEqual([]);
  });

  it("ties every tenant table to businesses (id, agency_id) with a foreign key", async () => {
    const rows = (await t.admin.execute(sql`
      select c.conrelid::regclass::text as name
        from pg_constraint c
       where c.contype = 'f'
         and c.confrelid = 'public.businesses'::regclass
         and array_length(c.conkey, 1) = 2
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             = array['agency_id', 'business_id']`)) as unknown as Rows;
    const tied = new Set(rows.map((row) => row["name"] as string));
    for (const entry of businessEntries) {
      expect(tied.has(entry.name), `${entry.name} has no tenant foreign key`).toBe(true);
    }
  });

  it("refuses a row whose agency and business do not belong together, on any connection", async () => {
    // Even the unrestricted connection cannot store a mixed-tenant row.
    const { a1, b1 } = world.businesses;
    for (const entry of businessEntries) {
      const values = {
        ...entry.row(world.rowContext(a1, "attempt")),
        agencyId: a1.tenant.agencyId,
        businessId: b1.tenant.businessId,
      };
      const outcome = await probe(t.admin as unknown as Transaction, async (tx) => {
        await insertRow(tx, entry, values);
        return 1;
      });
      expect(outcome.ok, `${entry.name}: ${describeOutcome(outcome)}`).toBe(false);
      expect((outcome as { code: string | null }).code).toBe(PG_ERROR.foreignKeyViolation);
    }
  });
});

// --- part 2: signed-in users -----------------------------------------------------------

describe.each(businessEntries.map((entry) => [entry.name, entry] as const))(
  "users: %s",
  (_name, entry) => {
    it.each(CAST)("as %s", async (actorName) => {
      const actor = world.users[actorName];
      const spec = CAST_SPEC[actorName];
      const totals = new Map<string, number>();
      for (const business of allBusinesses()) {
        totals.set(
          business.key,
          await count(t.admin as unknown as Transaction, entry, inBusiness(business)),
        );
      }

      await t.db.asUser(actor).run(async ({ tx }) => {
        for (const business of allBusinesses()) {
          const where = `${actorName} on ${entry.name} of ${business.key}`;
          const total = totals.get(business.key) ?? 0;
          expect(total, `fixture rows of ${entry.name} in ${business.key}`).toBeGreaterThan(0);

          const staffRole = staffRoleIn(actorName, business.agency);
          const isClientHere = spec.business === business.key && business.portalEnabled;

          // READ
          const visible = await visibleCount(tx, entry, inBusiness(business));
          if (entry.user.read === "nobody") {
            // No policy for users at all: the table cannot even be queried.
            expect(visible, `${where}: no access at all`).toBe("no privilege");
          } else if (levelAllows(entry.user.read, staffRole)) {
            expect(visible, `${where}: staff see every row`).toBe(total);
          } else if (entry.name === "business_memberships" && spec.business === business.key) {
            // A member always sees their own membership, even with client logins off; an
            // owner of a business with client logins on also sees the rest of the team.
            const seesTeam = spec.role === "client_owner" && business.portalEnabled;
            expect(visible, `${where}: own membership`).toBe(seesTeam ? total : 1);
          } else if (isClientHere && entry.user.clientRead === true) {
            expect(visible, `${where}: client users see their business`).toBe(total);
          } else {
            expect(visible, `${where}: must see nothing`).toBe(0);
          }

          // INSERT into this business
          const insert = await probe(tx, async (inner) => {
            await insertRow(
              inner,
              entry,
              entry.row(world.rowContext(business, "attempt", actor.id)),
            );
            return 1;
          });
          if (levelAllows(entry.user.insert, staffRole)) {
            expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
          } else {
            expect(insert.ok, `${where}: insert must be refused`).toBe(false);
            expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
          }

          // UPDATE and DELETE an existing row of this business
          const author = business.agency.memberId;
          const matrixActor = { id: actor.id, agencyRole: staffRole };
          const mayUpdate =
            entry.userOverride?.update?.(matrixActor, author) ??
            levelAllows(entry.user.update, staffRole);
          const mayDelete =
            entry.userOverride?.delete?.(matrixActor, author) ??
            levelAllows(entry.user.delete, staffRole);

          const update = await probe(tx, (inner) =>
            updateRow(inner, entry, fixtureId(business.rows, entry)),
          );
          expect(
            mayUpdate ? wentThrough(update) : refused(update),
            `${where}: update ${describeOutcome(update)}, expected ${mayUpdate ? "allowed" : "refused"}`,
          ).toBe(true);

          const remove = await probe(tx, (inner) =>
            deleteRow(inner, entry, deletableId(business.rows, entry)),
          );
          expect(
            mayDelete ? wentThrough(remove) : refused(remove),
            `${where}: delete ${describeOutcome(remove)}, expected ${mayDelete ? "allowed" : "refused"}`,
          ).toBe(true);

          // MOVE the row to a business of another agency: never, whoever asks.
          const target = foreignBusiness(business).tenant;
          const move = await probe(tx, (inner) =>
            moveRow(inner, entry, fixtureId(business.rows, entry), target),
          );
          expect(refused(move), `${where}: move to another agency ${describeOutcome(move)}`).toBe(
            true,
          );
          if (mayUpdate) {
            // The row was in reach, so it is the WITH CHECK clause that must have said no.
            expect(move.ok, `${where}: move must raise, not skip`).toBe(false);
          }
        }

        // Agency-level rows of shared tables: staff of that agency only, never client users.
        if (entry.kind === "shared" && entry.agencyRow !== undefined) {
          for (const agency of allAgencies()) {
            const total = await count(
              t.admin as unknown as Transaction,
              entry,
              agencyLevel(agency),
            );
            expect(total).toBeGreaterThan(0);
            const visible = await count(tx, entry, agencyLevel(agency));
            const expected = levelAllows(entry.user.read, staffRoleIn(actorName, agency))
              ? total
              : 0;
            expect(visible, `${actorName} on agency-level ${entry.name} of ${agency.key}`).toBe(
              expected,
            );
          }
        }
      });
    });
  },
);

describe.each(agencyEntries.map((entry) => [entry.name, entry] as const))(
  "users: %s (agency-level table)",
  (_name, entry) => {
    it.each(CAST)("as %s", async (actorName) => {
      const actor = world.users[actorName];
      await t.db.asUser(actor).run(async ({ tx }) => {
        for (const agency of allAgencies()) {
          const where = `${actorName} on ${entry.name} of agency ${agency.key}`;
          const staffRole = staffRoleIn(actorName, agency);
          const total = await count(t.admin as unknown as Transaction, entry, inAgency(agency));
          expect(total).toBeGreaterThan(0);

          if (entry.user.read === "nobody") {
            // No policy for users at all (agency secrets): the table cannot even be queried.
            expect(await visibleCount(tx, entry, inAgency(agency)), `${where}: no access`).toBe(
              "no privilege",
            );
            continue;
          }
          const visible = await count(tx, entry, inAgency(agency));
          expect(visible, `${where}: read`).toBe(
            levelAllows(entry.user.read, staffRole) ? total : 0,
          );

          const insert = await probe(tx, async (inner) => {
            await insertRow(
              inner,
              entry,
              entry.row(world.agencyRowContext(agency, "attempt", actor.id)),
            );
            return 1;
          });
          if (levelAllows(entry.user.insert, staffRole)) {
            expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
          } else {
            expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
          }

          const id = fixtureId(agency.rows, entry);
          const mayUpdate = levelAllows(entry.user.update, staffRole);
          const update = await probe(tx, (inner) => updateRow(inner, entry, id));
          expect(
            mayUpdate ? wentThrough(update) : refused(update),
            `${where}: update ${describeOutcome(update)}`,
          ).toBe(true);

          const mayDelete = levelAllows(entry.user.delete, staffRole);
          const remove = await probe(tx, (inner) => deleteRow(inner, entry, id));
          expect(
            mayDelete ? wentThrough(remove) : refused(remove),
            `${where}: delete ${describeOutcome(remove)}`,
          ).toBe(true);

          const move = await probe(tx, (inner) =>
            moveRow(inner, entry, id, { agencyId: otherAgency(agency).agencyId }),
          );
          expect(refused(move), `${where}: move ${describeOutcome(move)}`).toBe(true);
        }
      });
    });
  },
);

// --- part 3: system scopes -------------------------------------------------------------

describe.each(ISOLATION_MATRIX.map((entry) => [entry.name, entry] as const))(
  "system scope: %s",
  (_name, entry) => {
    const writes = entry.system !== "read_only";
    const changes = entry.system === "read_write";

    it.each(["a1", "a2", "a3", "b1"] as const)("forBusiness(%s)", async (scopeKey) => {
      const scope = world.businesses[scopeKey];
      await t.db.forBusiness(scope.tenant.businessId).run(async ({ tx, tenant }) => {
        expect(tenant).toEqual(scope.tenant);

        if (entry.kind === "agency") {
          // Agency-level tables: readable inside the agency, never writable from a business.
          for (const agency of allAgencies()) {
            const total = await count(t.admin as unknown as Transaction, entry, inAgency(agency));
            const visible = await count(tx, entry, inAgency(agency));
            expect(visible, `${scopeKey} reads ${entry.name} of agency ${agency.key}`).toBe(
              agency.key === scope.agency.key ? total : 0,
            );
            const insert = await probe(tx, async (inner) => {
              await insertRow(inner, entry, entry.row(world.agencyRowContext(agency, "attempt")));
              return 1;
            });
            expect((insert as { code: string | null }).code, `${scopeKey} insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
            const id = fixtureId(agency.rows, entry);
            expect(refused(await probe(tx, (inner) => updateRow(inner, entry, id)))).toBe(true);
            expect(refused(await probe(tx, (inner) => deleteRow(inner, entry, id)))).toBe(true);
          }
          return;
        }

        for (const business of allBusinesses()) {
          const where = `scope ${scopeKey} on ${entry.name} of ${business.key}`;
          const own = business.key === scopeKey;
          const total = await count(t.admin as unknown as Transaction, entry, inBusiness(business));
          const visible = await count(tx, entry, inBusiness(business));
          expect(visible, `${where}: read`).toBe(own ? total : 0);

          const insert = await probe(tx, async (inner) => {
            await insertRow(inner, entry, entry.row(world.rowContext(business, "attempt")));
            return 1;
          });
          if (own && writes) {
            expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
          } else {
            expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
          }

          const update = await probe(tx, (inner) =>
            updateRow(inner, entry, fixtureId(business.rows, entry)),
          );
          expect(
            own && changes ? wentThrough(update) : refused(update),
            `${where}: update ${describeOutcome(update)}`,
          ).toBe(true);

          const remove = await probe(tx, (inner) =>
            deleteRow(inner, entry, deletableId(business.rows, entry)),
          );
          expect(
            own && changes ? wentThrough(remove) : refused(remove),
            `${where}: delete ${describeOutcome(remove)}`,
          ).toBe(true);

          if (own) {
            // Hand the row to a sibling business of the same agency, and to another agency.
            for (const target of allBusinesses().filter((other) => other.key !== scopeKey)) {
              const move = await probe(tx, (inner) =>
                moveRow(inner, entry, fixtureId(business.rows, entry), target.tenant),
              );
              expect(
                refused(move),
                `${where}: move to ${target.key} ${describeOutcome(move)}`,
              ).toBe(true);
              if (changes) expect(move.ok, `${where}: move must raise`).toBe(false);
            }
          }
        }

        // Agency-level rows of shared tables.
        if (entry.kind === "shared" && entry.agencyRow !== undefined) {
          for (const agency of allAgencies()) {
            const where = `scope ${scopeKey} on agency-level ${entry.name} of ${agency.key}`;
            const total = await count(
              t.admin as unknown as Transaction,
              entry,
              agencyLevel(agency),
            );
            const visible = await count(tx, entry, agencyLevel(agency));
            const readable =
              agency.key === scope.agency.key && entry.businessScopeReadsAgencyRows === true;
            expect(visible, `${where}: read`).toBe(readable ? total : 0);

            const insert = await probe(tx, async (inner) => {
              await insertRow(
                inner,
                entry,
                entry.agencyRow!(world.agencyRowContext(agency, "attempt")),
              );
              return 1;
            });
            expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
            const id = agency.rows.get(entry.name)!.agencyLevel!;
            expect(
              refused(await probe(tx, (inner) => updateRow(inner, entry, id))),
              `${where}: update`,
            ).toBe(true);
            expect(
              refused(await probe(tx, (inner) => deleteRow(inner, entry, id))),
              `${where}: delete`,
            ).toBe(true);
          }
        }
      });
    });

    it.each(["a", "b"] as const)("forAgency(%s)", async (scopeKey) => {
      const scope = world.agencies[scopeKey];
      const foreign = otherAgency(scope);
      await t.db.forAgency(scope.agencyId).run(async ({ tx }) => {
        if (entry.kind === "agency") {
          for (const agency of allAgencies()) {
            const where = `agency scope ${scopeKey} on ${entry.name} of ${agency.key}`;
            const own = agency.key === scopeKey;
            const total = await count(t.admin as unknown as Transaction, entry, inAgency(agency));
            expect(await count(tx, entry, inAgency(agency)), `${where}: read`).toBe(
              own ? total : 0,
            );

            const insert = await probe(tx, async (inner) => {
              await insertRow(inner, entry, entry.row(world.agencyRowContext(agency, "attempt")));
              return 1;
            });
            if (own && writes) {
              expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
            } else {
              expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
                PG_ERROR.insufficientPrivilege,
              );
            }
            const id = fixtureId(agency.rows, entry);
            const update = await probe(tx, (inner) => updateRow(inner, entry, id));
            expect(own && changes ? wentThrough(update) : refused(update), `${where}: update`).toBe(
              true,
            );
            const remove = await probe(tx, (inner) => deleteRow(inner, entry, id));
            expect(own && changes ? wentThrough(remove) : refused(remove), `${where}: delete`).toBe(
              true,
            );
            if (own) {
              const move = await probe(tx, (inner) =>
                moveRow(inner, entry, id, { agencyId: foreign.agencyId }),
              );
              expect(refused(move), `${where}: move ${describeOutcome(move)}`).toBe(true);
            }
          }
          return;
        }

        for (const business of allBusinesses()) {
          const where = `agency scope ${scopeKey} on ${entry.name} of ${business.key}`;
          const own = business.agency.key === scopeKey;
          const total = await count(t.admin as unknown as Transaction, entry, inBusiness(business));
          expect(await count(tx, entry, inBusiness(business)), `${where}: read`).toBe(
            own ? total : 0,
          );

          const insert = await probe(tx, async (inner) => {
            await insertRow(inner, entry, entry.row(world.rowContext(business, "attempt")));
            return 1;
          });
          if (own && writes) {
            expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
          } else {
            expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
              PG_ERROR.insufficientPrivilege,
            );
          }

          const update = await probe(tx, (inner) =>
            updateRow(inner, entry, fixtureId(business.rows, entry)),
          );
          expect(
            own && changes ? wentThrough(update) : refused(update),
            `${where}: update ${describeOutcome(update)}`,
          ).toBe(true);
          const remove = await probe(tx, (inner) =>
            deleteRow(inner, entry, deletableId(business.rows, entry)),
          );
          expect(
            own && changes ? wentThrough(remove) : refused(remove),
            `${where}: delete ${describeOutcome(remove)}`,
          ).toBe(true);

          if (own) {
            const move = await probe(tx, (inner) =>
              moveRow(
                inner,
                entry,
                fixtureId(business.rows, entry),
                foreignBusiness(business).tenant,
              ),
            );
            expect(refused(move), `${where}: move ${describeOutcome(move)}`).toBe(true);
            if (changes) expect(move.ok, `${where}: move must raise`).toBe(false);
          }
        }

        if (entry.kind === "shared" && entry.agencyRow !== undefined) {
          for (const agency of allAgencies()) {
            const where = `agency scope ${scopeKey} on agency-level ${entry.name} of ${agency.key}`;
            const own = agency.key === scopeKey;
            const total = await count(
              t.admin as unknown as Transaction,
              entry,
              agencyLevel(agency),
            );
            expect(await count(tx, entry, agencyLevel(agency)), `${where}: read`).toBe(
              own ? total : 0,
            );
            const insert = await probe(tx, async (inner) => {
              await insertRow(
                inner,
                entry,
                entry.agencyRow!(world.agencyRowContext(agency, "attempt")),
              );
              return 1;
            });
            if (own && writes) {
              expect(insert.ok, `${where}: insert ${describeOutcome(insert)}`).toBe(true);
            } else {
              expect((insert as { code: string | null }).code, `${where}: insert`).toBe(
                PG_ERROR.insufficientPrivilege,
              );
            }
          }
        }
      });
    });
  },
);

// --- part 4: tables and rules outside the matrix -----------------------------------------

describe("agencies", () => {
  it("are visible to their staff only", async () => {
    for (const actorName of CAST) {
      const visible = await t.db
        .asUser(world.users[actorName])
        .run(({ tx }) => tx.select({ id: agencies.id }).from(agencies));
      const spec = CAST_SPEC[actorName];
      expect(
        visible.map((row) => row.id),
        `${actorName} sees agencies`,
      ).toEqual(spec.agency === null ? [] : [world.agencies[spec.agency].agencyId]);
    }
  });

  it("can be renamed by their admin, and by nobody else", async () => {
    const { a, b } = world.agencies;
    const rename = (actorName: CastName, agencyId: AgencyId) =>
      t.db.asUser(world.users[actorName]).run(async ({ tx }) => {
        const outcome = await probe(tx, async (inner) => {
          const rows = (await inner.execute(
            sql`update agencies set name = 'Renamed' where id = ${agencyId}::uuid returning 1 as one`,
          )) as unknown as Rows;
          return rows.length;
        });
        return outcome;
      });

    expect(wentThrough(await rename("aAdmin", a.agencyId))).toBe(true);
    expect(refused(await rename("aMember", a.agencyId))).toBe(true);
    expect(refused(await rename("aAdmin", b.agencyId))).toBe(true);
    expect(refused(await rename("a1Owner", a.agencyId))).toBe(true);
    expect(refused(await rename("outsider", a.agencyId))).toBe(true);
  });

  it("cannot be created or deleted by any signed-in user", async () => {
    for (const actorName of ["aAdmin", "bAdmin", "a1Owner", "outsider"] as const) {
      await t.db.asUser(world.users[actorName]).run(async ({ tx }) => {
        const insert = await probe(tx, async (inner) => {
          await inner
            .insert(agencies)
            .values({ name: "Mine", slug: `mine-${actorName.toLowerCase()}` });
          return 1;
        });
        expect((insert as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
        const remove = await probe(tx, async (inner) => {
          const rows = (await inner.execute(
            sql`delete from agencies where id = ${world.agencies.a.agencyId}::uuid returning 1 as one`,
          )) as unknown as Rows;
          return rows.length;
        });
        expect(refused(remove)).toBe(true);
      });
    }
  });

  it("are confined to the entered agency in the system scopes", async () => {
    const { a, b } = world.agencies;
    const seenFromA1 = await t.db
      .forBusiness(world.businesses.a1.tenant.businessId)
      .run(({ tx }) => tx.select({ id: agencies.id }).from(agencies));
    expect(seenFromA1.map((row) => row.id)).toEqual([a.agencyId]);

    await t.db.forAgency(a.agencyId).run(async ({ tx }) => {
      const seen = await tx.select({ id: agencies.id }).from(agencies);
      expect(seen.map((row) => row.id)).toEqual([a.agencyId]);
      const foreign = await probe(tx, async (inner) => {
        const rows = (await inner.execute(
          sql`update agencies set name = 'x' where id = ${b.agencyId}::uuid returning 1 as one`,
        )) as unknown as Rows;
        return rows.length;
      });
      expect(refused(foreign)).toBe(true);
    });
  });
});

describe("businesses", () => {
  const visibleTo = (actorName: CastName) =>
    t.db
      .asUser(world.users[actorName])
      .run(({ tx }) => tx.select({ id: businesses.id }).from(businesses))
      .then((rows) => rows.map((row) => row.id).sort());

  const idsOf = (...keys: (keyof World["businesses"])[]) =>
    keys.map((key) => world.businesses[key].tenant.businessId).sort();

  it("agency staff see every business of their agency and no other", async () => {
    expect(await visibleTo("aAdmin")).toEqual(idsOf("a1", "a2", "a3"));
    expect(await visibleTo("aMember")).toEqual(idsOf("a1", "a2", "a3"));
    expect(await visibleTo("bAdmin")).toEqual(idsOf("b1"));
    expect(await visibleTo("bMember")).toEqual(idsOf("b1"));
  });

  it("client users see only their own business", async () => {
    expect(await visibleTo("a1Owner")).toEqual(idsOf("a1"));
    expect(await visibleTo("a1Staff")).toEqual(idsOf("a1"));
    expect(await visibleTo("a2Owner")).toEqual(idsOf("a2"));
    expect(await visibleTo("b1Owner")).toEqual(idsOf("b1"));
  });

  it("client users see nothing while client logins are switched off", async () => {
    expect(await visibleTo("a3Owner")).toEqual([]);
  });

  it("a user without memberships sees nothing", async () => {
    expect(await visibleTo("outsider")).toEqual([]);
  });

  it("switching client logins off takes effect at once", async () => {
    const { a1 } = world.businesses;
    await t.admin.transaction(async (tx) => {
      await tx
        .update(businesses)
        .set({ clientPortalEnabled: false })
        .where(sql`id = ${a1.tenant.businessId}::uuid`);
    });
    try {
      expect(await visibleTo("a1Owner")).toEqual([]);
    } finally {
      await t.admin
        .update(businesses)
        .set({ clientPortalEnabled: true })
        .where(sql`id = ${a1.tenant.businessId}::uuid`);
    }
    expect(await visibleTo("a1Owner")).toEqual(idsOf("a1"));
  });

  it("removing a membership takes effect at once", async () => {
    const temp = await t.db.localAuth.upsertUser({ email: "temp-staff@world.test" });
    const { a } = world.agencies;
    const [membership] = await t.admin
      .insert(agencyMemberships)
      .values({ agencyId: a.agencyId, userId: temp.id, role: "agency_member" })
      .returning({ id: agencyMemberships.id });
    const see = () =>
      t.db
        .asUser({ id: temp.id })
        .run(({ tx }) => tx.select({ id: businesses.id }).from(businesses));
    expect(await see()).toHaveLength(3);
    await t.admin.delete(agencyMemberships).where(sql`id = ${membership?.id}::uuid`);
    expect(await see()).toHaveLength(0);
  });

  it("staff can create and edit businesses in their agency only; only admins delete", async () => {
    const { a, b } = world.agencies;
    const newBusiness = (agency: AgencyWorld) => ({
      agencyId: agency.agencyId,
      name: "New business",
      slug: `new-${Math.random().toString(36).slice(2)}`,
    });
    const tryAs = (actorName: CastName, fn: (tx: Transaction) => Promise<number>) =>
      t.db.asUser(world.users[actorName]).run(({ tx }) => probe(tx, fn));
    const insertInto = (agency: AgencyWorld) => async (tx: Transaction) => {
      await tx.insert(businesses).values(newBusiness(agency));
      return 1;
    };
    const rename = (id: BusinessId) => async (tx: Transaction) => {
      const rows = (await tx.execute(
        sql`update businesses set name = 'Renamed' where id = ${id}::uuid returning 1 as one`,
      )) as unknown as Rows;
      return rows.length;
    };
    const remove = (id: BusinessId) => async (tx: Transaction) => {
      const rows = (await tx.execute(
        sql`delete from businesses where id = ${id}::uuid returning 1 as one`,
      )) as unknown as Rows;
      return rows.length;
    };
    const a1 = world.businesses.a1.tenant.businessId;
    const b1 = world.businesses.b1.tenant.businessId;

    expect((await tryAs("aMember", insertInto(a))).ok).toBe(true);
    expect((await tryAs("aAdmin", insertInto(a))).ok).toBe(true);
    for (const actorName of ["aAdmin", "aMember", "a1Owner", "outsider"] as const) {
      const outcome = await tryAs(actorName, insertInto(b));
      expect((outcome as { code: string | null }).code, `${actorName} creating in agency B`).toBe(
        PG_ERROR.insufficientPrivilege,
      );
    }
    expect(((await tryAs("a1Owner", insertInto(a))) as { code: string | null }).code).toBe(
      PG_ERROR.insufficientPrivilege,
    );

    expect(wentThrough(await tryAs("aMember", rename(a1)))).toBe(true);
    expect(refused(await tryAs("aMember", rename(b1)))).toBe(true);
    expect(refused(await tryAs("a1Owner", rename(a1)))).toBe(true);
    expect(refused(await tryAs("b1Owner", rename(a1)))).toBe(true);

    expect(refused(await tryAs("aMember", remove(a1)))).toBe(true);
    expect(wentThrough(await tryAs("aAdmin", remove(a1)))).toBe(true);
    expect(refused(await tryAs("aAdmin", remove(b1)))).toBe(true);
    expect(refused(await tryAs("a1Owner", remove(a1)))).toBe(true);
  });

  it("a client user cannot switch client logins on for their own business", async () => {
    const { a3 } = world.businesses;
    const outcome = await t.db.asUser(world.users.a3Owner).run(({ tx }) =>
      probe(tx, async (inner) => {
        const rows = (await inner.execute(
          sql`update businesses set client_portal_enabled = true where id = ${a3.tenant.businessId}::uuid returning 1 as one`,
        )) as unknown as Rows;
        return rows.length;
      }),
    );
    expect(refused(outcome)).toBe(true);
  });

  it("system scopes: a business scope reaches its own row; only an agency scope adds or removes", async () => {
    const { a1, a2, b1 } = world.businesses;
    await t.db.forBusiness(a1.tenant.businessId).run(async ({ tx }) => {
      const seen = await tx.select({ id: businesses.id }).from(businesses);
      expect(seen.map((row) => row.id)).toEqual([a1.tenant.businessId]);

      const renameOf = (id: BusinessId) =>
        probe(tx, async (inner) => {
          const rows = (await inner.execute(
            sql`update businesses set name = 'x' where id = ${id}::uuid returning 1 as one`,
          )) as unknown as Rows;
          return rows.length;
        });
      expect(wentThrough(await renameOf(a1.tenant.businessId))).toBe(true);
      expect(refused(await renameOf(a2.tenant.businessId))).toBe(true);
      expect(refused(await renameOf(b1.tenant.businessId))).toBe(true);

      const insert = await probe(tx, async (inner) => {
        await inner
          .insert(businesses)
          .values({ agencyId: a1.tenant.agencyId, name: "n", slug: "n1" });
        return 1;
      });
      expect((insert as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
    });

    await t.db.forAgency(world.agencies.a.agencyId).run(async ({ tx }) => {
      const seen = await tx.select({ id: businesses.id }).from(businesses);
      expect(seen).toHaveLength(3);
      const own = await probe(tx, async (inner) => {
        await inner
          .insert(businesses)
          .values({ agencyId: world.agencies.a.agencyId, name: "n", slug: "n2" });
        return 1;
      });
      expect(own.ok).toBe(true);
      const foreign = await probe(tx, async (inner) => {
        await inner
          .insert(businesses)
          .values({ agencyId: world.agencies.b.agencyId, name: "n", slug: "n3" });
        return 1;
      });
      expect((foreign as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});

describe("users (profiles)", () => {
  const visibleTo = (actorName: CastName) =>
    t.db
      .asUser(world.users[actorName])
      .run(({ tx }) => tx.select({ id: users.id }).from(users))
      .then((rows) => new Set<UserId>(rows.map((row) => row.id)));

  it("everyone sees their own profile", async () => {
    for (const actorName of CAST) {
      expect((await visibleTo(actorName)).has(world.users[actorName].id), actorName).toBe(true);
    }
  });

  it("agency staff see their colleagues and their clients' users, not other agencies' people", async () => {
    const seen = await visibleTo("aMember");
    for (const name of ["aAdmin", "aMember", "a1Owner", "a1Staff", "a2Owner", "a3Owner"] as const) {
      expect(seen.has(world.users[name].id), `aMember sees ${name}`).toBe(true);
    }
    for (const name of ["bAdmin", "bMember", "b1Owner", "outsider"] as const) {
      expect(seen.has(world.users[name].id), `aMember sees ${name}`).toBe(false);
    }
  });

  it("a client owner sees the users of their own business, and nobody else", async () => {
    const seen = await visibleTo("a1Owner");
    expect([...seen].sort()).toEqual([world.users.a1Owner.id, world.users.a1Staff.id].sort());
  });

  it("client staff, locked-out owners and outsiders see only themselves", async () => {
    // a3Owner owns a business whose client logins are off; b1Owner has no colleagues.
    for (const actorName of ["a1Staff", "a3Owner", "b1Owner", "outsider"] as const) {
      expect([...(await visibleTo(actorName))], actorName).toEqual([world.users[actorName].id]);
    }
  });

  it("no signed-in user can create, change or delete a profile", async () => {
    await t.db.asUser(world.users.aAdmin).run(async ({ tx }) => {
      const update = await probe(tx, async (inner) => {
        const rows = (await inner.execute(
          sql`update users set email = 'x@example.com' where id = ${world.users.aAdmin.id}::uuid returning 1 as one`,
        )) as unknown as Rows;
        return rows.length;
      });
      expect((update as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
      const remove = await probe(tx, async (inner) => {
        const rows = (await inner.execute(
          sql`delete from users where id = ${world.users.aMember.id}::uuid returning 1 as one`,
        )) as unknown as Rows;
        return rows.length;
      });
      expect((remove as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  it("a system scope sees the people of its agency only", async () => {
    const seen = await t.db
      .forBusiness(world.businesses.a1.tenant.businessId)
      .run(({ tx }) => tx.select({ id: users.id }).from(users));
    const ids = new Set(seen.map((row) => row.id));
    expect(ids.has(world.users.aAdmin.id)).toBe(true);
    expect(ids.has(world.users.a2Owner.id)).toBe(true);
    expect(ids.has(world.users.bAdmin.id)).toBe(false);
    expect(ids.has(world.users.outsider.id)).toBe(false);
  });
});

describe("memberships cannot be used to climb", () => {
  const tryInsert = (actorName: CastName, values: Record<string, unknown>, table: PgTable) =>
    t.db.asUser(world.users[actorName]).run(({ tx }) =>
      probe(tx, async (inner) => {
        await inner.insert(table).values(values as never);
        return 1;
      }),
    );

  it("nobody can make themselves staff of an agency", async () => {
    const { a, b } = world.agencies;
    for (const actorName of ["aMember", "a1Owner", "bAdmin", "outsider"] as const) {
      const outcome = await tryInsert(
        actorName,
        { agencyId: a.agencyId, userId: world.users[actorName].id, role: "agency_admin" },
        agencyMemberships,
      );
      // aMember is already a member (so RLS, not the unique index, must be what refuses).
      expect((outcome as { code: string | null }).code, actorName).toBe(
        PG_ERROR.insufficientPrivilege,
      );
    }
    const intoB = await tryInsert(
      "aAdmin",
      { agencyId: b.agencyId, userId: world.users.aAdmin.id, role: "agency_admin" },
      agencyMemberships,
    );
    expect((intoB as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it("an agency member cannot promote themselves", async () => {
    const outcome = await t.db.asUser(world.users.aMember).run(({ tx }) =>
      probe(tx, async (inner) => {
        const rows = (await inner.execute(
          sql`update agency_memberships set role = 'agency_admin' where user_id = ${world.users.aMember.id}::uuid returning 1 as one`,
        )) as unknown as Rows;
        return rows.length;
      }),
    );
    expect(refused(outcome)).toBe(true);
  });
});

describe("settings: global and segment rows need an admin", () => {
  const globalRow = (agency: AgencyWorld) => ({
    agencyId: agency.agencyId,
    scope: "global",
    key: `test.${Math.random().toString(36).slice(2)}`,
    value: 1,
  });
  const entry = ISOLATION_MATRIX.find((candidate) => candidate.name === "setting_values")!;
  const tryInsert = (actorName: CastName, values: Record<string, unknown>) =>
    t.db.asUser(world.users[actorName]).run(({ tx }) =>
      probe(tx, async (inner) => {
        await insertRow(inner, entry, values);
        return 1;
      }),
    );

  it("an admin writes agency-wide settings; a member does not", async () => {
    const { a, b } = world.agencies;
    expect((await tryInsert("aAdmin", globalRow(a))).ok).toBe(true);
    expect(((await tryInsert("aMember", globalRow(a))) as { code: string | null }).code).toBe(
      PG_ERROR.insufficientPrivilege,
    );
    expect(((await tryInsert("aAdmin", globalRow(b))) as { code: string | null }).code).toBe(
      PG_ERROR.insufficientPrivilege,
    );
    const segmentRow = { ...globalRow(a), scope: "segment", segmentId: a.segmentId };
    expect((await tryInsert("aAdmin", segmentRow)).ok).toBe(true);
    expect(((await tryInsert("aMember", segmentRow)) as { code: string | null }).code).toBe(
      PG_ERROR.insufficientPrivilege,
    );
  });

  it("a member cannot edit or delete an agency-wide setting", async () => {
    const { a } = world.agencies;
    const id = a.rows.get("setting_values")!.agencyLevel!;
    await t.db.asUser(world.users.aMember).run(async ({ tx }) => {
      expect(refused(await probe(tx, (inner) => updateRow(inner, entry, id)))).toBe(true);
      expect(refused(await probe(tx, (inner) => deleteRow(inner, entry, id)))).toBe(true);
    });
    await t.db.asUser(world.users.aAdmin).run(async ({ tx }) => {
      expect(wentThrough(await probe(tx, (inner) => updateRow(inner, entry, id)))).toBe(true);
    });
  });

  it("a user records setting history only under their own name", async () => {
    const { a1 } = world.businesses;
    const versions = ISOLATION_MATRIX.find((candidate) => candidate.name === "setting_versions")!;
    const history = (changedBy: string) => ({
      ...a1.tenant,
      scope: "business",
      key: `test.${Math.random().toString(36).slice(2)}`,
      version: 1,
      operation: "set",
      value: 1,
      changedBy,
    });
    await t.db.asUser(world.users.aMember).run(async ({ tx }) => {
      const forged = await probe(tx, async (inner) => {
        await insertRow(inner, versions, history(world.users.aAdmin.id));
        return 1;
      });
      expect((forged as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
      const own = await probe(tx, async (inner) => {
        await insertRow(inner, versions, history(world.users.aMember.id));
        return 1;
      });
      expect(own.ok).toBe(true);
    });
  });

  it("a business scope reads agency-wide settings but cannot write them", async () => {
    const { a1 } = world.businesses;
    await t.db.forBusiness(a1.tenant.businessId).run(async ({ tx }) => {
      const visible = await count(tx, entry, agencyLevel(a1.agency));
      expect(visible).toBeGreaterThan(0);
      const insert = await probe(tx, async (inner) => {
        await insertRow(inner, entry, globalRow(a1.agency));
        return 1;
      });
      expect((insert as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});

describe("audit log", () => {
  const entry = ISOLATION_MATRIX.find((candidate) => candidate.name === "audit_log")!;

  it("a user cannot write an entry under someone else's name or as the system", async () => {
    const { a1 } = world.businesses;
    await t.db.asUser(world.users.aMember).run(async ({ tx }) => {
      const forged = await probe(tx, async (inner) => {
        await insertRow(inner, entry, {
          ...a1.tenant,
          actorType: "user",
          actorUserId: world.users.aAdmin.id,
          action: "test.forged",
        });
        return 1;
      });
      expect((forged as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
      const asSystem = await probe(tx, async (inner) => {
        await insertRow(inner, entry, { ...a1.tenant, actorType: "system", action: "test.forged" });
        return 1;
      });
      expect((asSystem as { code: string | null }).code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  it("cannot be rewritten even on the unrestricted connection", async () => {
    const id = fixtureId(world.businesses.a1.rows, entry);
    const outcome = await probe(t.admin as unknown as Transaction, (tx) =>
      updateRow(tx, entry, id),
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: string | null }).code).toBe(PG_ERROR.restrictViolation);
  });

  it("keeps its entries when the acting user is deleted", async () => {
    const temp = await t.db.localAuth.upsertUser({ email: "leaver@world.test" });
    const { a1 } = world.businesses;
    await t.admin.insert(agencyMemberships).values({
      agencyId: a1.tenant.agencyId,
      userId: temp.id,
      role: "agency_member",
    });
    await t.db.asUser({ id: temp.id, email: temp.email }).run(async ({ tx }) => {
      await insertRow(tx, entry, {
        ...a1.tenant,
        actorType: "user",
        actorUserId: temp.id,
        actorLabel: temp.email,
        action: "test.leaver",
      });
    });
    await t.db.localAuth.deleteUser(temp.id);
    const rows = (await t.admin.execute(
      sql`select actor_user_id, actor_label from audit_log where action = 'test.leaver'`,
    )) as unknown as Rows;
    expect(rows).toEqual([{ actor_user_id: null, actor_label: "leaver@world.test" }]);
  });
});

describe("the webhook-to-tenant mapping cannot be claimed by a user", () => {
  it("no signed-in user can create or repoint a channel or integration connection", async () => {
    const { a1, b1 } = world.businesses;
    const victimAccount = (await t.admin.execute(
      sql`select external_account_id from channel_connections where id = ${b1.rows.get("channel_connections")?.fixture}::uuid`,
    )) as unknown as Rows;
    const accountId = victimAccount[0]?.["external_account_id"] as string;

    for (const actorName of ["aAdmin", "aMember", "a1Owner"] as const) {
      await t.db.asUser(world.users[actorName]).run(async ({ tx }) => {
        // Claim another agency's account for my own business...
        const claim = await probe(tx, async (inner) => {
          await inner.execute(sql`
            insert into channel_connections (agency_id, business_id, channel, external_account_id)
            values (${a1.tenant.agencyId}::uuid, ${a1.tenant.businessId}::uuid, 'whatsapp', ${accountId})`);
          return 1;
        });
        expect((claim as { code: string | null }).code, `${actorName} claiming`).toBe(
          PG_ERROR.insufficientPrivilege,
        );
        // ...or repoint one of my own connections at it.
        const repoint = await probe(tx, async (inner) => {
          const rows = (await inner.execute(sql`
            update channel_connections set external_account_id = ${accountId}, channel = 'whatsapp'
             where id = ${a1.rows.get("channel_connections")?.spare}::uuid returning 1 as one`)) as unknown as Rows;
          return rows.length;
        });
        expect(refused(repoint), `${actorName} repointing: ${describeOutcome(repoint)}`).toBe(true);

        const integration = await probe(tx, async (inner) => {
          const rows = (await inner.execute(sql`
            update integration_connections set external_account_id = 'someone-elses-account'
             where id = ${a1.rows.get("integration_connections")?.spare}::uuid returning 1 as one`)) as unknown as Rows;
          return rows.length;
        });
        expect(refused(integration), `${actorName} repointing an integration`).toBe(true);
      });
    }
  });

  it("an account id maps to exactly one tenant, even for the system scope", async () => {
    const { a1, b1 } = world.businesses;
    const rows = (await t.admin.execute(
      sql`select channel, external_account_id from channel_connections where id = ${b1.rows.get("channel_connections")?.fixture}::uuid`,
    )) as unknown as Rows;
    const outcome = await t.db.forBusiness(a1.tenant.businessId).run(({ tx, tenant }) =>
      probe(tx, async (inner) => {
        await inner.execute(sql`
          insert into channel_connections (agency_id, business_id, channel, external_account_id)
          values (${tenant.agencyId}::uuid, ${tenant.businessId}::uuid, ${rows[0]?.["channel"] as string}, ${rows[0]?.["external_account_id"] as string})`);
        return 1;
      }),
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: string | null }).code).toBe(PG_ERROR.uniqueViolation);
  });
});

describe("a child row cannot point at another tenant's parent", () => {
  it("refuses a message in my business that hangs on another business's conversation", async () => {
    const { a1, a2, b1 } = world.businesses;
    const entry = ISOLATION_MATRIX.find((candidate) => candidate.name === "messages")!;
    for (const victim of [a2, b1]) {
      const values = {
        ...entry.row(world.rowContext(a1, "attempt")),
        conversationId: victim.rows.get("conversations")?.fixture,
      };
      const outcome = await t.db.forBusiness(a1.tenant.businessId).run(({ tx }) =>
        probe(tx, async (inner) => {
          await insertRow(inner, entry, values);
          return 1;
        }),
      );
      expect(outcome.ok, `message on a conversation of ${victim.key}`).toBe(false);
      expect((outcome as { code: string | null }).code).toBe(PG_ERROR.foreignKeyViolation);
    }
  });

  it("refuses the same for every parent reference in the matrix", async () => {
    // For each table, swap each reference to a parent row for the victim's parent row.
    const { a1, b1 } = world.businesses;
    let checked = 0;
    for (const entry of businessEntries) {
      const base = entry.row(world.rowContext(a1, "attempt"));
      const victimValues = entry.row(world.rowContext(b1, "attempt"));
      for (const [property, value] of Object.entries(base)) {
        const victimValue = victimValues[property];
        const isParentReference =
          typeof value === "string" &&
          typeof victimValue === "string" &&
          value !== victimValue &&
          [...a1.rows.values()].some((refs) => refs.fixture === value || refs.spare === value);
        if (!isParentReference) continue;
        const outcome = await probe(t.admin as unknown as Transaction, async (tx) => {
          await insertRow(tx, entry, { ...base, [property]: victimValue });
          return 1;
        });
        expect(outcome.ok, `${entry.name}.${property} pointing into another tenant`).toBe(false);
        expect((outcome as { code: string | null }).code, `${entry.name}.${property}`).toBe(
          PG_ERROR.foreignKeyViolation,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(25);
  });
});
