import { describe, expect, it } from "vitest";

import { moneyAmounts } from "@repo/ai";
import { CHANNEL_CAPABILITIES } from "@repo/core";
import { completenessIssues, parsePlaybookDocument } from "@repo/knowledge";
import { assessLead } from "@repo/leads";

import { EVAL_BUSINESSES, EVAL_SEGMENTS } from "../fixtures/businesses";
import { evalPlaybook } from "../fixtures/playbooks";
import { allScenarios, selectScenarios } from "./matrix";
import { fieldsFromTruth } from "./oracle";
import { PERSONAS } from "./personas";
import { type SETTINGS_PROFILES } from "./profiles";
import { EVAL_CHANNELS, PERSONA_IDS, PROFILE_IDS } from "./types";

const scenarios = allScenarios();
const by = (persona: string, pick?: (id: string) => boolean) =>
  scenarios.filter(
    (scenario) => scenario.persona.id === persona && (pick?.(scenario.profile.id) ?? true),
  );

describe("the scenario matrix", () => {
  it("has every persona of the spec at every trade: 12 × 6 scenarios in six suites", () => {
    expect(PERSONA_IDS).toHaveLength(12);
    expect(EVAL_SEGMENTS).toHaveLength(6);
    expect(scenarios).toHaveLength(72);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(72);
    for (const segment of EVAL_SEGMENTS) {
      const suite = scenarios.filter((scenario) => scenario.suite === segment);
      expect(suite.map((scenario) => scenario.persona.id).sort()).toEqual([...PERSONA_IDS].sort());
    }
  });

  it("puts every persona under every settings profile somewhere, and uses every channel", () => {
    for (const personaId of PERSONA_IDS) {
      const profiles = new Set(by(personaId).map((scenario) => scenario.profile.id));
      expect([...profiles].sort(), personaId).toEqual([...PROFILE_IDS].sort());
    }
    expect(new Set(scenarios.map((scenario) => scenario.channel))).toEqual(new Set(EVAL_CHANNELS));
    for (const scenario of scenarios) {
      const allowed = scenario.persona.channels;
      if (allowed !== undefined) expect(allowed, scenario.id).toContain(scenario.channel);
    }
  });

  it("is the same on every build: the rotation has no randomness", () => {
    const again = allScenarios().map(
      (scenario) => `${scenario.id}|${scenario.profile.id}|${scenario.channel}`,
    );
    expect(again).toEqual(
      scenarios.map((scenario) => `${scenario.id}|${scenario.profile.id}|${scenario.channel}`),
    );
    expect(scenarios[0]).toMatchObject({ id: "roofing.ready_to_book", channel: "whatsapp" });
    expect(scenarios[0]?.profile.id).toBe("default");
  });

  it("has a core selection of 24: two trades per persona, four personas per trade", () => {
    const core = selectScenarios({ core: true });
    expect(core).toHaveLength(24);
    for (const personaId of PERSONA_IDS) {
      expect(core.filter((scenario) => scenario.persona.id === personaId)).toHaveLength(2);
    }
    for (const segment of EVAL_SEGMENTS) {
      expect(core.filter((scenario) => scenario.suite === segment)).toHaveLength(4);
    }
  });

  it("selects by suite, persona, profile and id, and refuses a name it does not know", () => {
    expect(selectScenarios({ suites: ["hvac"] })).toHaveLength(12);
    expect(selectScenarios({ personas: ["spam", "renter"] })).toHaveLength(12);
    expect(
      selectScenarios({ scenarios: ["plumbing.emergency"] }).map((scenario) => scenario.id),
    ).toEqual(["plumbing.emergency"]);
    expect(selectScenarios({ suites: ["hvac"], limit: 3 })).toHaveLength(3);
    expect(() => selectScenarios({ suites: ["hvca"] })).toThrow(/Unknown suite: hvca/);
    expect(() => selectScenarios({ personas: ["nobody"] })).toThrow(/Unknown persona/);
    expect(() => selectScenarios({ scenarios: ["roofing.nobody"] })).toThrow(/Unknown scenario/);
  });

  it("starts conversations in office hours, and emergencies when they happen", () => {
    for (const scenario of scenarios) {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: scenario.business.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        weekday: "short",
      }).format(new Date(scenario.startAt));
      if (scenario.persona.id === "emergency") {
        expect(local, scenario.id).toContain(scenario.business.cases.emergency.at);
      } else {
        expect(local, scenario.id).toBe("Tue 10:15");
      }
    }
  });
});

