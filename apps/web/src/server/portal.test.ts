import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { contacts, eq, loadUserAccess, type UserIdentity } from "@repo/db";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";
import { applySettingChanges } from "@repo/settings/server";

import type { SessionAccess } from "@/server/auth";

import { exportLeadsCsv } from "./leads";
import { NO_PERMISSIONS, permissionsFor, STAFF_PERMISSIONS, screenBusinesses } from "./portal";

/*
 * The client portal's permissions (C16) and the CSV export, which is authorized like the list
 * it exports: per role and per business's settings, with ids from the address ignored unless
 * the person may see that business.
 */

let t: TestDatabase;
let world: World;

vi.mock("@/server/auth", () => ({
  userDatabase: (user: UserIdentity) => t.db.asUser({ id: user.id, email: user.email }),
}));
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => t.db,
}));

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});
afterAll(async () => {
  await t.dispose();
});

async function session(user: UserIdentity): Promise<SessionAccess> {
  return {
    user: { id: user.id, email: user.email ?? null },
    access: await t.db.asUser(user).run((ctx) => loadUserAccess(ctx)),
  };
}

async function setPortal(key: "a1", values: Record<string, unknown>) {
  const tenant = world.businesses[key].tenant;
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([setting, value]) => ({ key: setting, value })),
      actor: { type: "system", label: "test" },
    }),
  );
}

const DEFAULTS = {
  "client_portal.enabled": true,
  "client_portal.view_conversations": "owner_and_staff",
  "client_portal.reply_and_take_over": "nobody",
  "client_portal.view_leads": "owner_and_staff",
  "client_portal.view_lead_reports": "owner",
  "client_portal.export_leads": "owner",
  "client_portal.view_analytics": "owner",
} as const;

describe("permissionsFor", () => {
  it("gives staff everything and client users what the settings say", () => {
    expect(
      permissionsFor("agency_member", { ...DEFAULTS, "client_portal.enabled": false }),
    ).toEqual(STAFF_PERMISSIONS);
    expect(permissionsFor("client_owner", DEFAULTS)).toEqual({
      staff: false,
      viewConversations: true,
      reply: false,
      viewLeads: true,
      viewReports: true,
      exportLeads: true,
      viewAnalytics: true,
    });
    expect(permissionsFor("client_staff", DEFAULTS)).toEqual({
      staff: false,
      viewConversations: true,
      reply: false,
      viewLeads: true,
      viewReports: false,
      exportLeads: false,
      viewAnalytics: false,
    });
    expect(permissionsFor("client_owner", { ...DEFAULTS, "client_portal.enabled": false })).toEqual(
      NO_PERMISSIONS,
    );
    // Exporting needs seeing leads; replying needs seeing conversations.
    expect(
      permissionsFor("client_owner", {
        ...DEFAULTS,
        "client_portal.view_leads": "nobody",
        "client_portal.view_conversations": "nobody",
        "client_portal.reply_and_take_over": "owner",
      }),
    ).toMatchObject({ exportLeads: false, reply: false });
    expect(permissionsFor(null, DEFAULTS)).toEqual(NO_PERMISSIONS);
  });

  it("lists the businesses of each screen for each role", async () => {
    const staff = await screenBusinesses(await session(world.users.aMember), "analytics");
    expect(staff.map((business) => business.id).sort()).toEqual(
      [world.businesses.a1, world.businesses.a2, world.businesses.a3]
        .map((business) => business.tenant.businessId)
        .sort(),
    );
    const owner = await screenBusinesses(await session(world.users.a1Owner), "analytics");
    expect(owner.map((business) => business.id)).toEqual([world.businesses.a1.tenant.businessId]);
    expect(await screenBusinesses(await session(world.users.a1Staff), "analytics")).toEqual([]);
    expect(await screenBusinesses(await session(world.users.a3Owner), "leads")).toEqual([]);
  });
});

describe("CSV export", () => {
  it("is authorized like the list and neutralizes formulas", async () => {
    const contactId = world.businesses.a1.rows.get("contacts")!.fixture!;
    await t.admin
      .update(contacts)
      .set({ displayName: '=HYPERLINK("http://evil.example","click")', phone: "+15555550123" })
      .where(eq(contacts.id, contactId as never));
    const owner = await exportLeadsCsv(await session(world.users.a1Owner), {});
    expect(owner).not.toBeNull();
    expect(owner!.csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(owner!.csv).toContain("'+15555550123");
    expect(owner!.csv).not.toMatch(/(^|,)=HYPERLINK/m);
    // Only the owner's business, whatever the address asks for.
    const swapped = await exportLeadsCsv(await session(world.users.a1Owner), {
      business: world.businesses.b1.tenant.businessId,
    });
    expect(swapped!.count).toBe(owner!.count);
    expect(swapped!.csv).not.toContain("Business B1");
    // The owner's staff may not export (default "owner"), nor may anyone without access.
    expect(await exportLeadsCsv(await session(world.users.a1Staff), {})).toBeNull();
    expect(await exportLeadsCsv(await session(world.users.outsider), {})).toBeNull();
    await setPortal("a1", { "client_portal.export_leads": "nobody" });
    expect(await exportLeadsCsv(await session(world.users.a1Owner), {})).toBeNull();
    // Agency staff export their agency's leads, not another agency's.
    const staff = await exportLeadsCsv(await session(world.users.aAdmin), {});
    expect(staff!.csv).toContain("Business A1");
    expect(staff!.csv).not.toContain("Business B1");
  });
});
