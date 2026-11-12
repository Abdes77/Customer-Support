import { describe, expect, it } from "vitest";

import type { LeadSnapshot } from "@repo/core";
import { settingsWith } from "@repo/settings";

import { leadFieldCatalogue, normalizeLeadValue, openFields } from "./lead-fields";

const defaults = settingsWith({}).values;

function lead(fields: Record<string, { value: unknown; confidence?: number }>): LeadSnapshot {
  return {
    id: null,
    status: "qualifying",
    routing: null,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        {
          key,
          value: field.value as never,
          confidence: field.confidence ?? 1,
          evidence: null,
          updatedAt: "2026-11-10T17:00:00.000Z",
        },
      ]),
    ),
  };
}

describe("leadFieldCatalogue", () => {
  it("lists the enabled criteria with their weights, their details, contact details and signals", () => {
    const catalogue = leadFieldCatalogue(defaults);
    const byKey = new Map(catalogue.map((field) => [field.key, field]));
    expect(byKey.get("service_type")).toMatchObject({ required: true, weight: 20, ask: true });
    expect(byKey.get("timeline")).toMatchObject({ type: "choice", required: true });
    expect(byKey.get("timeline")?.options).toContain("this_week");
    // Disabled by default.
    expect(byKey.has("insurance_claim")).toBe(false);
    expect(byKey.has("financing")).toBe(false);
    // Budget is recorded when it comes up, not asked, with the default ask mode.
    expect(byKey.get("budget")).toMatchObject({ ask: false });
    expect(byKey.get("budget")?.options).toEqual([
      "under_1k",
      "up_to_5k",
      "up_to_15k",
      "up_to_50k",
      "over_50k",
    ]);
    expect(byKey.get("contact_name")).toMatchObject({ group: "contact", ask: true });
    // The address is needed for an emergency, but not asked for in a normal conversation.
    expect(byKey.get("job_address")).toMatchObject({ group: "contact", ask: false });
    expect(byKey.get("referral")).toMatchObject({ group: "signal", type: "boolean" });
    expect(new Set(catalogue.map((field) => field.key)).size).toBe(catalogue.length);
  });

  it("follows the settings: enabled criteria, claim details, custom criteria", () => {
    const values = settingsWith({
      "qualification.insurance_claim.enabled": true,
      "qualification.insurance_claim.details": ["claim_status", "adjuster_visit"],
      "qualification.photos.enabled": false,
      "qualification.budget.ask_mode": "offer_bands",
      "qualification.custom_criteria": [
        {
          key: "roof_material",
          label: "Roof material",
          question: "What is the roof made of?",
          answer_type: "choice",
          choices: ["shingle", "metal", "tile"],
          ideal_answers: ["shingle"],
          weight: 7,
          required: true,
        },
        {
          // A custom criterion cannot shadow a built-in field.
          key: "timeline",
          label: "Clash",
          question: "x",
          answer_type: "text",
          choices: [],
          ideal_answers: [],
          weight: 1,
          required: false,
        },
      ],
    }).values;
    const byKey = new Map(leadFieldCatalogue(values).map((field) => [field.key, field]));
    expect(byKey.get("insurance_claim")).toMatchObject({ type: "boolean" });
    expect(byKey.get("claim_status")).toMatchObject({ group: "detail" });
    expect(byKey.get("adjuster_visit")).toMatchObject({ type: "boolean" });
    expect(byKey.has("insurer")).toBe(false);
    expect(byKey.has("photos")).toBe(false);
    expect(byKey.get("budget")).toMatchObject({ ask: true });
    expect(byKey.get("roof_material")).toMatchObject({
      group: "custom",
      type: "choice",
      options: ["shingle", "metal", "tile"],
      required: true,
      weight: 7,
    });
    expect(byKey.get("timeline")).toMatchObject({ group: "criterion" });
  });
});

describe("openFields", () => {
  it("puts required criteria first, then the others by weight, then contact details", () => {
    const catalogue = leadFieldCatalogue(defaults);
    const keys = openFields(catalogue, lead({}), defaults).map((field) => field.key);
    expect(keys).toEqual([
      "service_type",
      "job_scope",
      "service_area",
      "timeline",
      "decision_maker",
      "property_type",
      "contact_name",
      "contact_phone",
    ]);
  });

  it("drops what is known with enough confidence and keeps a low-confidence guess open", () => {
    const catalogue = leadFieldCatalogue(defaults);
    const open = openFields(
      catalogue,
      lead({
        service_type: { value: "roof repair" },
        timeline: { value: "this_week", confidence: 0.3 },
        service_area: { value: null },
      }),
      defaults,
    ).map((field) => field.key);
    expect(open).not.toContain("service_type");
    expect(open).toContain("timeline");
    expect(open).toContain("service_area");
  });

  it("asks only for the required criteria at light depth", () => {
    const values = settingsWith({ "qualification.depth": "light" }).values;
    const keys = openFields(leadFieldCatalogue(values), lead({}), values).map((field) => field.key);
    expect(keys).toEqual([
      "service_type",
      "job_scope",
      "service_area",
      "timeline",
      "contact_name",
      "contact_phone",
    ]);
  });
});

describe("normalizeLeadValue", () => {
  const catalogue = new Map(leadFieldCatalogue(defaults).map((field) => [field.key, field]));
  const field = (key: string) => {
    const spec = catalogue.get(key);
    if (spec === undefined) throw new Error(key);
    return spec;
  };

  it("brings a choice into its canonical form and refuses anything else", () => {
    expect(normalizeLeadValue(field("timeline"), "This Week")).toEqual({
      ok: true,
      value: "this_week",
    });
    expect(normalizeLeadValue(field("timeline"), "one-to-three months")).toEqual({
      ok: true,
      value: "one_to_three_months",
    });
    const bad = normalizeLeadValue(field("timeline"), "soonish");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problem).toContain("this_week");
  });

  it("reads yes and no, numbers with symbols, and trims text", () => {
    expect(normalizeLeadValue(field("referral"), "Yes")).toEqual({ ok: true, value: true });
    expect(normalizeLeadValue(field("referral"), false)).toEqual({ ok: true, value: false });
    expect(normalizeLeadValue(field("referral"), "maybe").ok).toBe(false);
    expect(normalizeLeadValue(field("budget_usd"), "$12,500")).toEqual({ ok: true, value: 12_500 });
    expect(normalizeLeadValue(field("budget_usd"), "a lot").ok).toBe(false);
    expect(normalizeLeadValue(field("service_type"), "  roof repair  ")).toEqual({
      ok: true,
      value: "roof repair",
    });
    expect(normalizeLeadValue(field("service_type"), "   ").ok).toBe(false);
  });

  it("accepts null as 'asked, not answered' and refuses objects", () => {
    expect(normalizeLeadValue(field("timeline"), null)).toEqual({ ok: true, value: null });
    expect(normalizeLeadValue(field("service_type"), { nested: true }).ok).toBe(false);
  });
});
