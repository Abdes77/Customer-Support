import { describe, expect, it } from "vitest";

import { EngineAction, type EngineActionType } from "./engine";
import { LeadSnapshot, RoutingDecision } from "./lead";
import { PlaybookDocument } from "./knowledge";
import { isAgencyRole, ROLES } from "./tenancy";

describe("EngineAction", () => {
  const valid: EngineAction[] = [
    {
      type: "update_lead_fields",
      fields: [
        {
          key: "timeline",
          value: "this_week",
          confidence: 0.9,
          evidence: "need it fixed by Friday",
        },
        { key: "is_homeowner", value: true, confidence: 1, evidence: null },
      ],
    },
    { type: "request_photo", subject: "the water heater label" },
    { type: "analyze_photos", attachmentIds: ["att_1"], question: "What brand and how old?" },
    { type: "schedule_follow_up", after: "PT4H", reason: "customer is checking with spouse" },
    { type: "offer_times", preference: "weekday mornings", count: 3 },
    { type: "book_meeting", slotId: "slot_2026-11-12T15:00Z" },
    { type: "escalate_emergency", emergencyClass: "gas_leak", summary: "Smells gas near furnace" },
    { type: "handoff_to_human", reason: "asked for the owner", urgency: "normal" },
    { type: "mark_not_a_fit", reason: "outside the service area" },
    { type: "end_conversation", reason: "customer said goodbye" },
  ];

  it("covers the ten actions from the spec", () => {
    const types = valid.map((action) => action.type).sort();
    const expected: EngineActionType[] = [
      "analyze_photos",
      "book_meeting",
      "end_conversation",
      "escalate_emergency",
      "handoff_to_human",
      "mark_not_a_fit",
      "offer_times",
      "request_photo",
      "schedule_follow_up",
      "update_lead_fields",
    ];
    expect(types).toEqual(expected);
    expect(EngineAction.options).toHaveLength(expected.length);
  });

  it.each(valid.map((action) => [action.type, action] as const))("accepts %s", (_type, action) => {
    expect(EngineAction.parse(action)).toEqual(action);
  });

  it.each([
    ["an unknown action", { type: "send_invoice" }],
    ["a lead update without fields", { type: "update_lead_fields", fields: [] }],
    [
      "a confidence above 1",
      {
        type: "update_lead_fields",
        fields: [{ key: "zip", value: "78701", confidence: 1.5, evidence: null }],
      },
    ],
    ["offering zero times", { type: "offer_times", preference: null, count: 0 }],
    ["an unknown urgency", { type: "handoff_to_human", reason: "x", urgency: "asap" }],
    ["photo analysis without photos", { type: "analyze_photos", attachmentIds: [], question: "?" }],
  ])("rejects %s", (_label, action) => {
    expect(EngineAction.safeParse(action).success).toBe(false);
  });
});

describe("lead contracts", () => {
  const routing = {
    outcome: "book_meeting",
    score: 82,
    band: "hot",
    reasons: ["in service area", "decision maker", "timeline within a week"],
    decidedAt: "2026-11-11T18:30:00.000Z",
    settingsVersion: "sha256:abc",
  } as const;

  it("accepts a routing decision and bounds the score to 0-100", () => {
    expect(RoutingDecision.parse(routing)).toEqual(routing);
    expect(RoutingDecision.safeParse({ ...routing, score: 101 }).success).toBe(false);
    expect(RoutingDecision.safeParse({ ...routing, outcome: "ghost" }).success).toBe(false);
  });

  it("accepts a brand-new lead with nothing known yet", () => {
    const snapshot = { id: null, status: "new", fields: {}, routing: null } as const;
    expect(LeadSnapshot.parse(snapshot)).toEqual(snapshot);
  });
});

describe("PlaybookDocument", () => {
  it("requires every section the spec lists, including sources", () => {
    const complete = {
      commonJobs: [{ name: "Roof replacement", scope: "Tear-off and re-roof" }],
      customerLanguage: [{ phrase: "shingles blew off", meaning: "wind damage" }],
      urgencySignals: [{ signal: "water coming through the ceiling", level: "emergency" }],
      qualificationQuestions: [{ question: "How old is the roof?", why: "repair vs replace" }],
      objections: [{ objection: "Too expensive", response: "Explain financing" }],
      seasonalPatterns: ["Storm season drives emergency calls"],
      priceNorms: [{ job: "Roof replacement", range: "$8,000-$20,000", notes: null }],
      permitsAndRegulations: ["Most cities require a re-roof permit"],
      vocabulary: [{ term: "square", definition: "100 square feet of roofing" }],
      sources: [{ title: "NRCA", url: "https://www.nrca.net/" }],
    };
    expect(PlaybookDocument.parse(complete)).toEqual(complete);
    const { sources: _sources, ...withoutSources } = complete;
    expect(PlaybookDocument.safeParse(withoutSources).success).toBe(false);
  });
});

describe("roles", () => {
  it("splits the four roles into agency and client roles", () => {
    expect(ROLES.filter(isAgencyRole)).toEqual(["agency_admin", "agency_member"]);
    expect(ROLES.filter((role) => !isAgencyRole(role))).toEqual(["client_owner", "client_staff"]);
  });
});
