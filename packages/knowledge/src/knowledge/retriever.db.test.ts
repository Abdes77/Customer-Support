import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KnowledgeFact } from "@repo/core";
import { type BusinessTenant, eq, knowledgeItems } from "@repo/db";

import { createKnowledgeHarness, type KnowledgeHarness } from "../testing/harness";
import { askedCategories, createKnowledgeRetriever, searchTerms } from "./retriever";

/** The retrieval function the conversation engine calls, against PostgreSQL. */

let h: KnowledgeHarness;
let business: BusinessTenant;
let other: BusinessTenant;

type Seed = Partial<typeof knowledgeItems.$inferInsert> & {
  category: (typeof knowledgeItems.$inferInsert)["category"];
  title: string;
  content: string;
};

const FACTS: Seed[] = [
  {
    category: "services",
    title: "Services",
    content: "Roof repair, full replacement and storm inspections.",
  },
  {
    category: "services",
    title: "Metal roofs",
    content: "We install standing-seam metal roofs.",
    position: 1,
  },
  {
    category: "service_area",
    title: "Service area",
    content: "Lakewood, Golden, Arvada and Wheat Ridge.",
  },
  {
    category: "hours",
    title: "Office hours",
    content: "Monday to Friday 7am to 5pm, Saturday 8am to noon.",
  },
  {
    category: "licenses",
    title: "License and insurance",
    content: "Licensed roofing contractor in Colorado, fully insured.",
  },
  {
    category: "warranties",
    title: "Workmanship warranty",
    content: "10-year workmanship warranty on full replacements.",
  },
  {
    category: "financing",
    title: "Payment plans",
    content: "Plans through a lending partner, subject to credit approval.",
  },
  { category: "reviews", title: "Google rating", content: "4.8 stars from 212 reviews." },
  { category: "brands", title: "Shingles", content: "GAF and Owens Corning shingles." },
  { category: "team", title: "Owner", content: "Family-owned since 1998.", isCore: true },
  {
    category: "pricing",
    title: "Inspection fee",
    content: "Inspections are $149, credited toward repairs over $500.",
  },
  {
    category: "faq",
    title: "Skylights",
    content: "We replace skylights during a re-roof.",
    source: "https://summit.example.com/faq",
    position: 0,
  },
  { category: "faq", title: "Gutters", content: "We clean and replace gutters.", position: 1 },
  {
    category: "services",
    title: "Chimney sweeping",
    content: "No longer offered.",
    status: "archived",
  },
];

beforeAll(async () => {
  h = await createKnowledgeHarness();
  const agency = await h.newAgency();
  business = await agency.newBusiness();
  other = await (await h.newAgency()).newBusiness();
  await h.t.admin
    .insert(knowledgeItems)
    .values(FACTS.map((fact) => ({ ...business, source: "manual", ...fact })));
  await h.t.admin.insert(knowledgeItems).values([
    {
      ...other,
      category: "financing",
      title: "Payment plans",
      content: "SECRET financing of another business.",
    },
    {
      ...other,
      category: "services",
      title: "Metal roofs",
      content: "SECRET metal roofs elsewhere.",
    },
  ]);
});

afterAll(async () => {
  await h?.dispose();
});

const retriever = () => createKnowledgeRetriever({ db: h.t.db });
const titles = (facts: readonly KnowledgeFact[]) => facts.map((fact) => fact.title);