describe("settings profiles", () => {
  it("resolve without a refused value for every business", () => {
    // `scenarioSettings` throws on a value the registry refuses; building the matrix ran it.
    for (const scenario of scenarios) expect(scenario.settings.issues).toEqual([]);
  });

  it("move the settings the rubric names: pricing, disclosure, persona, length", () => {
    const value = (profile: keyof typeof SETTINGS_PROFILES, key: string) =>
      (
        scenarios.find((scenario) => scenario.profile.id === profile)?.settings.values as Record<
          string,
          unknown
        >
      )[key];
    expect(new Set(PROFILE_IDS.map((id) => value(id, "pricing.disclosure")))).toEqual(
      new Set(["never", "ranges", "exact"]),
    );
    expect(new Set(PROFILE_IDS.map((id) => value(id, "persona.ai_disclosure")))).toEqual(
      new Set(["upfront", "when_asked"]),
    );
    expect(new Set(PROFILE_IDS.map((id) => value(id, "persona.bot_name"))).size).toBe(5);
    expect(value("contact_only", "voice.max_reply_characters.whatsapp")).toBe(320);
    expect(value("contact_only", "routing.mode")).toBe("always_contact_later");
    expect(value("strict", "routing.cold_outcome")).toBe("disqualify");
    expect(value("booking_with_ranges", "routing.warm_outcome")).toBe("book_meeting");
  });

  it("layer the trade's preset and the business's own values under the profile", () => {
    const roofing = scenarios.find((scenario) => scenario.id === "roofing.ready_to_book");
    expect(roofing?.settings.values["qualification.insurance_claim.enabled"]).toBe(true);
    expect(roofing?.settings.sources["qualification.insurance_claim.enabled"]?.scope).toBe(
      "segment",
    );
    expect(roofing?.settings.values["qualification.service_area.zip_codes"]).toContain("80226");
    expect(roofing?.settings.sources["qualification.service_area.zip_codes"]?.scope).toBe(
      "business",
    );
    const pest = scenarios.find((scenario) => scenario.suite === "pest_control");
    const classes = pest?.settings.values["emergency.classes"].map((item) => item.key) ?? [];
    expect(classes).toContain("stinging_insects");
    expect(classes).toContain("gas_leak");
  });
});

