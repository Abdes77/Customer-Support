import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BusinessId } from "@repo/core";
import {
  and,
  apiKeys,
  auditLog,
  businesses,
  businessMemberships,
  type BusinessTenant,
  eq,
  importRuns,
  knowledgeItems,
} from "@repo/db";
import { applySettingChanges } from "@repo/settings/server";

import { MAX_ACTIVE_FACTS } from "../knowledge/items";
import { createKnowledgeService, type KnowledgeService } from "../knowledge/service";
import { createKnowledgeHarness, type KnowledgeHarness, type TestAgency } from "../testing/harness";
import { type ApiKeyService, createApiKeyService } from "./api-keys";
import {
  handleCsvImportRequest,
  handleImportRequest,
  handleImportStatusRequest,
  MAX_JSON_BYTES,
} from "./http";

/**
 * Importing lead-generation data against PostgreSQL: the CSV upload of the admin panel and
 * the authenticated API, with valid and malformed data.
 */

let h: KnowledgeHarness;
let knowledge: KnowledgeService;
let keys: ApiKeyService;

beforeAll(async () => {
  h = await createKnowledgeHarness();
  const deps = { db: h.t.db, events: h.runner, logger: h.logger, clock: h.clock };
  knowledge = createKnowledgeService(deps);
  keys = createApiKeyService(deps);
});

afterAll(async () => {
  await h?.dispose();
});

const api = () => ({ db: h.t.db, logger: h.logger, clock: h.clock });

async function factsOf(business: BusinessTenant, status: "active" | "archived" | "all" = "active") {
  const rows = await h.t.admin
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.businessId, business.businessId))
    .orderBy(knowledgeItems.category, knowledgeItems.position, knowledgeItems.title);
  return status === "all" ? rows : rows.filter((row) => row.status === status);
}

async function profileOf(business: BusinessTenant) {
  const [row] = await h.t.admin
    .select()
    .from(businesses)
    .where(eq(businesses.id, business.businessId));
  return row!;
}

const WIDE_CSV = [
  "Ref,Company,Website,Phone,Email,City,State,Zip,Services,Service Area,Warranty,Financing",
  'crm-77,Summit Roofing Co.,summitroofing.example.com,(303) 555-0100,office@summitroofing.example.com,Lakewood,CO,80215,"Roof repair, full replacement, storm inspections","Lakewood, Golden, Arvada",10-year workmanship warranty,Financing through a lending partner',
].join("\n");

function post(
  path: string,
  init: { key?: string; body?: string; headers?: Record<string, string> },
) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      ...(init.key === undefined ? {} : { authorization: `Bearer ${init.key}` }),
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body ?? "{}",
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function agencyKey(agency: TestAgency, businessId: BusinessId | null = null) {
  return keys.create(agency.admin, agency.agencyId, { name: "Lead-gen sync", businessId });
}

