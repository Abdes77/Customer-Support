import { randomBytes, randomInt } from "node:crypto";

import { getTableColumns } from "drizzle-orm";

import type { AgencyId, BusinessId, Role, SegmentId, UserId } from "@repo/core";

import type { BusinessTenant, UserIdentity } from "../context";
import { agencyMemberships, businesses, businessMemberships, segments } from "../schema/tables";
import type { TestDatabase } from "./database";
import { ISOLATION_MATRIX, type MatrixEntry, type RowContext } from "./isolation-matrix";

/**
 * A small multi-tenant world for tests: two agencies, four businesses, one user per role,
 * and one row in every table for every business (built from the isolation matrix).
 *
 *   Agency A                                   Agency B
 *     aAdmin (agency_admin)                      bAdmin (agency_admin)
 *     aMember (agency_member)                    bMember (agency_member)
 *     business a1 (client logins on)             business b1 (client logins on)
 *       a1Owner (client_owner)                     b1Owner (client_owner)
 *       a1Staff (client_staff)
 *     business a2 (client logins on)
 *       a2Owner (client_owner)
 *     business a3 (client logins OFF)
 *       a3Owner (client_owner)
 *
 *   outsider: signed in, member of nothing.
 *
 * Other packages can use it for their own tests: `const world = await createWorld(t)`.
 */

export const CAST = [
  "aAdmin",
  "aMember",
  "a1Owner",
  "a1Staff",
  "a2Owner",
  "a3Owner",
  "bAdmin",
  "bMember",
  "b1Owner",
  "outsider",
] as const;
export type CastName = (typeof CAST)[number];

export type AgencyKey = "a" | "b";
export type BusinessKey = "a1" | "a2" | "a3" | "b1";

interface CastSpec {
  readonly role: Role | null;
  readonly agency: AgencyKey | null;
  readonly business: BusinessKey | null;
}

export const CAST_SPEC: Readonly<Record<CastName, CastSpec>> = {
  aAdmin: { role: "agency_admin", agency: "a", business: null },
  aMember: { role: "agency_member", agency: "a", business: null },
  a1Owner: { role: "client_owner", agency: null, business: "a1" },
  a1Staff: { role: "client_staff", agency: null, business: "a1" },
  a2Owner: { role: "client_owner", agency: null, business: "a2" },
  a3Owner: { role: "client_owner", agency: null, business: "a3" },
  bAdmin: { role: "agency_admin", agency: "b", business: null },
  bMember: { role: "agency_member", agency: "b", business: null },
  b1Owner: { role: "client_owner", agency: null, business: "b1" },
  outsider: { role: null, agency: null, business: null },
};

const BUSINESS_SPEC: Readonly<
  Record<BusinessKey, { readonly agency: AgencyKey; readonly portal: boolean }>
> = {
  a1: { agency: "a", portal: true },
  a2: { agency: "a", portal: true },
  a3: { agency: "a", portal: false },
  b1: { agency: "b", portal: true },
};

interface RowRefs {
  fixture?: string;
  spare?: string;
  /** shared tables: the agency-level row. */
  agencyLevel?: string;
}

export interface AgencyWorld {
  readonly key: AgencyKey;
  readonly agencyId: AgencyId;
  readonly segmentId: SegmentId;
  readonly adminId: UserId;
  readonly memberId: UserId;
  /** A user that exists and belongs to nothing in this agency. */
  readonly spareUserId: UserId;
  readonly rows: Map<string, RowRefs>;
}

export interface BusinessWorld {
  readonly key: BusinessKey;
  readonly agency: AgencyWorld;
  readonly tenant: BusinessTenant;
  readonly portalEnabled: boolean;
  readonly rows: Map<string, RowRefs>;
}

