import type { AppSettings } from "./registry";

/**
 * Recommended segment defaults for the trades the product is built for. A preset is a
 * starting point, not a rule: `applySegmentPreset` (server) writes it as ordinary overrides
 * at the segment scope when a segment is first served, where an agency admin can change or
 * reset every value. Trades without a preset simply start from the registry defaults.
 *
 * Only settings that allow the segment scope may appear here; a test checks each value.
 */
export type SegmentPreset = Readonly<Partial<AppSettings>>;

export const SEGMENT_PRESET_IDS = [
  "roofing",
  "hvac",
  "plumbing",
  "electrical",
  "remodeling",
] as const;
export type SegmentPresetId = (typeof SEGMENT_PRESET_IDS)[number];

export const SEGMENT_PRESETS: Readonly<Record<SegmentPresetId, SegmentPreset>> = {
  // Storm and insurance work, big tickets, the roof's age matters.
  roofing: {
    "qualification.insurance_claim.enabled": true,
    "qualification.insurance_claim.weight": 10,
    "qualification.property_type.ask_age": true,
    "qualification.job_scope.details": [
      "roughly how old the roof is",
      "what the roof is made of (shingle, metal, tile, flat)",
      "whether the home is one story or two",
      "whether water is coming in right now",
    ],
    "photos.subjects": [
      "the damaged area, taken from the ground",
      "any stains on the ceiling inside",
    ],
  },
  // Repairs are urgent and seasonal; replacements are often financed.
  hvac: {
    "qualification.financing.enabled": true,
    "qualification.property_type.ask_age": true,
    "qualification.job_scope.details": [
      "what kind of system it is (furnace, heat pump, central air, mini-split)",
      "roughly how old the system is",
      "what the system is doing or not doing",
    ],
    "qualification.timeline.ideal": ["emergency", "this_week", "this_month"],
    "photos.subjects": ["the label on the unit", "the thermostat display"],
  },
  // Mostly repairs: speed matters, budget questions put people off.
  plumbing: {
    "qualification.budget.ask_mode": "never",
    "qualification.budget.weight": 0,
    "qualification.timeline.ideal": ["emergency", "this_week"],
    "qualification.timeline.acceptable": ["this_month"],
    "qualification.job_scope.details": [
      "where the problem is (kitchen, bathroom, basement, outside)",
      "whether water is leaking right now",
      "whether the water has been shut off",
    ],
    "photos.subjects": ["the leak or the fixture", "the area around it"],
  },
  // Safety first; the age of the home says a lot about the wiring.
  electrical: {
    "qualification.property_type.ask_age": true,
    "qualification.job_scope.details": [
      "what is not working, or what needs to be added",
      "whether a breaker keeps tripping",
      "roughly how old the home is",
    ],
    "photos.subjects": [
      "the outlet, switch or fixture in question",
      "the electrical panel, taken from a step back with its door closed",
    ],
  },
  // Kitchen and bath remodels: long sales cycle, budget and decision-makers matter most.
  remodeling: {
    "qualification.budget.ask_mode": "offer_bands",
    "qualification.budget.weight": 20,
    "qualification.budget.bands": [
      { key: "under_10k", label: "Under $10,000", min_usd: null, max_usd: 10_000, fit: "poor" },
      {
        key: "up_to_25k",
        label: "$10,000 to $25,000",
        min_usd: 10_000,
        max_usd: 25_000,
        fit: "acceptable",
      },
      {
        key: "up_to_50k",
        label: "$25,000 to $50,000",
        min_usd: 25_000,
        max_usd: 50_000,
        fit: "ideal",
      },
      {
        key: "up_to_100k",
        label: "$50,000 to $100,000",
        min_usd: 50_000,
        max_usd: 100_000,
        fit: "ideal",
      },
      { key: "over_100k", label: "Over $100,000", min_usd: 100_000, max_usd: null, fit: "ideal" },
    ],
    "qualification.timeline.ideal": ["this_month", "one_to_three_months"],
    "qualification.timeline.acceptable": ["this_week", "three_to_six_months"],
    "qualification.decision_maker.required": true,
    "qualification.decision_maker.ask_about_others": true,
    "qualification.financing.enabled": true,
    "qualification.job_scope.details": [
      "which rooms are involved",
      "roughly how big the space is",
      "whether the layout changes or it is an update of what is there",
      "whether they have plans or inspiration photos",
    ],
    "photos.subjects": ["the room as it is today, taken from the doorway"],
    "scheduling.slot_minutes": 90,
  },
};

const ALIASES: Readonly<Record<string, SegmentPresetId>> = {
  roofing: "roofing",
  roofer: "roofing",
  roofers: "roofing",
  roof_repair: "roofing",
  hvac: "hvac",
  heating_and_cooling: "hvac",
  heating_cooling: "hvac",
  heating_and_air: "hvac",
  air_conditioning: "hvac",
  plumbing: "plumbing",
  plumber: "plumbing",
  plumbers: "plumbing",
  electrical: "electrical",
  electrician: "electrical",
  electricians: "electrical",
  remodeling: "remodeling",
  remodel: "remodeling",
  kitchen_remodeling: "remodeling",
  bath_remodeling: "remodeling",
  bathroom_remodeling: "remodeling",
  kitchen_and_bath: "remodeling",
  kitchen_bath: "remodeling",
  kitchen_and_bath_remodeling: "remodeling",
  kitchen_bath_remodeling: "remodeling",
  home_remodeling: "remodeling",
};

/** The preset for a segment slug ("roofing", "kitchen-bath-remodeling"), or null when there is none. */
export function segmentPresetFor(
  slug: string,
): { readonly id: SegmentPresetId; readonly preset: SegmentPreset } | null {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!Object.hasOwn(ALIASES, normalized)) return null;
  const id = ALIASES[normalized];
  return id === undefined ? null : { id, preset: SEGMENT_PRESETS[id] };
}