describe("CSV upload in the admin panel", () => {
  it("imports a file for one business: facts with their source, the profile, a run and an audit entry", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness({ name: "New client", state: null });
    const result = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: WIDE_CSV,
      fileName: "summit.csv",
    });
    expect(result.status).toBe("succeeded");
    expect(result.problems).toEqual([]);
    expect(result.stats).toMatchObject({
      records: 1,
      recordsImported: 1,
      recordsFailed: 0,
      businesses: 1,
      factsCreated: 4,
      factsUpdated: 0,
    });
    expect(result.mapping["Services"]).toEqual({ to: "fact", category: "services" });

    const facts = await factsOf(business);
    expect(facts.map((fact) => [fact.category, fact.title, fact.content])).toEqual([
      ["financing", "Financing", "Financing through a lending partner"],
      ["service_area", "Service Area", "Lakewood, Golden, Arvada"],
      ["services", "Services", "Roof repair, full replacement, storm inspections"],
      ["warranties", "Warranty", "10-year workmanship warranty"],
    ]);
    for (const fact of facts) {
      expect(fact).toMatchObject({
        source: "csv_import",
        importRunId: result.importRunId,
        status: "active",
        updatedBy: agency.member.id,
        agencyId: agency.agencyId,
      });
      expect(fact.importKey).toMatch(/^import:[a-z_]+:[a-z0-9-]+$/);
      expect(fact.updatedAt).toBeInstanceOf(Date);
    }

    // Empty profile fields are filled; the name the agency gave the business stays.
    expect(await profileOf(business)).toMatchObject({
      name: "New client",
      websiteUrl: "https://summitroofing.example.com",
      phone: "(303) 555-0100",
      email: "office@summitroofing.example.com",
      city: "Lakewood",
      state: "CO",
      postalCode: "80215",
      externalRef: "crm-77",
    });

    const [run] = await h.t.admin
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, result.importRunId));
    expect(run).toMatchObject({
      kind: "csv",
      status: "succeeded",
      fileName: "summit.csv",
      businessId: business.businessId,
      createdBy: agency.member.id,
      errors: [],
    });
    expect(run?.stats).toMatchObject({ factsCreated: 4, mode: "merge", profileMode: "fill_empty" });
    expect(run?.finishedAt).not.toBeNull();
    const audit = await h.t.admin
      .select({ action: auditLog.action, summary: auditLog.summary, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(
        and(eq(auditLog.businessId, business.businessId), eq(auditLog.action, "knowledge.import")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: agency.member.id });
    expect(audit[0]?.summary).toContain("4 added");
    // The audit log names counts, never the text of a fact.
    expect(audit[0]?.summary).not.toContain("workmanship");

    const listed = await knowledge.listImports(agency.member, business.businessId);
    expect(listed.map((entry) => entry.id)).toEqual([result.importRunId]);
  });

  it("importing again updates what changed, adds nothing twice and respects a person's edits", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const first = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: WIDE_CSV,
    });
    expect(first.stats.factsCreated).toBe(4);

    const again = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: WIDE_CSV,
    });
    expect(again.stats).toMatchObject({ factsCreated: 0, factsUpdated: 0, factsUnchanged: 4 });
    expect(await factsOf(business)).toHaveLength(4);

    // A person rewords the warranty and archives the financing fact.
    const [warranty, financing] = await Promise.all(
      ["warranties", "financing"].map(async (category) =>
        (await factsOf(business)).find((fact) => fact.category === category),
      ),
    );
    await knowledge.update(agency.admin, business.businessId, warranty!.id, {
      content: "Lifetime workmanship warranty, in writing.",
    });
    await knowledge.archive(agency.admin, business.businessId, financing!.id);

    const changed = WIDE_CSV.replace("storm inspections", "storm inspections and gutters").replace(
      "10-year workmanship warranty",
      "5-year workmanship warranty",
    );
    const third = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: changed,
    });
    expect(third.stats).toMatchObject({
      factsCreated: 0,
      factsUpdated: 1,
      factsUnchanged: 1,
      factsKept: 2,
    });
    const facts = await factsOf(business, "all");
    const by = (category: string) => facts.find((fact) => fact.category === category)!;
    expect(by("services").content).toContain("and gutters");
    // The person's wording wins over the file, and their archive is not undone.
    expect(by("warranties").content).toBe("Lifetime workmanship warranty, in writing.");
    expect(by("warranties").metadata).toMatchObject({ handEdited: true });
    expect(by("financing").status).toBe("archived");
    expect(facts).toHaveLength(4);
  });

  it('"replace" archives imported facts the new file no longer has, and nothing else', async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    await knowledge.importCsv(agency.member, { businessId: business.businessId, csv: WIDE_CSV });
    const manual = await knowledge.create(agency.member, business.businessId, {
      category: "team",
      title: "Owner",
      content: "Family-owned since 1998.",
    });
    const smaller = "Services,Warranty\nRoof repair only,10-year workmanship warranty\n";
    const result = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: smaller,
      mode: "replace",
    });
    expect(result.stats).toMatchObject({ factsUpdated: 1, factsUnchanged: 1, factsArchived: 2 });
    const active = await factsOf(business);
    expect(active.map((fact) => fact.category).sort()).toEqual(["services", "team", "warranties"]);
    expect(active.find((fact) => fact.id === manual.id)?.source).toBe("manual");
    const archived = await factsOf(business, "archived");
    expect(archived.map((fact) => fact.category).sort()).toEqual(["financing", "service_area"]);
    expect(archived.every((fact) => fact.metadata["archivedBy"] === "import")).toBe(true);

    // The data comes back: what the import archived, the import restores.
    const back = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: WIDE_CSV,
    });
    expect(back.stats.factsUpdated).toBe(3);
    expect(await factsOf(business)).toHaveLength(5);
  });

  it("a file that cannot be read is a failed run with the reason, and changes nothing", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const cases: [string, string][] = [
      ["", "The file is empty."],
      ['Services,Notes\nRoofing,"never closed\n', "never closed"],
      ["Services,,Notes\nRoofing,x,y\n", "Column 2 has no name"],
      ["PK\u0003\u0004\u0000zip", "binary data"],
      ["Name,Name\nA,B\n", "Two columns are named"],
      // Readable, but nothing in it is mapped to anything.
      ["Mystery,Zzz\n1,2\n", "nothing to import"],
    ];
    for (const [csv, reason] of cases) {
      const result = await knowledge.importCsv(agency.member, {
        businessId: business.businessId,
        csv,
      });
      expect(result.status, reason).toBe("failed");
      expect(result.problems[0]?.message).toContain(reason);
      expect(result.stats.recordsImported).toBe(0);
    }
    expect(await factsOf(business, "all")).toHaveLength(0);
    const runs = await h.t.admin
      .select({ status: importRuns.status, errors: importRuns.errors })
      .from(importRuns)
      .where(eq(importRuns.businessId, business.businessId));
    expect(runs).toHaveLength(cases.length);
    expect(runs.every((run) => run.status === "failed" && run.errors.length === 1)).toBe(true);
  });

  it("imports the good rows of a file with bad ones and reports each bad row", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const csv = [
      "Category,Title,Text",
      "services,Repairs,Leak repair and flashing.",
      "astrology,Signs,Mercury is in retrograde.",
      "warranties,Workmanship,",
      `faq,Long answer,${"x".repeat(4001)}`,
      "faq,Weekends,We work Saturdays by appointment.",
      "services,Repairs,A different text under the same title.",
      "hours,,Monday to Friday 7am to 5pm.",
    ].join("\n");
    const result = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv,
    });
    expect(result.status).toBe("partial");
    expect(result.stats).toMatchObject({
      records: 7,
      recordsImported: 3,
      recordsFailed: 4,
      factsCreated: 3,
    });
    expect(result.problems.map((problem) => problem.row)).toEqual([3, 4, 5, 7]);
    expect(result.problems[3]?.message).toContain("same category and title as row 2");
    const facts = await factsOf(business);
    expect(facts.map((fact) => fact.title)).toEqual(["Weekends", "", "Repairs"]);
    expect(facts.find((fact) => fact.title === "Repairs")?.content).toBe(
      "Leak repair and flashing.",
    );
    const [run] = await h.t.admin
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, result.importRunId));
    expect(run?.status).toBe("partial");
    expect(run?.errors).toHaveLength(4);
    expect(JSON.stringify(run?.errors)).not.toContain("Mercury");
  });

  it("imports a file for the whole agency by each business's reference", async () => {
    const agency = await h.newAgency();
    const other = await h.newAgency();
    const a = await agency.newBusiness({ externalRef: "crm-1" });
    const b = await agency.newBusiness({ externalRef: "crm-2" });
    const foreign = await other.newBusiness({ externalRef: "crm-9" });
    const csv = [
      "Ref,Services,Hours",
      "crm-1,Roof repair,Weekdays 7 to 5",
      "crm-2,Furnace repair,",
      "crm-9,Belongs to another agency,",
      "crm-404,Nobody,",
      ",No reference,",
    ].join("\n");
    const result = await knowledge.importAgencyCsv(agency.admin, {
      agencyId: agency.agencyId,
      csv,
    });
    expect(result.status).toBe("partial");
    expect(result.stats).toMatchObject({
      recordsImported: 2,
      recordsFailed: 3,
      businesses: 2,
      factsCreated: 3,
    });
    expect(result.problems.map((problem) => [problem.row, problem.message.slice(0, 31)])).toEqual([
      [4, "No business has this reference."],
      [5, "No business has this reference."],
      [6, "The row does not say which busi"],
    ]);
    expect((await factsOf(a)).map((fact) => fact.content).sort()).toEqual([
      "Roof repair",
      "Weekdays 7 to 5",
    ]);
    expect((await factsOf(b)).map((fact) => fact.content)).toEqual(["Furnace repair"]);
    expect(await factsOf(foreign)).toHaveLength(0);
    const [run] = await h.t.admin
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, result.importRunId));
    expect(run).toMatchObject({ businessId: null, agencyId: agency.agencyId });
    // Without a reference column the file cannot say which business a row is for.
    const noRef = await knowledge.importAgencyCsv(agency.admin, {
      agencyId: agency.agencyId,
      csv: "Services\nRoofing\n",
    });
    expect(noRef.status).toBe("failed");
    expect(noRef.problems[0]?.message).toContain("reference");
  });

  it("stops at the most facts a business can hold", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const lines = Array.from(
      { length: MAX_ACTIVE_FACTS + 5 },
      (_, index) => `faq,Question ${index + 1},Answer ${index + 1}.`,
    );
    const result = await knowledge.importCsv(agency.member, {
      businessId: business.businessId,
      csv: ["Category,Title,Text", ...lines].join("\n"),
    });
    expect(result.status).toBe("partial");
    expect(result.stats.factsCreated).toBe(MAX_ACTIVE_FACTS);
    expect(result.stats.recordsFailed).toBe(5);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toContain(`${MAX_ACTIVE_FACTS} active facts`);
    await expect(
      knowledge.create(agency.member, business.businessId, {
        category: "faq",
        content: "One more.",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("is for agency staff: client users read the facts and change nothing", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    await h.t.admin
      .update(businesses)
      .set({ clientPortalEnabled: true })
      .where(eq(businesses.id, business.businessId));
    const owner = await h.t.db.localAuth.upsertUser({
      email: `owner-${business.businessId}@client.test`,
    });
    await h.t.admin
      .insert(businessMemberships)
      .values({ ...business, userId: owner.id, role: "client_owner" });
    await knowledge.importCsv(agency.member, { businessId: business.businessId, csv: WIDE_CSV });

    const seen = await knowledge.list({ id: owner.id }, business.businessId);
    expect(seen).toHaveLength(4);
    expect(seen.every((fact) => !fact.stale)).toBe(true);
    await expect(
      knowledge.importCsv({ id: owner.id }, { businessId: business.businessId, csv: WIDE_CSV }),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
    await expect(
      knowledge.create({ id: owner.id }, business.businessId, { category: "faq", content: "Hi" }),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
    await expect(knowledge.list(agency.outsider, business.businessId)).rejects.toMatchObject({
      code: "not_found",
    });
    const other = await h.newAgency();
    await expect(
      knowledge.importCsv(other.admin, { businessId: business.businessId, csv: WIDE_CSV }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      knowledge.importAgencyCsv(other.admin, { agencyId: agency.agencyId, csv: WIDE_CSV }),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
  });
});

describe("knowledge items in the editor", () => {
  it("lists facts with source and last-updated time, flags stale ones, and edits them", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const created = await knowledge.create(agency.member, business.businessId, {
      category: "licenses",
      title: "  License\tand insurance ",
      content: "Licensed roofing contractor in Colorado.\u0007\r\n\r\n\r\nFully insured.",
      pinned: true,
    });
    expect(created).toMatchObject({
      category: "licenses",
      title: "License and insurance",
      content: "Licensed roofing contractor in Colorado.\n\nFully insured.",
      source: "manual",
      pinned: true,
      status: "active",
      handEdited: false,
      updatedBy: agency.member.id,
    });
    expect(Date.parse(created.updatedAt)).not.toBeNaN();
    await knowledge.create(agency.member, business.businessId, {
      category: "services",
      content: "Roof repair.",
    });

    // By category in the product's order (services before licenses), then position.
    const listed = await knowledge.list(agency.member, business.businessId);
    expect(listed.map((fact) => fact.category)).toEqual(["services", "licenses"]);

    // A fact nobody confirmed for longer than the setting allows is flagged, not hidden.
    await h.t.admin
      .update(knowledgeItems)
      .set({ updatedAt: new Date(h.now.getTime() - 400 * 86_400_000) })
      .where(eq(knowledgeItems.id, created.id));
    const stale = await knowledge.list(agency.member, business.businessId);
    expect(stale.find((fact) => fact.id === created.id)?.stale).toBe(true);
    expect(stale.find((fact) => fact.id !== created.id)?.stale).toBe(false);
    const confirmed = await knowledge.confirm(agency.admin, business.businessId, created.id);
    expect(confirmed.content).toBe(created.content);
    expect(
      (await knowledge.list(agency.member, business.businessId)).some((fact) => fact.stale),
    ).toBe(false);
    // "Never flag" is a setting.
    await h.t.db.forBusiness(business.businessId).run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "business", ...business },
        changes: [{ key: "knowledge.stale_after_days", value: null }],
        actor: { type: "system", label: "test" },
      }),
    );

    const updated = await knowledge.update(agency.admin, business.businessId, created.id, {
      content: "Licensed and insured in Colorado.",
      pinned: false,
    });
    expect(updated).toMatchObject({ content: "Licensed and insured in Colorado.", pinned: false });
    // A hand-written fact has no import to be protected from.
    expect(updated.handEdited).toBe(false);
    await expect(
      knowledge.update(agency.admin, business.businessId, created.id, { content: "   " }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      knowledge.create(agency.admin, business.businessId, { category: "nonsense", content: "x" }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    await knowledge.archive(agency.admin, business.businessId, created.id);
    expect(await knowledge.list(agency.member, business.businessId)).toHaveLength(1);
    expect(
      await knowledge.list(agency.member, business.businessId, { status: "all" }),
    ).toHaveLength(2);
    await knowledge.restore(agency.admin, business.businessId, created.id);
    await knowledge.remove(agency.admin, business.businessId, created.id);
    expect(
      await knowledge.list(agency.member, business.businessId, { status: "all" }),
    ).toHaveLength(1);
    await expect(
      knowledge.update(agency.admin, business.businessId, created.id, { content: "gone" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the import API", () => {
  it("refuses requests without a usable key, and keys without the scope", async () => {
    const agency = await h.newAgency();
    const created = await agencyKey(agency);
    expect(created.key).toMatch(/^hsrb_[0-9a-f]{8}_/);
    // Only the hash is stored.
    const [stored] = await h.t.admin.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(JSON.stringify(stored)).not.toContain(created.key);

    const missing = await handleImportRequest(post("/api/v1/knowledge/import", {}), api());
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    for (const key of [
      "nonsense",
      `${created.key}x`,
      `${created.key.slice(0, -1)}${created.key.endsWith("A") ? "E" : "A"}`,
    ]) {
      const response = await handleImportRequest(post("/api/v1/knowledge/import", { key }), api());
      expect(response.status).toBe(401);
      expect((await body(response))["error"]).toMatchObject({ code: "unauthorized" });
    }

    const readOnly = await keys.create(agency.admin, agency.agencyId, {
      name: "Read only",
      scopes: ["knowledge:read"],
    });
    const forbidden = await handleImportRequest(
      post("/api/v1/knowledge/import", { key: readOnly.key }),
      api(),
    );
    expect(forbidden.status).toBe(403);

    await keys.revoke(agency.admin, agency.agencyId, created.id);
    const revoked = await handleImportRequest(
      post("/api/v1/knowledge/import", { key: created.key }),
      api(),
    );
    expect(revoked.status).toBe(401);
    const listed = await keys.list(agency.admin, agency.agencyId);
    expect(listed.find((key) => key.id === created.id)?.revokedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(created.key);

    // Keys are an admin's business.
    await expect(
      keys.create(agency.member, agency.agencyId, { name: "Nope" }),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
    const expired = await keys.create(agency.admin, agency.agencyId, {
      name: "Old",
      expiresAt: new Date(h.now.getTime() - 1000).toISOString(),
    });
    expect(
      (await handleImportRequest(post("/api/v1/knowledge/import", { key: expired.key }), api()))
        .status,
    ).toBe(401);
  });

  it("imports JSON records for businesses of the key's agency", async () => {
    const agency = await h.newAgency();
    const a = await agency.newBusiness({ externalRef: "crm-1", state: null });
    const b = await agency.newBusiness();
    const { key } = await agencyKey(agency);
    const response = await handleImportRequest(
      post("/api/v1/knowledge/import", {
        key,
        body: JSON.stringify({
          businesses: [
            {
              externalRef: "crm-1",
              profile: { phone: "303-555-0199", state: "co" },
              facts: [
                {
                  category: "services",
                  title: "Services",
                  content: "Roof repair and replacement.",
                },
                {
                  category: "reviews",
                  title: "Google rating",
                  content: "4.8 stars from 212 reviews.",
                },
              ],
            },
            { id: b.businessId, facts: [{ category: "hours", content: "Open 24 hours." }] },
          ],
        }),
      }),
      api(),
    );
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({
      status: "succeeded",
      problems: [],
      stats: {
        records: 2,
        recordsImported: 2,
        businesses: 2,
        factsCreated: 3,
        profileFieldsSet: 2,
      },
    });
    expect((await factsOf(a)).map((fact) => [fact.source, fact.title])).toEqual([
      ["api", "Google rating"],
      ["api", "Services"],
    ]);
    expect(await profileOf(a)).toMatchObject({ phone: "303-555-0199", state: "CO" });
    expect((await factsOf(b))[0]).toMatchObject({ content: "Open 24 hours.", updatedBy: null });
    const [run] = await h.t.admin
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, result["importRunId"] as string));
    expect(run).toMatchObject({ kind: "api", status: "succeeded", businessId: null });
    const [audit] = await h.t.admin
      .select({ actorType: auditLog.actorType, label: auditLog.actorLabel })
      .from(auditLog)
      .where(and(eq(auditLog.agencyId, agency.agencyId), eq(auditLog.action, "knowledge.import")));
    expect(audit).toEqual({ actorType: "api_key", label: "Lead-gen sync" });

    // The run can be read back with the same key.
    const status = await handleImportStatusRequest(
      new Request(`https://app.test/api/v1/knowledge/imports/${run!.id}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      run!.id,
      api(),
    );
    expect(status.status).toBe(200);
    expect(await body(status)).toMatchObject({
      importRunId: run!.id,
      kind: "api",
      status: "succeeded",
    });
  });

  it("answers malformed requests with what is wrong, and imports what is right", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness({ externalRef: "crm-1" });
    const { key } = await agencyKey(agency);
    const send = (init: { body?: string; headers?: Record<string, string> }) =>
      handleImportRequest(post("/api/v1/knowledge/import", { key, ...init }), api());

    const notJson = await send({ body: "{ not json" });
    expect(notJson.status).toBe(400);
    expect((await body(notJson))["error"]).toMatchObject({ code: "invalid_json" });

    expect(
      (await send({ body: "<xml/>", headers: { "content-type": "application/xml" } })).status,
    ).toBe(415);

    for (const bad of [
      {},
      { businesses: [] },
      { businesses: "all" },
      { businesses: [{}], mode: "wipe" },
      [1],
    ]) {
      const response = await send({ body: JSON.stringify(bad) });
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect((await body(response))["error"]).toMatchObject({ code: "invalid_request" });
    }

    const tooLarge = await send({ body: JSON.stringify({ pad: "x".repeat(MAX_JSON_BYTES) }) });
    expect(tooLarge.status).toBe(413);

    // Some records are fine, some are not: the fine ones import.
    const mixed = await send({
      body: JSON.stringify({
        businesses: [
          { externalRef: "crm-1", facts: [{ category: "services", content: "Roofing." }] },
          { externalRef: "crm-1", facts: [{ category: "astrology", content: "Leo." }] },
          { externalRef: "crm-1", facts: [{ category: "faq", content: "" }] },
          { externalRef: "crm-1", facts: [{ category: "faq", content: "x", extra: true }] },
          { externalRef: "crm-1", profile: { email: "nope" } },
          { facts: [{ category: "faq", content: "For whom?" }] },
          { externalRef: "crm-404", facts: [{ category: "faq", content: "Nobody." }] },
          { externalRef: "crm-1" },
          "not an object",
        ],
      }),
    });
    expect(mixed.status).toBe(200);
    const result = await body(mixed);
    expect(result).toMatchObject({
      status: "partial",
      stats: { records: 9, recordsImported: 1, recordsFailed: 8, factsCreated: 1 },
    });
    const problems = result["problems"] as {
      row: number;
      column: string | null;
      message: string;
    }[];
    expect(problems.map((problem) => problem.row)).toEqual([2, 3, 4, 5, 6, 8, 9, 7]);
    expect(problems.find((problem) => problem.row === 2)?.column).toBe("facts[0].category");
    expect(problems.find((problem) => problem.row === 5)?.column).toBe("profile.email");
    expect(problems.find((problem) => problem.row === 6)?.message).toContain(
      '"id" or "externalRef"',
    );
    expect(await factsOf(business)).toHaveLength(1);

    // Nothing importable at all: 422, with the same body shape.
    const nothing = await send({
      body: JSON.stringify({
        businesses: [{ externalRef: "crm-404", facts: [{ category: "faq", content: "x" }] }],
      }),
    });
    expect(nothing.status).toBe(422);
    expect(await body(nothing)).toMatchObject({ status: "failed" });
  });

  it("keeps a key inside its tenant: its own agency, and its own business when it has one", async () => {
    const agency = await h.newAgency();
    const mine = await agency.newBusiness({ externalRef: "mine" });
    const sibling = await agency.newBusiness({ externalRef: "sibling" });
    const other = await h.newAgency();
    const foreign = await other.newBusiness({ externalRef: "mine" });
    const bound = await agencyKey(agency, mine.businessId);
    const wide = await agencyKey(agency);
    const fact = [{ category: "faq", content: "Written through the API." }];
    const send = (key: string, businessesBody: unknown[]) =>
      handleImportRequest(
        post("/api/v1/knowledge/import", {
          key,
          body: JSON.stringify({ businesses: businessesBody }),
        }),
        api(),
      );

    // A key bound to one business writes that business, named or not, and no other.
    const own = await send(bound.key, [
      { facts: fact },
      { id: sibling.businessId, facts: fact },
      { externalRef: "sibling", facts: fact },
    ]);
    expect(await body(own)).toMatchObject({ stats: { recordsImported: 1, recordsFailed: 2 } });
    expect(await factsOf(mine)).toHaveLength(1);
    expect(await factsOf(sibling)).toHaveLength(0);

    // An agency key reaches its agency's businesses and nobody else's, whatever id it names.
    const crossed = await send(wide.key, [
      { id: foreign.businessId, facts: [{ category: "faq", content: "Crossed over." }] },
      { externalRef: "mine", facts: [{ category: "hours", content: "By reference." }] },
    ]);
    expect(await body(crossed)).toMatchObject({ stats: { recordsImported: 1, recordsFailed: 1 } });
    expect(await factsOf(foreign)).toHaveLength(0);
    expect((await factsOf(mine)).map((item) => item.category).sort()).toEqual(["faq", "hours"]);

    // The same for CSV: naming another tenant's business is refused.
    const csvFor = (key: string, query: string) =>
      handleCsvImportRequest(
        new Request(`https://app.test/api/v1/knowledge/import/csv?${query}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "text/csv" },
          body: "Services\nThrough CSV\n",
        }),
        api(),
      );
    expect((await csvFor(bound.key, `business_id=${sibling.businessId}`)).status).toBe(403);
    expect((await csvFor(wide.key, `business_id=${foreign.businessId}`)).status).toBe(403);
    expect((await csvFor(wide.key, "external_ref=nobody")).status).toBe(404);
    expect((await csvFor(wide.key, "business_id=not-an-id")).status).toBe(400);
    expect(await factsOf(foreign)).toHaveLength(0);

    // And an import run of another tenant is invisible.
    const foreignKey = await agencyKey(other);
    const [run] = await h.t.admin
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(eq(importRuns.agencyId, agency.agencyId))
      .limit(1);
    const peek = await handleImportStatusRequest(
      new Request(`https://app.test/api/v1/knowledge/imports/${run!.id}`, {
        headers: { authorization: `Bearer ${foreignKey.key}` },
      }),
      run!.id,
      api(),
    );
    expect(peek.status).toBe(404);
  });

  it("imports CSV sent as text or as a form upload, with a mapping", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness({ externalRef: "crm-5" });
    const { key } = await agencyKey(agency);

    const asText = await handleCsvImportRequest(
      new Request(
        `https://app.test/api/v1/knowledge/import/csv?external_ref=crm-5&file_name=leads.csv&mapping=${encodeURIComponent(
          JSON.stringify({
            "What they do": { to: "fact", category: "services", title: "Services" },
          }),
        )}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "text/csv; charset=utf-8" },
          body: "What they do,Internal\nRoof repair,ignore me\n",
        },
      ),
      api(),
    );
    expect(asText.status).toBe(200);
    expect(await body(asText)).toMatchObject({
      status: "succeeded",
      stats: { factsCreated: 1 },
      mapping: { "What they do": { to: "fact", category: "services", title: "Services" } },
    });
    expect((await factsOf(business))[0]).toMatchObject({ title: "Services", source: "csv_import" });

    const form = new FormData();
    form.set(
      "file",
      new File([WIDE_CSV.replace("crm-77", "crm-5")], "summit.csv", { type: "text/csv" }),
    );
    form.set("business_id", business.businessId);
    form.set("mode", "replace");
    const upload = new Request("https://app.test/api/v1/knowledge/import/csv", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    // A real client sends the length; build it from the encoded body.
    const encoded = await upload.clone().arrayBuffer();
    const asForm = await handleCsvImportRequest(
      new Request(upload.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": upload.headers.get("content-type") ?? "",
          "content-length": String(encoded.byteLength),
        },
        body: encoded,
      }),
      api(),
    );
    expect(asForm.status).toBe(200);
    expect(await body(asForm)).toMatchObject({ status: "succeeded", stats: { factsCreated: 3 } });
    const [run] = await h.t.admin
      .select({ fileName: importRuns.fileName })
      .from(importRuns)
      .where(
        and(eq(importRuns.businessId, business.businessId), eq(importRuns.fileName, "summit.csv")),
      );
    expect(run).toBeDefined();

    // Malformed in every way a request can be.
    const bad = (query: string, init: RequestInit) =>
      handleCsvImportRequest(
        new Request(`https://app.test/api/v1/knowledge/import/csv?${query}`, {
          method: "POST",
          ...init,
          headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string>) },
        }),
        api(),
      );
    const text = { "content-type": "text/csv" };
    expect(
      (
        await bad("business_id=" + business.businessId, {
          headers: { "content-type": "image/png" },
          body: "x",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await bad(`business_id=${business.businessId}&mode=wipe`, {
          headers: text,
          body: "Services\nx\n",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await bad(`business_id=${business.businessId}&mapping=%7Bnope`, {
          headers: text,
          body: "Services\nx\n",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await bad(
          `business_id=${business.businessId}&mapping=${encodeURIComponent('{"Services":{"to":"moon"}}')}`,
          { headers: text, body: "Services\nx\n" },
        )
      ).status,
    ).toBe(400);
    const unreadable = await bad(`business_id=${business.businessId}`, {
      headers: text,
      body: 'Services\n"open\n',
    });
    expect(unreadable.status).toBe(422);
    expect(await body(unreadable)).toMatchObject({ status: "failed" });
    const empty = await bad(`business_id=${business.businessId}`, { headers: text, body: "" });
    expect(empty.status).toBe(422);
  });
});
