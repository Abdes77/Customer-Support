import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO, seedDemoData } from "../seed/demo";
import { createTestDatabase, type TestDatabase } from "../testing";
import { computeAnalytics, summarize } from "./analytics";
import { listAuditLog, redactAuditValue } from "./audit";
import { csvCell, csvLine, isCalendarDay, listLeads } from "./leads";

/*
 * Analytics (C16) against the demo data (src/seed/demo.ts): the totals must equal what the
 * seed wrote. The seed's conversations, at "now":
 *
 *   business  channel  first reply  furthest step   lead
 *   roofing   test     120 s        booked          meeting_booked (Dana)
 *   roofing   test     120 s        engaged         qualifying (Marcus)
 *   roofing   test     120 s        engaged         disqualified (Priya)
 *   roofing   widget    45 s        answered        new (Kim)
 *   hvac      test     120 s        qualified       handed_off (Helen)
 *   hvac      test     120 s        qualified       qualified (Jordan)
 *   hvac      widget    60 s        engaged         qualifying (Luis)
 */

const NOW = new Date("2026-11-10T18:00:00.000Z");
const FROM = new Date(NOW.getTime() - 30 * 24 * 3_600_000);
const TO = new Date(NOW.getTime() + 24 * 3_600_000);
const ADMIN = { id: DEMO.users.agencyAdmin.id, email: DEMO.users.agencyAdmin.email };
const OWNER = { id: DEMO.users.clientOwner.id, email: DEMO.users.clientOwner.email };

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await seedDemoData(t.db, { now: NOW });
});
afterAll(async () => {
  await t.dispose();
});

describe("analytics", () => {
  it("totals match the seeded data", async () => {
    const report = await t.db
      .asUser(ADMIN)
      .run((ctx) => computeAnalytics(ctx, { from: FROM, to: TO, businessIds: null }));
    expect(report.total).toEqual({
      conversations: 7,
      answered: 7,
      firstResponseMedianSeconds: 120,
      // (5 × 120 + 45 + 60) / 7 = 100.7
      firstResponseMeanSeconds: 101,
      qualified: 3,
      qualificationRate: 3 / 7,
      bookedMeetings: 1,
      reached: { started: 7, answered: 7, engaged: 6, qualified: 3, booked: 1 },
      stoppedAt: { started: 0, answered: 1, engaged: 3, qualified: 2, booked: 1 },
      dropOffStep: { after: "engaged", lost: 3 },
    });
    expect(
      report.byChannel.map((group) => [
        group.key,
        group.conversations,
        group.firstResponseMeanSeconds,
      ]),
    ).toEqual([
      ["test", 5, 120],
      ["widget", 2, 53],
    ]);
    expect(
      report.byBusiness.map((group) => [
        group.label,
        group.conversations,
        group.qualified,
        group.bookedMeetings,
      ]),
    ).toEqual([
      ["Summit Roofing Co.", 4, 1, 1],
      ["Evergreen Heating & Air", 3, 2, 0],
    ]);
    expect(report.bySegment.map((group) => [group.label, group.conversations])).toEqual([
      ["Roofing", 4],
      ["Heating and cooling (HVAC)", 3],
    ]);
  });

  it("gives a client user their own business's numbers only", async () => {
    const report = await t.db
      .asUser(OWNER)
      .run((ctx) => computeAnalytics(ctx, { from: FROM, to: TO, businessIds: null }));
    expect(report.total.conversations).toBe(4);
    expect(report.byBusiness.map((group) => group.key)).toEqual([DEMO.businesses.roofing]);
    // Asking for the other business changes nothing: RLS hides it.
    const other = await t.db
      .asUser(OWNER)
      .run((ctx) =>
        computeAnalytics(ctx, { from: FROM, to: TO, businessIds: [DEMO.businesses.hvac] }),
      );
    expect(other.total.conversations).toBe(0);
  });

  it("counts only the period asked for", async () => {
    const lastDay = await t.db.asUser(ADMIN).run((ctx) =>
      computeAnalytics(ctx, {
        from: new Date(NOW.getTime() - 24 * 3_600_000),
        to: TO,
        businessIds: null,
      }),
    );
    // Started 20 h and 8 h and 5 h before "now": Helen, Luis, Marcus.
    expect(lastDay.total.conversations).toBe(3);
    expect(summarize([]).qualificationRate).toBeNull();
  });
});

describe("lead list and CSV", () => {
  it("lists what the user may see, with reports only when allowed", async () => {
    const staff = await t.db
      .asUser(ADMIN)
      .run((ctx) => listLeads(ctx, { businessIds: null, includeReports: true }));
    expect(staff.rows).toHaveLength(7);
    expect(staff.rows.every((row) => row.summary !== null)).toBe(true);
    const owner = await t.db
      .asUser(OWNER)
      .run((ctx) => listLeads(ctx, { businessIds: null, includeReports: false, sort: "score" }));
    expect(owner.rows.map((row) => row.contactName)).toEqual([
      "Dana Whitfield",
      "Marcus Reyes",
      "Kim Tran",
      "Priya Nair",
    ]);
    expect(owner.rows.every((row) => row.summary === null)).toBe(true);
    const filtered = await t.db.asUser(ADMIN).run((ctx) =>
      listLeads(ctx, {
        businessIds: null,
        includeReports: false,
        channel: "widget",
        q: "o",
      }),
    );
    expect(filtered.rows.map((row) => row.contactName).sort()).toEqual(["Luis Ortega"]);
  });

  it("accepts only calendar days as date filters", async () => {
    expect(isCalendarDay("2026-11-10")).toBe(true);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    for (const bad of ["2026-13-45", "2025-02-29", "2026-1-1", "", "2026-11-10T00:00"]) {
      expect(isCalendarDay(bad), bad).toBe(false);
    }
    await expect(
      t.db
        .asUser(ADMIN)
        .run((ctx) =>
          listLeads(ctx, { businessIds: null, includeReports: false, from: "2026-13-45" }),
        ),
    ).rejects.toThrow();
  });

  it("neutralizes cells a spreadsheet would run as formulas", () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell("+1 303 555 0142")).toBe("'+1 303 555 0142");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tTab")).toBe("'\tTab");
    expect(csvCell("plain, with comma")).toBe('"plain, with comma"');
    expect(csvCell(null)).toBe("");
    expect(csvLine(["a", 1, "b\nc"])).toBe('a,1,"b\nc"');
  });
});

describe("audit log viewer", () => {
  it("is readable by agency admins only, with secret-sounding values hidden", async () => {
    const member = { id: DEMO.users.agencyMember.id, email: DEMO.users.agencyMember.email };
    const admin = await t.db.asUser(ADMIN).run((ctx) => listAuditLog(ctx));
    expect(admin.rows.map((row) => row.action)).toContain("seed.run");
    for (const user of [member, OWNER]) {
      const seen = await t.db.asUser(user).run((ctx) => listAuditLog(ctx));
      expect(seen.rows).toEqual([]);
    }
    expect(
      redactAuditValue({
        name: "zapier",
        signingSecret: "whsec_x",
        nested: [{ apiKey: "k", ok: 1 }],
      }),
    ).toEqual({
      name: "zapier",
      signingSecret: "[hidden]",
      nested: [{ apiKey: "[hidden]", ok: 1 }],
    });
  });
});
