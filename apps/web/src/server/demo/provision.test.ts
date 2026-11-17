import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgencyId } from "@repo/core";
import { and, businesses, eq, knowledgeItems, settingValues } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { getActivePlaybook, updateKnowledgeItem } from "@repo/knowledge";
import { applySettingChanges, loadSettings } from "@repo/settings/server";

import { demoSettings, provisionDemo } from "./provision";
import { SAMPLE_BUSINESSES } from "./sample-businesses";

/*
 * `pnpm demo:setup` against a real database: the sample businesses come out the way the
 * public demo site needs them, a second run changes nothing a person changed, and only
 * businesses with the switch on are listed.
 */

const actor = { type: "system", label: "demo test" } as const;

let t: TestDatabase;
let agencyId: AgencyId;

beforeAll(async () => {
  t = await createTestDatabase();
  agencyId = (await t.db.platform.createAgency({ name: "Northwind Leads", slug: "northwind" })).id;
});

afterAll(async () => {
  await t?.dispose();
});

describe("demo:setup", () => {
  it("stores every sample business ready for the demo site", async () => {
    const results = await provisionDemo({ db: t.db, agencyId });
    expect(results.map((result) => result.name)).toEqual(
      SAMPLE_BUSINESSES.map((sample) => sample.profile.name),
    );
    expect(results.every((result) => result.created && result.playbook === "stored")).toBe(true);

    const listed = await t.db.directory.listDemoBusinesses();
    expect(listed.map((entry) => entry.slug)).toEqual(results.map((result) => result.slug));
    expect(listed[0]).toMatchObject({
      agencyId,
      agencyName: "Northwind Leads",
      name: "Ironwood Roofing",
      city: "Lakewood",
      state: "CO",
      segmentSlug: "roofing",
      widgetKey: results[0]!.widgetKey,
    });

    for (const [index, result] of results.entries()) {
      const sample = SAMPLE_BUSINESSES[index]!;
      await t.db.forBusiness(result.businessId, { agencyId }).run(async (ctx) => {
        const [row] = await ctx.tx
          .select({ status: businesses.status, segmentId: businesses.segmentId })
          .from(businesses)
          .where(eq(businesses.id, result.businessId));
        expect(row?.status).toBe("active");
        // The trade has a playbook the engine can use.
        expect(await getActivePlaybook(ctx, row!.segmentId!)).toMatchObject({ origin: "starter" });
        const facts = await ctx.tx
          .select({ id: knowledgeItems.id })
          .from(knowledgeItems)
          .where(eq(knowledgeItems.businessId, result.businessId));
        expect(facts).toHaveLength(sample.facts.length);
        const { values } = await loadSettings(ctx, ctx.tenant);
        expect(values["channels.widget.demo_page"]).toBe(true);
        expect(values["persona.bot_name"]).toBe(sample.botName);
        expect(values["channels.widget.primary_color"]).toBe(sample.color);
        // A public page: what a visitor and a day can cost is capped below the defaults.
        expect(values["limits.contact_daily_spend_usd"]).toBeLessThanOrEqual(2);
        expect(values["limits.business_daily_spend_usd"]).toBeLessThanOrEqual(20);
        expect(values["follow_up.enabled"]).toBe(false);
      });
    }
  });

  it("can run again: nothing is duplicated and a person's changes stay", async () => {
    const [first] = await t.db.directory.listDemoBusinesses();
    const businessId = first!.businessId;
    // A person edits a fact and renames the bot in the admin panel.
    await t.db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
      const [fact] = await ctx.tx
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .where(
          and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.title, "Warranty")),
        );
      await updateKnowledgeItem(ctx, {
        tenant: ctx.tenant,
        id: fact!.id,
        patch: { content: "12-year workmanship warranty." },
        actor,
      });
    });

    const again = await provisionDemo({ db: t.db, agencyId });
    expect(again.every((result) => !result.created && result.playbook === "kept")).toBe(true);
    expect(again[0]!.facts).toMatchObject({ created: 0, updated: 0 });
    expect(again[0]!.widgetKey).toBe(first!.widgetKey);
    expect(await t.db.directory.listDemoBusinesses()).toHaveLength(SAMPLE_BUSINESSES.length);
    const rows = await t.admin
      .select({ content: knowledgeItems.content })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.title, "Warranty")));
    expect(rows).toEqual([{ content: "12-year workmanship warranty." }]);
  });

  it("lists a business only while its switch is on, its chat connected and it is active", async () => {
    const [first] = await t.db.directory.listDemoBusinesses();
    const tenant = { agencyId, businessId: first!.businessId };
    const set = (value: boolean) =>
      t.db.forBusiness(tenant.businessId, { agencyId }).run((ctx) =>
        applySettingChanges(ctx, {
          target: { scope: "business", ...tenant },
          changes: [{ key: "channels.widget.demo_page", value }],
          actor,
        }),
      );
    const slugs = async () =>
      (await t.db.directory.listDemoBusinesses()).map((entry) => entry.slug);

    await set(false);
    expect(await slugs()).not.toContain(first!.slug);
    await set(true);
    expect(await slugs()).toContain(first!.slug);

    await t.admin
      .update(businesses)
      .set({ status: "paused" })
      .where(eq(businesses.id, tenant.businessId));
    expect(await slugs()).not.toContain(first!.slug);
    await t.admin
      .update(businesses)
      .set({ status: "active" })
      .where(eq(businesses.id, tenant.businessId));
    expect(await slugs()).toContain(first!.slug);

    // The switch is a business-only setting: the row the directory reads is the whole value.
    const rows = await t.admin
      .select({ scope: settingValues.scope })
      .from(settingValues)
      .where(eq(settingValues.key, "channels.widget.demo_page"));
    expect(new Set(rows.map((row) => row.scope))).toEqual(new Set(["business"]));
  });

  it("sets only settings the registry accepts, each once", () => {
    for (const sample of SAMPLE_BUSINESSES) {
      const keys = demoSettings(sample).map((change) => change.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    // Sample contact details are obviously not real: 555 numbers and .example addresses.
    for (const sample of SAMPLE_BUSINESSES) {
      expect(sample.profile.phone).toMatch(/555-01\d\d$/);
      expect(sample.profile.email).toMatch(/\.example$/);
    }
  });
});
