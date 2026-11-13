import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenantAccessError, ValidationError } from "@repo/core";

import { auditLog, businesses } from "../schema/tables";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "../testing";
import { eq } from "drizzle-orm";
import {
  businessSlug,
  createBusiness,
  getVisibleBusiness,
  isTimeZone,
  listVisibleBusinesses,
  setBusinessStatus,
  updateBusinessProfile,
} from "./businesses";

/*
 * The admin panel's business functions (C15), as every kind of user: staff of the agency
 * create and change, a client user sees only their own business, nobody reaches another
 * agency's.
 */

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});
afterAll(async () => {
  await t.dispose();
});

const profile = {
  name: "Lone Star Plumbing & Drain",
  timezone: "America/Chicago",
  websiteUrl: "https://lonestar.example.com",
  phone: "+1 512 555 0142",
  email: "office@lonestar.example.com",
  addressLine1: "",
  addressLine2: "",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
};

describe("businesses", () => {
  it("makes slugs and checks time zones", () => {
    expect(businessSlug("Lone Star Plumbing & Drain")).toBe("lone-star-plumbing-and-drain");
    expect(businessSlug("!!!")).toBe("business");
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("not a zone")).toBe(false);
  });

  it("lets agency staff create a business, in onboarding, with a unique slug and an audit entry", async () => {
    const created = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => createBusiness(ctx, { agencyId: world.agencies.a.agencyId, profile }));
    expect(created).toMatchObject({
      name: "Lone Star Plumbing & Drain",
      slug: "lone-star-plumbing-and-drain",
      status: "onboarding",
      segment: null,
      addressLine1: null,
      city: "Austin",
    });
    const again = await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => createBusiness(ctx, { agencyId: world.agencies.a.agencyId, profile }));
    expect(again.slug).toBe("lone-star-plumbing-and-drain-2");

    const audit = await t.admin
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.targetId, created.id));
    expect(audit).toEqual([{ action: "business.create", actor: world.users.aMember.id }]);
  });

  it("refuses client users and staff of another agency", async () => {
    for (const user of [world.users.a1Owner, world.users.bAdmin, world.users.outsider]) {
      await expect(
        t.db
          .asUser(user)
          .run((ctx) => createBusiness(ctx, { agencyId: world.agencies.a.agencyId, profile })),
      ).rejects.toBeInstanceOf(TenantAccessError);
    }
  });

  it("validates the profile", async () => {
    await expect(
      t.db.asUser(world.users.aAdmin).run((ctx) =>
        createBusiness(ctx, {
          agencyId: world.agencies.a.agencyId,
          profile: { ...profile, name: " ", timezone: "Nowhere/Land", state: "Texas" },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("shows each user only what they may see", async () => {
    const names = async (name: keyof World["users"]) =>
      (await t.db.asUser(world.users[name]).run((ctx) => listVisibleBusinesses(ctx))).map(
        (business) => business.id,
      );
    const a1 = world.businesses.a1.tenant.businessId;
    const b1 = world.businesses.b1.tenant.businessId;
    expect(await names("a1Owner")).toEqual([a1]);
    expect(await names("a3Owner")).toEqual([]);
    expect(await names("aAdmin")).toContain(a1);
    expect(await names("aAdmin")).not.toContain(b1);
    expect(await names("outsider")).toEqual([]);
    const seen = await t.db.asUser(world.users.a1Owner).run((ctx) => getVisibleBusiness(ctx, b1));
    expect(seen).toBeNull();
  });

  it("updates the profile and the status for staff only", async () => {
    const id = world.businesses.a2.tenant.businessId;
    const updated = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => updateBusinessProfile(ctx, { businessId: id, profile }));
    expect(updated.city).toBe("Austin");
    await expect(
      t.db
        .asUser(world.users.a2Owner)
        .run((ctx) => updateBusinessProfile(ctx, { businessId: id, profile })),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      t.db
        .asUser(world.users.bAdmin)
        .run((ctx) => updateBusinessProfile(ctx, { businessId: id, profile })),
    ).rejects.toThrow();

    const paused = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => setBusinessStatus(ctx, { businessId: id, status: "paused" }));
    expect(paused.status).toBe("paused");
    // Archiving is for admins.
    await expect(
      t.db
        .asUser(world.users.aMember)
        .run((ctx) => setBusinessStatus(ctx, { businessId: id, status: "archived" })),
    ).rejects.toBeInstanceOf(TenantAccessError);
    const [row] = await t.admin
      .select({ status: businesses.status })
      .from(businesses)
      .where(eq(businesses.id, id));
    expect(row?.status).toBe("paused");
  });

  it("does not activate a business without a segment", async () => {
    const created = await t.db.asUser(world.users.aAdmin).run((ctx) =>
      createBusiness(ctx, {
        agencyId: world.agencies.a.agencyId,
        profile: { ...profile, name: "No Segment Yet" },
      }),
    );
    await expect(
      t.db
        .asUser(world.users.aAdmin)
        .run((ctx) => setBusinessStatus(ctx, { businessId: created.id, status: "active" })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