export interface World {
  readonly agencies: Readonly<Record<AgencyKey, AgencyWorld>>;
  readonly businesses: Readonly<Record<BusinessKey, BusinessWorld>>;
  readonly users: Readonly<Record<CastName, UserIdentity>>;
  /** Builds the argument of a matrix entry's `row` for a business. */
  rowContext(business: BusinessWorld, purpose: RowContext["purpose"], actor?: UserId): RowContext;
  /** As above for an agency-level row (agency tables, and agency rows of shared tables). */
  agencyRowContext(agency: AgencyWorld, purpose: RowContext["purpose"], actor?: UserId): RowContext;
}

function unique(prefix = "v"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Property name of the primary key column of a matrix entry. */
export function pkProperty(entry: MatrixEntry): string {
  const column = entry.pk ?? "id";
  const found = Object.entries(getTableColumns(entry.table)).find(
    ([, definition]) => definition.name === column,
  );
  if (found === undefined) throw new Error(`${entry.name} has no column ${column}`);
  return found[0];
}

async function insertRow(
  t: TestDatabase,
  entry: MatrixEntry,
  values: Record<string, unknown>,
): Promise<string> {
  const rows = (await t.admin
    .insert(entry.table)
    .values(values as never)
    .returning()) as Record<string, unknown>[];
  const id = rows[0]?.[pkProperty(entry)];
  if (typeof id !== "string") throw new Error(`Insert into ${entry.name} returned no id`);
  return id;
}

export async function createWorld(t: TestDatabase): Promise<World> {
  // People. The auth trigger creates their profiles.
  const users = {} as Record<CastName, UserIdentity>;
  for (const name of CAST) {
    const user = await t.db.localAuth.upsertUser({
      email: `${name.toLowerCase()}@world.test`,
      fullName: name,
    });
    users[name] = { id: user.id, email: user.email };
  }
  const spares = {} as Record<AgencyKey, UserId>;
  for (const key of ["a", "b"] as const) {
    spares[key] = (await t.db.localAuth.upsertUser({ email: `spare-${key}@world.test` })).id;
  }

  // Agencies, staff and one segment each.
  const agencies = {} as Record<AgencyKey, AgencyWorld>;
  for (const key of ["a", "b"] as const) {
    const { id: agencyId } = await t.db.platform.createAgency({
      name: `Agency ${key.toUpperCase()}`,
      slug: `agency-${key}`,
    });
    const adminId = users[key === "a" ? "aAdmin" : "bAdmin"].id;
    const memberId = users[key === "a" ? "aMember" : "bMember"].id;
    const memberships = await t.admin
      .insert(agencyMemberships)
      .values([
        { agencyId, userId: adminId, role: "agency_admin" },
        { agencyId, userId: memberId, role: "agency_member" },
      ])
      .returning({ id: agencyMemberships.id, role: agencyMemberships.role });
    const memberMembership = memberships.find((row) => row.role === "agency_member");
    const [segment] = await t.admin
      .insert(segments)
      .values({ agencyId, slug: "roofing", name: "Roofing" })
      .returning({ id: segments.id });
    if (segment === undefined || memberMembership === undefined) {
      throw new Error("Agency fixture insert returned no row");
    }
    agencies[key] = {
      key,
      agencyId,
      segmentId: segment.id,
      adminId,
      memberId,
      spareUserId: spares[key],
      // The rows the write tests aim at: the member's membership and the segment.
      rows: new Map<string, RowRefs>([
        ["agency_memberships", { fixture: memberMembership.id }],
        ["segments", { fixture: segment.id }],
      ]),
    };
  }

  // Businesses and client users.
  const businessWorlds = {} as Record<BusinessKey, BusinessWorld>;
  for (const key of Object.keys(BUSINESS_SPEC) as BusinessKey[]) {
    const spec = BUSINESS_SPEC[key];
    const agency = agencies[spec.agency];
    const [business] = await t.admin
      .insert(businesses)
      .values({
        agencyId: agency.agencyId,
        segmentId: agency.segmentId,
        name: `Business ${key.toUpperCase()}`,
        slug: key,
        status: "active",
        clientPortalEnabled: spec.portal,
      })
      .returning({ id: businesses.id });
    if (business === undefined) throw new Error("Business insert returned no row");
    businessWorlds[key] = {
      key,
      agency,
      tenant: { agencyId: agency.agencyId, businessId: business.id },
      portalEnabled: spec.portal,
      rows: new Map(),
    };
  }
  for (const name of CAST) {
    const spec = CAST_SPEC[name];
    if (spec.business === null || spec.role === null) continue;
    const business = businessWorlds[spec.business];
    const [membership] = await t.admin
      .insert(businessMemberships)
      .values({
        ...business.tenant,
        userId: users[name].id,
        role: spec.role === "client_owner" ? "client_owner" : "client_staff",
      })
      .returning({ id: businessMemberships.id });
    if (membership === undefined) throw new Error("Membership insert returned no row");
    // The row the write tests aim at: the owner's membership.
    if (spec.role === "client_owner") {
      business.rows.set("business_memberships", { fixture: membership.id });
    }
  }

  const hasSpare = new Set(ISOLATION_MATRIX.filter((e) => e.spare).map((e) => e.name));

  function context(
    agency: AgencyWorld,
    tenant: { agencyId: AgencyId; businessId: BusinessId },
    rows: Map<string, RowRefs>,
    purpose: RowContext["purpose"],
    actor: UserId | undefined,
  ): RowContext {
    return {
      tenant,
      purpose,
      actor: actor ?? agency.memberId,
      staffUserId: agency.memberId,
      spareUserId: agency.spareUserId,
      segmentId: agency.segmentId,
      ref(table) {
        const refs = rows.get(table) ?? agency.rows.get(table);
        const id = purpose === "attempt" && hasSpare.has(table) ? refs?.spare : refs?.fixture;
        if (id === undefined) {
          throw new Error(
            `The world has no ${purpose === "attempt" ? "spare " : ""}row in "${table}" yet. ` +
              "In the isolation matrix a table must come after the tables it refers to.",
          );
        }
        return id;
      },
      unique,
      uniqueInt: () => randomInt(1, 2_000_000_000),
    };
  }

  const world: World = {
    agencies,
    businesses: businessWorlds,
    users,
    rowContext: (business, purpose, actor) =>
      context(business.agency, business.tenant, business.rows, purpose, actor),
    agencyRowContext: (agency, purpose, actor) =>
      context(
        agency,
        // Agency-level rows have no business; factories for them never read `businessId`.
        { agencyId: agency.agencyId, businessId: undefined as unknown as BusinessId },
        agency.rows,
        purpose,
        actor,
      ),
  };

  // One row per table per tenant, in the matrix's dependency order.
  for (const entry of ISOLATION_MATRIX) {
    if (entry.kind === "agency") {
      if (entry.worldFixture) continue;
      for (const agency of Object.values(agencies)) {
        const id = await insertRow(t, entry, entry.row(world.agencyRowContext(agency, "fixture")));
        agency.rows.set(entry.name, { fixture: id });
      }
      continue;
    }
    for (const business of Object.values(businessWorlds)) {
      if (entry.worldFixture) continue;
      const refs: RowRefs = {
        fixture: await insertRow(t, entry, entry.row(world.rowContext(business, "fixture"))),
      };
      if (entry.spare) {
        refs.spare = await insertRow(t, entry, entry.row(world.rowContext(business, "spare")));
      }
      business.rows.set(entry.name, refs);
    }
    if (entry.kind === "shared" && entry.agencyRow !== undefined) {
      for (const agency of Object.values(agencies)) {
        const id = await insertRow(
          t,
          entry,
          entry.agencyRow(world.agencyRowContext(agency, "fixture")),
        );
        agency.rows.set(entry.name, { agencyLevel: id });
      }
    }
  }

  return world;
}
