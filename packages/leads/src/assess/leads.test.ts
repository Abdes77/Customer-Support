import { describe, expect, it } from "vitest";

import {
  type LeadFieldValue,
  type LeadStatus,
  type RoutingOutcome,
  SYSTEM_LEAD_FIELDS,
} from "@repo/core";
import { type AppSettings, settingsWith } from "@repo/settings";

import { buildLeadReport } from "../report/report";
import { assessLead } from "./assess";

/**
 * The acceptance table of C5: 15 leads across six segments, each assessed under three
 * routing configurations. Every score, band, routing outcome, status and the key parts of
 * every report are written out by hand (the arithmetic is in the comments), so a change to the
 * rules shows up as a disagreement here.
 *
 * Default weights: service type 20, job scope 15, service area 15, timeline 15 (all four
 * required), decision-maker 10, budget 10, property type 5, photos 5: 95 in all.
 */

const NOW = "2026-11-12T15:00:00.000Z";

type Config = "defaults" | "always_contact_later" | "strict";

const CONFIGS: Readonly<Record<Config, Partial<AppSettings>>> = {
  // Thresholds 70 / 40; hot → book, warm and cold → contact later; unknown earns 50 %.
  defaults: {},
  always_contact_later: { "routing.mode": "always_contact_later" },
  // A service area by ZIP code in Texas, higher thresholds, cold leads turned away, a budget
  // minimum, insurance work preferred (weight 5, so 100 in all), the decision-maker required,
  // and unknown criteria earn nothing.
  strict: {
    "qualification.service_area.zip_codes": ["78701", "78702", "78703", "78704"],
    "qualification.service_area.states": ["TX"],
    "scoring.thresholds": { hot: 80, warm: 55 },
    "routing.cold_outcome": "disqualify",
    "qualification.budget.minimum_usd": 2000,
    "qualification.budget.below_minimum_action": "disqualify",
    "qualification.insurance_claim.enabled": true,
    "qualification.insurance_claim.preference": "prefer",
    "qualification.decision_maker.required": true,
    "scoring.unknown_credit_percent": 0,
  },
};

interface Expected {
  readonly score: number;
  readonly band: "hot" | "warm" | "cold";
  readonly outcome: RoutingOutcome | null;
  readonly status: LeadStatus;
  readonly disqualifyCode?: string;
  /** Each of these is one of the decision's reasons. */
  readonly reasons?: readonly string[];
  readonly nextStep?: string;
  /** The report's red flags, exactly. */
  readonly redFlags?: readonly string[];
}

interface Case {
  readonly name: string;
  readonly segment: string;
  readonly fields: Record<string, LeadFieldValue>;
  readonly settings?: Partial<AppSettings>;
  readonly photoCount?: number;
  readonly expect: Readonly<Record<Config, Expected>>;
}

function isPair(entry: unknown): entry is [LeadFieldValue["value"], number] {
  return Array.isArray(entry) && entry.length === 2 && typeof entry[1] === "number";
}

function fields(
  entries: Record<string, LeadFieldValue["value"] | [LeadFieldValue["value"], number]>,
): Record<string, LeadFieldValue> {
  const out: Record<string, LeadFieldValue> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const [value, confidence]: [LeadFieldValue["value"], number] = isPair(entry)
      ? entry
      : [entry, 1];
    out[key] = { key, value, confidence, evidence: "As the customer said.", updatedAt: NOW };
  }
  return out;
}

const CONTACT_LATER_STEP = "Contact the customer within one business day, as the bot promised.";
const CALL_TO_BOOK_STEP =
  "Book a visit: online booking is not set up, so call the customer to agree a time.";
const NO_ACTION_STEP =
  "No action needed: the customer was told politely that this is not a job for the business.";

