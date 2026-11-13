import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, LeadSnapshot, PlaybookDocument, type UserId } from "@repo/core";

import { loadUserAccess } from "../access";
import type { Database } from "../database";
import {
  businesses,
  conversations,
  leadFields,
  leads,
  messages,
  playbookVersions,
  users,
} from "../schema/tables";
import { createTestDatabase, type TestDatabase } from "../testing";
import { DEMO, DEMO_PASSWORD, seedDemoData } from "./demo";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.dispose();
});

type Rows = readonly Record<string, unknown>[];

async function tableCounts(): Promise<Record<string, number>> {
  const names = (await t.admin.execute(
    sql`select tablename as name from pg_tables where schemaname = 'public' order by 1`,
  )) as unknown as Rows;
  const counts: Record<string, number> = {};
  for (const { name } of names) {
    const rows = (await t.admin.execute(
      sql`select count(*)::int as n from ${sql.identifier(name as string)}`,
    )) as unknown as Rows;
    counts[name as string] = Number(rows[0]?.["n"]);
  }
  return counts;
}

describe("seedDemoData", () => {
  it("loads one agency, two businesses in different segments, and four users", async () => {
    const summary = await seedDemoData(t.db, { now: new Date("2026-11-11T18:00:00Z") });

    expect(summary.agencyId).toBe(DEMO.agencyId);
    expect(summary.businesses.map((business) => business.segment)).toEqual(["roofing", "hvac"]);
    expect(summary.users.map((user) => user.role).sort()).toEqual([
      "agency_admin",
      "agency_member",
      "client_owner",
      "client_staff",
    ]);

    const counts = await tableCounts();
    expect(counts).toMatchObject({
      agencies: 1,
      users: 4,
      agency_memberships: 2,
      business_memberships: 2,
      segments: 2,
      playbook_versions: 2,
      businesses: 2,
      channel_connections: 4,
      conversations: 7,
      contacts: 7,
      leads: 7,
      lead_reports: 7,
      routing_decisions: 7,
      bookings: 1,
      escalations: 1,
      alerts: 1,
    });
    // What the summary reports is what is in the tables.
    for (const [table, count] of Object.entries(summary.counts)) {
      expect(counts[table], table).toBe(count);
    }
    expect(counts["messages"]).toBeGreaterThan(20);
  });

  it("can be run again without duplicating anything", async () => {
    const before = await tableCounts();
    await seedDemoData(t.db);
    await seedDemoData(t.db);
    expect(await tableCounts()).toEqual(before);
  });

  it("writes data that satisfies the contracts in @repo/core", async () => {
    const playbooks = await t.admin.select().from(playbookVersions);
    for (const playbook of playbooks) {
      expect(PlaybookDocument.safeParse(playbook.document).success).toBe(true);
      expect(playbook.isActive).toBe(true);
    }

    const allLeads = await t.admin.select().from(leads);
    for (const lead of allLeads) {
      const fields = await t.admin.select().from(leadFields).where(eq(leadFields.leadId, lead.id));
      const snapshot = LeadSnapshot.safeParse({
        id: lead.id,
        status: lead.status,
        fields: Object.fromEntries(
          fields.map((field) => [
            field.key,
            {
              key: field.key,
              value: field.value,
              confidence: field.confidence,
              evidence: field.evidence,
              updatedAt: field.updatedAt.toISOString(),
            },
          ]),
        ),
        routing: {
          outcome: lead.routingOutcome,
          score: lead.score,
          band: lead.band,
          reasons: [],
          decidedAt: lead.routingDecidedAt?.toISOString(),
          settingsVersion: lead.settingsVersion,
        },
      });
      expect(snapshot.success, JSON.stringify(snapshot.error?.issues)).toBe(true);
    }
    expect(new Set(allLeads.map((lead) => lead.status))).toEqual(
      new Set(["meeting_booked", "qualifying", "disqualified", "handed_off", "qualified", "new"]),
    );
  });

  it("keeps conversations consistent: sequences, counters and timestamps", async () => {
    const all = await t.admin.select().from(conversations);
    for (const conversation of all) {
      const thread = await t.admin
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(messages.sequence);
      expect(thread.map((message) => message.sequence)).toEqual(
        thread.map((_unused, index) => index + 1),
      );
      expect(conversation.messageSeq).toBe(thread.length);
      expect(conversation.lastMessageAt?.getTime()).toBe(thread.at(-1)?.sentAt?.getTime());
      expect(thread[0]?.direction).toBe("inbound");
    }
  });

  it("gives every demo user a working password and the right view of the data", async () => {
    const signIn = async (email: string) => {
      const user = await t.db.localAuth.verifyPassword(email, DEMO_PASSWORD);
      expect(user, email).not.toBeNull();
      return { id: user!.id, email };
    };
    const visibleBusinesses = async (db: Database, user: { id: UserId; email: string }) =>
      (await db.asUser(user).run(({ tx }) => tx.select({ name: businesses.name }).from(businesses)))
        .map((row) => row.name)
        .sort();

    const admin = await signIn(DEMO.users.agencyAdmin.email);
    expect(await visibleBusinesses(t.db, admin)).toEqual([
      "Evergreen Heating & Air",
      "Summit Roofing Co.",
    ]);
    const adminAccess = await t.db.asUser(admin).run((ctx) => loadUserAccess(ctx));
    expect(adminAccess.agencies).toEqual([{ agencyId: DEMO.agencyId, role: "agency_admin" }]);

    const owner = await signIn(DEMO.users.clientOwner.email);
    expect(await visibleBusinesses(t.db, owner)).toEqual(["Summit Roofing Co."]);
    const ownerLeads = await t.db
      .asUser(owner)
      .run(({ tx }) => tx.select({ businessId: leads.businessId }).from(leads));
    expect(ownerLeads).toHaveLength(4);
    expect(new Set(ownerLeads.map((lead) => lead.businessId))).toEqual(
      new Set([DEMO.businesses.roofing]),
    );

    expect(await t.db.localAuth.verifyPassword(DEMO.users.clientStaff.email, "wrong")).toBeNull();
    const profiles = await t.admin.select({ name: users.fullName }).from(users);
    expect(profiles.map((profile) => profile.name).sort()).toEqual([
      "Avery Admin",
      "Morgan Member",
      "Riley Owner",
      "Sam Staff",
    ]);
  });

  it("uses the given password, and the Supabase path when the local store is absent", async () => {
    await seedDemoData(t.db, { password: "another-password-123" });
    expect(
      await t.db.localAuth.verifyPassword(DEMO.users.agencyMember.email, "another-password-123"),
    ).not.toBeNull();
    expect(
      await t.db.localAuth.verifyPassword(DEMO.users.agencyMember.email, DEMO_PASSWORD),
    ).toBeNull();

    // A database without the local store (a Supabase one) needs a way to create auth users.
    const supabaseLike = {
      ...t.db,
      localAuth: { ...t.db.localAuth, isAvailable: async () => false },
    } as Database;
    await expect(seedDemoData(supabaseLike)).rejects.toBeInstanceOf(ConfigError);

    const created: string[] = [];
    await seedDemoData(supabaseLike, {
      createAuthUser: async ({ email }) => {
        created.push(email);
        const existing = await t.db.directory.findUserByEmail(email);
        return existing!.id;
      },
    });
    expect(created.sort()).toEqual(
      Object.values(DEMO.users)
        .map((user) => user.email)
        .sort(),
    );
  });
});