describe("the routing oracle", () => {
  it("expects exactly what the business's rules give, for the customers whose outcome is fixed", () => {
    for (const scenario of by("ready_to_book")) {
      const expected =
        scenario.settings.values["routing.mode"] === "always_contact_later"
          ? "contact_later"
          : "book_meeting";
      expect(scenario.expect.routing, scenario.id).toEqual([expected]);
    }
    for (const scenario of [...by("out_of_area"), ...by("spam")]) {
      expect(scenario.expect.routing, scenario.id).toEqual(["disqualify"]);
    }
    // A renter is never booked, whatever the band: the decision-maker rule holds them back.
    for (const scenario of by("renter")) {
      expect(scenario.expect.routing, scenario.id).toEqual(["contact_later"]);
      expect(scenario.expect.mustNotBook).toBe(true);
    }
    for (const scenario of [...by("emergency"), ...by("angry_past_job")]) {
      expect(scenario.expect.routing, scenario.id).toBeUndefined();
    }
  });

  it("never expects a booking where every lead is told the team will be in touch", () => {
    for (const scenario of scenarios.filter((item) => item.profile.id === "contact_only")) {
      expect(scenario.expect.routing ?? [], scenario.id).not.toContain("book_meeting");
    }
  });

  it("is the production assessment: the reference record of a scenario gets the expected outcome", () => {
    // The oracle of the eval set: a bot that records the customer's true facts must pass.
    for (const scenario of scenarios) {
      const expected = scenario.expect.routing;
      if (expected === undefined || scenario.expect.spam) continue;
      const fields = fieldsFromTruth(
        scenario.instance.truth,
        scenario.instance.revealed,
        scenario.startAt,
      );
      const outcome =
        assessLead({
          settings: scenario.settings,
          facts: { fields, status: "new" },
          now: scenario.startAt,
        }).decision?.outcome ?? null;
      expect(expected, scenario.id).toContain(outcome);
    }
  });

  it("puts the out-of-area customer outside and everyone else inside the service area", () => {
    for (const scenario of scenarios) {
      const zips = scenario.settings.values["qualification.service_area.zip_codes"];
      const inside = zips.includes(scenario.instance.truth.zip);
      expect(inside, scenario.id).toBe(scenario.persona.id !== "out_of_area");
    }
  });
});

describe("personas", () => {
  it("fix every attack line in the scenario instead of asking a model for one", () => {
    for (const scenario of by("spam")) {
      expect(scenario.instance.fullyScripted).toBe(true);
      expect(scenario.instance.beats.map((beat) => beat.turn)).toEqual([2, 3]);
    }
    for (const scenario of by("prompt_injection")) {
      expect(scenario.instance.beats.map((beat) => beat.turn)).toEqual([2, 3, 4]);
      expect(scenario.instance.beats[1]?.messages[0]).toContain(scenario.business.name);
      expect(scenario.expect.forbiddenInReplies.length).toBeGreaterThan(0);
    }
  });

  it("give the emergency customer a class the business has, and the angry one a handoff", () => {
    for (const scenario of by("emergency")) {
      const classes = scenario.settings.values["emergency.classes"].map((item) => item.key);
      expect(scenario.expect.emergencyClasses?.length).toBeGreaterThan(0);
      for (const key of scenario.expect.emergencyClasses ?? [])
        expect(classes, scenario.id).toContain(key);
      expect(CHANNEL_CAPABILITIES[scenario.channel].format).toBe("chat");
    }
    for (const scenario of by("angry_past_job")) expect(scenario.expect.handoff).toBe("required");
    expect(Object.keys(PERSONAS).sort()).toEqual([...PERSONA_IDS].sort());
  });
});

describe("the evaluation businesses", () => {
  it("keep prices in the pricing and policy facts, so 'never disclose' has something to hide", () => {
    for (const segment of EVAL_SEGMENTS) {
      const business = EVAL_BUSINESSES[segment];
      const priced = business.facts.filter(
        (item) => moneyAmounts(`${item.title} ${item.content}`).length > 0,
      );
      expect(priced.length, segment).toBeGreaterThan(0);
      for (const item of priced) {
        expect(["pricing", "policies", "financing"], `${segment}: ${item.key}`).toContain(
          item.category,
        );
      }
      expect(business.notInKnowledge.length, segment).toBeGreaterThanOrEqual(3);
      expect(new Set(business.facts.map((item) => item.key)).size).toBe(business.facts.length);
    }
  });

  it("have a playbook that passes the product's own checks", () => {
    for (const segment of EVAL_SEGMENTS) {
      const playbook = evalPlaybook(segment, EVAL_BUSINESSES[segment].segmentSlug);
      const parsed = parsePlaybookDocument(playbook.document);
      expect(parsed.ok, segment).toBe(true);
      if (playbook.origin === "import" && parsed.ok) {
        expect(completenessIssues(parsed.document), segment).toEqual([]);
        expect(parsed.document.priceNorms.length).toBeGreaterThan(0);
      }
    }
  });
});