const CASES: readonly Case[] = [
  {
    name: "1 ready-to-book roof replacement",
    segment: "roofing",
    fields: fields({
      service_type: "Roof replacement",
      job_scope: "Full tear-off, 2,400 sq ft asphalt shingle roof",
      job_type: "replacement",
      service_area: "Austin, TX 78704",
      timeline: "this_month",
      decision_maker: "homeowner",
      budget: "up_to_15k",
      budget_usd: 12_000,
      property_type: "single_family",
      photos: true,
      contact_name: "Dana Ruiz",
      contact_phone: "+15125550101",
    }),
    expect: {
      // Everything known: 95 of 95.
      defaults: {
        score: 100,
        band: "hot",
        outcome: "book_meeting",
        status: "meeting_requested",
        reasons: ["Hot leads: book a meeting."],
        nextStep: CALL_TO_BOOK_STEP,
        redFlags: [],
      },
      always_contact_later: {
        score: 100,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
        reasons: ["Every lead is told that the team will be in touch."],
        nextStep: CONTACT_LATER_STEP,
      },
      // 78704 is served; no answer on insurance earns 0 of 5: 95 of 100.
      strict: { score: 95, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
    },
  },
  {
    name: "2 HVAC emergency, no heat",
    segment: "hvac",
    fields: fields({
      service_type: "Furnace repair",
      job_scope: "Furnace stopped working, no heat in the house",
      job_type: "repair",
      service_area: "78702",
      timeline: "emergency",
      decision_maker: "homeowner",
      [SYSTEM_LEAD_FIELDS.emergency]: "no_heat",
    }),
    expect: {
      // 75 known + 20 unknown × 50 % = 85 of 95 = 89, plus 15 for the emergency → 100.
      defaults: {
        score: 100,
        band: "hot",
        outcome: "book_meeting",
        status: "meeting_requested",
        nextStep: `Emergency first: follow the emergency procedure and call the customer now. ${CALL_TO_BOOK_STEP}`,
      },
      always_contact_later: {
        score: 100,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // 75 of 100, plus 15 → 90.
      strict: { score: 90, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
    },
  },
  {
    name: "3 EV charger for a renter",
    segment: "electrical",
    fields: fields({
      service_type: "EV charger installation",
      job_scope: "Level 2 charger in the garage",
      job_type: "new_installation",
      service_area: "78701",
      timeline: "this_week",
      decision_maker: "tenant",
      other_decision_makers: "The landlord, Mike",
      property_type: "condo",
    }),
    expect: {
      // Decision-maker earns 0 (ask for the owner); 70 known + 15 × 50 % = 77.5 of 95 = 82.
      defaults: {
        score: 82,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
        reasons: [
          "The customer cannot approve the work: the team follows up with whoever decides. Not booked directly.",
        ],
        redFlags: [
          "The customer cannot approve the work: the team follows up with whoever decides.",
        ],
        nextStep: CONTACT_LATER_STEP,
      },
      always_contact_later: {
        score: 82,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // 70 of 100: warm.
      strict: { score: 70, band: "warm", outcome: "contact_later", status: "qualified" },
    },
  },
  {
    name: "4 kitchen remodel on a small budget, outside the strict area",
    segment: "remodeling",
    fields: fields({
      service_type: "Kitchen remodel",
      job_scope: "Replace cabinets and counters",
      job_type: "remodel",
      service_area: "Round Rock, TX 78664",
      timeline: "one_to_three_months",
      decision_maker: "homeowner",
      budget: "under_1k",
      budget_usd: 800,
      property_type: "single_family",
      comparing_quotes: true,
    }),
    expect: {
      // Timeline and budget are acceptable (half): 77.5 + photos 2.5 = 80 of 95 = 84.
      defaults: {
        score: 84,
        band: "hot",
        outcome: "book_meeting",
        status: "meeting_requested",
        redFlags: ["Collecting quotes from several companies."],
      },
      always_contact_later: {
        score: 84,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // 78664 is not served: turned away before anything else (the budget is below the
      // minimum too). Score: 20 + 15 + 0 + 7.5 + 10 + 0 + 5 = 57.5 of 100 → 58.
      strict: {
        score: 58,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "out_of_area",
        nextStep: NO_ACTION_STEP,
      },
    },
  },
  {
    name: "5 water heater price shopper who will not give a timeline",
    segment: "plumbing",
    fields: fields({
      service_type: "Water heater replacement",
      job_scope: "40-gallon gas water heater",
      job_type: "replacement",
      service_area: "78703",
      timeline: null,
      price_only_inquiry: true,
    }),
    expect: {
      // 50 known + 45 × 50 % = 72.5 of 95 = 76, minus 10 → 66.
      defaults: {
        score: 66,
        band: "warm",
        outcome: "contact_later",
        status: "qualified",
        reasons: ["Required detail not given: Timeline and urgency."],
        redFlags: ["Timeline and urgency: the customer did not answer.", "Only wants a price."],
      },
      always_contact_later: {
        score: 66,
        band: "warm",
        outcome: "contact_later",
        status: "qualified",
      },
      // The decision-maker is required and unknown: no decision yet. 50 of 100, minus 10.
      strict: {
        score: 40,
        band: "cold",
        outcome: null,
        status: "qualifying",
        nextStep: "Still qualifying: the bot is finding out decision-maker.",
      },
    },
  },
  {
    name: "6 spam",
    segment: "roofing",
    fields: fields({ [SYSTEM_LEAD_FIELDS.notAFit]: "spam" }),
    expect: {
      // Nothing known: 50 % of everything.
      defaults: {
        score: 50,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "spam",
        reasons: ["Not a lead: spam."],
        redFlags: ["Marked not a fit by the bot: spam."],
      },
      always_contact_later: {
        score: 50,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "spam",
      },
      strict: {
        score: 0,
        band: "cold",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "spam",
      },
    },
  },
  {
    name: "7 roof repair the bot found outside the area",
    segment: "roofing",
    fields: fields({
      service_type: "Roof repair",
      service_area: "Dallas, TX 75201",
      [SYSTEM_LEAD_FIELDS.notAFit]: "outside_service_area",
    }),
    expect: {
      // 20 + 0 + 30 × 50 % = 35 ... plus job scope 7.5: 20 + 7.5 + 0 + 7.5 + 5 + 5 + 2.5 + 2.5 = 50 of 95 = 53.
      defaults: {
        score: 53,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "out_of_area",
      },
      always_contact_later: {
        score: 53,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "out_of_area",
      },
      strict: {
        score: 20,
        band: "cold",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "out_of_area",
      },
    },
  },
  {
    name: "8 panel upgrade for an existing customer who was referred",
    segment: "electrical",
    fields: fields({
      service_type: "Panel upgrade",
      job_scope: "Upgrade a 100 A panel to 200 A",
      job_type: "replacement",
      service_area: "78701",
      timeline: "this_month",
      decision_maker: "homeowner",
      budget: "up_to_5k",
      property_type: "townhouse",
      existing_customer: true,
      referral: true,
    }),
    expect: {
      // 90 + 2.5 = 92.5 of 95 = 97, plus 10 and 10 → 100.
      defaults: {
        score: 100,
        band: "hot",
        outcome: "book_meeting",
        status: "meeting_requested",
        redFlags: [],
      },
      always_contact_later: {
        score: 100,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      strict: { score: 100, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
    },
  },
  {
    name: "9 rude bathroom remodel at a mobile home, a year out",
    segment: "remodeling",
    fields: fields({
      service_type: "Bathroom remodel",
      job_scope: "Walk-in shower conversion",
      service_area: "78704",
      timeline: ["later", 0.9],
      decision_maker: "homeowner",
      property_type: "mobile_home",
      rude_or_abusive: true,
    }),
    expect: {
      // Timeline 0, property 0 (contact later): 60 + 7.5 = 67.5 of 95 = 71, minus 20 → 51.
      defaults: {
        score: 51,
        band: "warm",
        outcome: "contact_later",
        status: "qualified",
        redFlags: [
          "The property (mobile or manufactured home) is not a kind the business accepts.",
          "Rude or abusive in the conversation.",
        ],
      },
      always_contact_later: {
        score: 51,
        band: "warm",
        outcome: "contact_later",
        status: "qualified",
      },
      // 60 of 100, minus 20 → 40: cold, turned away.
      strict: {
        score: 40,
        band: "cold",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "low_score",
        reasons: ["Cold leads: polite no."],
      },
    },
  },
  {
    name: "10 termite treatment with a custom criterion",
    segment: "pest_control",
    settings: {
      "qualification.custom_criteria": [
        {
          key: "infestation",
          label: "Kind of pest",
          question: "Which pest the customer is dealing with.",
          answer_type: "choice",
          choices: ["termites", "rodents", "ants", "bed bugs"],
          ideal_answers: ["termites", "bed bugs"],
          weight: 20,
          required: true,
        },
      ],
    },
    photoCount: 2,
    fields: fields({
      service_type: "Termite treatment",
      job_scope: "Swarmers in the garage",
      service_area: "78702",
      timeline: "this_week",
      decision_maker: "homeowner",
      infestation: "termites",
      photos: true,
    }),
    expect: {
      // 115 in all: 100 known + 7.5 unknown = 107.5 → 93.
      defaults: { score: 93, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
      always_contact_later: {
        score: 93,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // 120 in all: 100 of 120 → 83.
      strict: { score: 83, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
    },
  },
  {
    name: "11 AC replacement with a stated budget below the strict minimum",
    segment: "hvac",
    fields: fields({
      service_type: "AC replacement",
      job_scope: "3-ton central air conditioner",
      job_type: "replacement",
      service_area: "78703",
      timeline: "this_month",
      decision_maker: "homeowner",
      budget_usd: 1500,
      property_type: "single_family",
    }),
    expect: {
      // The band comes from the amount ($1,000 to $5,000, ideal): 92.5 of 95 → 97.
      defaults: { score: 97, band: "hot", outcome: "book_meeting", status: "meeting_requested" },
      always_contact_later: {
        score: 97,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // Below the $2,000 minimum: budget earns 0, 80 of 100 is hot, and the lead is turned away.
      strict: {
        score: 80,
        band: "hot",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "budget_below_minimum",
        redFlags: ["The budget is below the business's minimum."],
      },
    },
  },
  {
    name: "12 gutter cleaning, a service the business turns away",
    segment: "roofing",
    settings: { "qualification.service_type.not_offered": ["Gutter cleaning"] },
    fields: fields({ service_type: "Gutter cleaning", service_area: "78701" }),
    expect: {
      // 0 + 15 + 52.5 × 50 % ... = 7.5 + 15 + 22.5 = 45 of 95 → 47.
      defaults: {
        score: 47,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "service_not_offered",
        reasons: ["The service asked for is one the business does not take."],
      },
      always_contact_later: {
        score: 47,
        band: "warm",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "service_not_offered",
      },
      strict: {
        score: 15,
        band: "cold",
        outcome: "disqualify",
        status: "disqualified",
        disqualifyCode: "service_not_offered",
      },
    },
  },
  {
    name: "13 leaking pipe, first message",
    segment: "plumbing",
    fields: fields({ service_type: "Leaking pipe under the sink", contact_name: "Sam" }),
    expect: {
      // 20 + 75 × 50 % = 57.5 of 95 → 61; job scope, area and timeline are still open.
      defaults: {
        score: 61,
        band: "warm",
        outcome: null,
        status: "qualifying",
        nextStep:
          "Still qualifying: the bot is finding out job scope, service area and timeline and urgency.",
      },
      always_contact_later: { score: 61, band: "warm", outcome: null, status: "qualifying" },
      strict: { score: 20, band: "cold", outcome: null, status: "qualifying" },
    },
  },
  {
    name: "14 hail damage insurance job, location only guessed",
    segment: "roofing",
    fields: fields({
      service_type: "Hail damage roof repair",
      job_scope: "Missing shingles after the hail storm",
      job_type: "repair",
      service_area: ["Austin", 0.4],
      timeline: "this_week",
      decision_maker: "homeowner",
      insurance_claim: true,
      claim_status: "filed",
      insurer: "State Farm",
      property_type: "single_family",
      photos: true,
    }),
    expect: {
      // The service area is only a guess (0.4 < 0.5): still open. 70 + 12.5 = 82.5 of 95 → 87.
      defaults: { score: 87, band: "hot", outcome: null, status: "qualifying" },
      always_contact_later: { score: 87, band: "hot", outcome: null, status: "qualifying" },
      // Insurance preferred and involved: 75 of 100.
      strict: { score: 75, band: "warm", outcome: null, status: "qualifying" },
    },
  },
  {
    name: "15 rewiring inside a service radius that cannot be checked",
    segment: "electrical",
    settings: { "qualification.service_area.radius_miles": 30 },
    fields: fields({
      service_type: "Whole-house rewiring",
      job_scope: "1960s home with aluminum wiring",
      job_type: "replacement",
      service_area: "Pflugerville, TX 78660",
      timeline: "this_month",
      decision_maker: "landlord",
      budget: "up_to_15k",
      property_type: "multi_family",
      photos: false,
    }),
    expect: {
      // Area unverified (half), photos 0: 82.5 of 95 → 87; hot, but not booked directly.
      defaults: {
        score: 87,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
        reasons: [
          "The location could not be checked against the 30-mile service radius. Not booked directly.",
        ],
      },
      always_contact_later: {
        score: 87,
        band: "hot",
        outcome: "contact_later",
        status: "qualified",
      },
      // Unverified earns nothing here: 75 of 100, warm.
      strict: { score: 75, band: "warm", outcome: "contact_later", status: "qualified" },
    },
  },
];

describe("lead scoring, reports and routing: 15 leads under three configurations", () => {
  it("covers at least 12 leads across segments", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CASES.map((entry) => entry.segment)).size).toBeGreaterThanOrEqual(5);
  });

  for (const entry of CASES) {
    for (const config of Object.keys(CONFIGS) as Config[]) {
      it(`${entry.name} — ${config}`, () => {
        const settings = settingsWith({ ...CONFIGS[config], ...entry.settings });
        const assessment = assessLead({
          settings,
          facts: { fields: entry.fields, status: "qualifying", photoCount: entry.photoCount ?? 0 },
          now: NOW,
        });
        const want = entry.expect[config];
        expect({
          score: assessment.score,
          band: assessment.band,
          outcome: assessment.decision?.outcome ?? null,
          status: assessment.status,
        }).toEqual({
          score: want.score,
          band: want.band,
          outcome: want.outcome,
          status: want.status,
        });
        expect(assessment.decision?.score ?? want.score).toBe(want.score);
        if (want.disqualifyCode !== undefined) {
          expect(assessment.disqualifyCode).toBe(want.disqualifyCode);
        }
        for (const reason of want.reasons ?? []) {
          expect(assessment.decision?.reasons).toContain(reason);
        }
        if (assessment.decision !== null) {
          expect(assessment.decision.settingsVersion).toBe(settings.version);
          expect(assessment.decision.decidedAt).toBe(NOW);
        }

        const report = buildLeadReport({
          assessment,
          fields: entry.fields,
          values: settings.values,
        });
        expect(report.sections.score).toBe(want.score);
        expect(report.sections.outcome).toBe(want.outcome);
        expect(report.sections.status).toBe(want.status);
        if (want.nextStep !== undefined) expect(report.sections.nextStep).toBe(want.nextStep);
        if (want.redFlags !== undefined) expect(report.sections.redFlags).toEqual(want.redFlags);
        expect(report.summary).toMatch(
          new RegExp(
            `^${settings.values["scoring.band_labels"][want.band]} lead, score ${want.score}`,
          ),
        );
        for (const heading of [
          "Who",
          "Job",
          "Where",
          "Urgency",
          "Budget signals",
          "Fit",
          "Red flags",
          "Next step",
        ]) {
          expect(report.markdown).toContain(`### ${heading}\n`);
        }
      });
    }
  }
});