describe("coreFacts", () => {
  it("returns every active fact in one stable order, website facts last in their category", async () => {
    const first = await retriever().coreFacts(business.businessId);
    expect(titles(first)).toEqual([
      "Services",
      "Metal roofs",
      "Service area",
      "Office hours",
      "License and insurance",
      "Workmanship warranty",
      "Payment plans",
      "Owner",
      "Shingles",
      "Google rating",
      "Inspection fee",
      // The fact read from the website comes after the hand-written one of its category.
      "Gutters",
      "Skylights",
    ]);
    // Same facts, same order, same bytes: the engine caches the prompt built from them.
    expect(await retriever().coreFacts(business.businessId)).toEqual(first);
    for (const fact of first) expect(KnowledgeFact.safeParse(fact).success).toBe(true);
    expect(first.find((fact) => fact.title === "Owner")?.pinned).toBe(true);
    expect(first.find((fact) => fact.title === "Services")?.pinned).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("Chimney");
    expect(JSON.stringify(first)).not.toContain("SECRET");
  });

  it("changes when the knowledge is edited, and only then", async () => {
    const before = await retriever().coreFacts(business.businessId);
    const [gutters] = await h.t.admin
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.title, "Gutters"));
    await h.t.db
      .forBusiness(business.businessId)
      .run((ctx) =>
        ctx.tx
          .update(knowledgeItems)
          .set({ content: "We clean, repair and replace gutters." })
          .where(eq(knowledgeItems.id, gutters!.id)),
      );
    const after = await retriever().coreFacts(business.businessId);
    expect(titles(after)).toEqual(titles(before));
    expect(after.find((fact) => fact.title === "Gutters")?.content).toContain("repair");
    expect(after.find((fact) => fact.title === "Gutters")?.updatedAt).not.toBe(
      before.find((fact) => fact.title === "Gutters")?.updatedAt,
    );
  });
});

describe("retrieve", () => {
  const find = (text: string, options: { limit?: number; categories?: never[] } = {}) =>
    retriever().retrieve({ businessId: business.businessId, text, ...options });

  it("finds facts by the words of the message, best match first", async () => {
    const found = await find("Do you install metal roofs?");
    expect(found[0]?.title).toBe("Metal roofs");
    expect(titles(found)).not.toContain("Chimney sweeping");
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  it("finds facts by what the message asks about, even when no word matches", async () => {
    // "pay monthly" shares no word with the financing fact.
    expect(titles(await find("can I pay monthly?"))).toEqual(["Payment plans"]);
    expect(titles(await find("are you guys insured"))).toContain("License and insurance");
    expect(titles(await find("is it guaranteed?"))).toEqual(["Workmanship warranty"]);
    expect(titles(await find("how much is an inspection"))).toContain("Inspection fee");
    expect(titles(await find("are you open on saturday"))).toContain("Office hours");
    expect(titles(await find("do you come out to Golden?"))[0]).toBe("Service area");
    expect(titles(await find("who owns the company"))).toContain("Owner");
    expect(titles(await find("what do people say about you, any reviews?"))).toContain(
      "Google rating",
    );
  });

  it("puts a fact with both signals ahead of one with only one", async () => {
    const found = await find("what warranty do you give on a metal roof replacement");
    expect(found[0]?.title).toBe("Workmanship warranty");
    expect(titles(found)).toContain("Metal roofs");
  });

  it("returns nothing for messages with nothing to look up, and honours limit and categories", async () => {
    expect(await find("ok thanks!")).toEqual([]);
    expect(await find("?!")).toEqual([]);
    expect(await find("")).toEqual([]);
    expect(
      await find("gutters skylights roofs warranty financing hours", { limit: 2 }),
    ).toHaveLength(2);
    const onlyFaq = await retriever().retrieve({
      businessId: business.businessId,
      text: "do you finance gutters and skylights",
      categories: ["faq"],
    });
    expect(titles(onlyFaq).sort()).toEqual(["Gutters", "Skylights"]);
  });

  it("prefers imported and hand-written facts over website facts of equal relevance", async () => {
    // Both FAQ facts say "replace" once: equally relevant by their words.
    const found = await find("replace");
    const faq = titles(found).filter((title) => title === "Gutters" || title === "Skylights");
    expect(faq).toEqual(["Gutters", "Skylights"]);
  });

  it("stays inside the business", async () => {
    const elsewhere = await retriever().retrieve({
      businessId: other.businessId,
      text: "metal roofs financing",
    });
    expect(titles(elsewhere).sort()).toEqual(["Metal roofs", "Payment plans"]);
    expect(elsewhere.every((fact) => fact.content.startsWith("SECRET"))).toBe(true);
    await expect(
      retriever().coreFacts("00000000-0000-4000-8000-00000000dead" as never),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("survives text that looks like search syntax", async () => {
    for (const text of ["roof & | ! :* (((", "'; drop table knowledge_items; --", "a:b <-> c"]) {
      await expect(find(text)).resolves.toBeDefined();
    }
    expect(searchTerms("Do you do METAL roofs?! The roofs, please.")).toEqual(["metal", "roofs"]);
    expect(askedCategories("How much? Do you finance?")).toEqual(["financing", "pricing"]);
  });
});
