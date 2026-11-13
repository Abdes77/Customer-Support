import { defineCategory, setting } from "../define";
import { f } from "../fields";

/**
 * The score bands. A lead's band is the first one whose threshold its score reaches; "cold"
 * is everything below "warm". `RoutingDecision.band` holds one of these keys.
 */
export const SCORE_BANDS = ["hot", "warm", "cold"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export const SCORE_SIGNALS = [
  "emergency",
  "existing_customer",
  "referral",
  "repeat_inquiry",
  "shared_phone",
  "sent_photos",
  "comparing_quotes",
  "price_only_inquiry",
  "rude_or_abusive",
] as const;

/** How criteria turn into a score and a band. Consumed by lead scoring (C5). */
export const scoringSettings = defineCategory("scoring", {
  "scoring.thresholds": setting({
    label: "Score thresholds",
    help: "The lowest score for each band. A lead at or above the hot threshold is hot, at or above the warm threshold warm, and cold below that. Routing decides what each band means.",
    field: f.object(
      {
        hot: { label: "Hot from", field: f.integer({ min: 1, max: 100, unit: "points" }) },
        warm: { label: "Warm from", field: f.integer({ min: 0, max: 99, unit: "points" }) },
      },
      {
        check: (value) =>
          value.hot > value.warm
            ? []
            : [{ path: ["hot"], message: "The hot threshold must be above the warm threshold." }],
      },
    ),
    default: { hot: 70, warm: 40 },
  }),
  "scoring.band_labels": setting({
    label: "Band names",
    help: "What the bands are called in reports, alerts and the admin panel. Customers never see them.",
    field: f.object({
      hot: { label: "Hot", field: f.text({ minLength: 1, maxLength: 30 }) },
      warm: { label: "Warm", field: f.text({ minLength: 1, maxLength: 30 }) },
      cold: { label: "Cold", field: f.text({ minLength: 1, maxLength: 30 }) },
    }),
    default: { hot: "Hot", warm: "Warm", cold: "Cold" },
  }),
  "scoring.unknown_credit_percent": setting({
    label: "Credit for unanswered criteria",
    help: "The share of a criterion's weight a lead earns while that criterion is still unknown. 50 treats an unanswered question as neutral; 0 makes leads earn every point.",
    field: f.integer({ min: 0, max: 100, unit: "%" }),
    default: 50,
  }),
  "scoring.minimum_confidence": setting({
    label: "Minimum confidence",
    help: "An answer the bot inferred with less confidence than this counts as unknown. 1 accepts only what the customer stated outright.",
    field: f.number({ min: 0, max: 1, step: 0.05 }),
    default: 0.5,
  }),
  "scoring.adjustments": setting({
    label: "Score adjustments",
    help: "Points added or taken off when a signal shows up in the conversation, on top of the criteria. The result stays between 0 and 100.",
    field: f.list(
      f.object({
        signal: {
          label: "Signal",
          field: f.select([
            ["emergency", "The situation is an emergency"],
            ["existing_customer", "Already a customer"],
            ["referral", "Referred by someone"],
            ["repeat_inquiry", "Has contacted the business before"],
            ["shared_phone", "Gave a phone number"],
            ["sent_photos", "Sent photos"],
            ["comparing_quotes", "Is collecting several quotes"],
            ["price_only_inquiry", "Only wants a price"],
            ["rude_or_abusive", "Rude or abusive"],
          ]),
        },
        points: { label: "Points", field: f.integer({ min: -100, max: 100, unit: "points" }) },
      }),
      { itemLabel: "adjustment", maxItems: 20, unique: "signal" },
    ),
    default: [
      { signal: "emergency", points: 15 },
      { signal: "existing_customer", points: 10 },
      { signal: "referral", points: 10 },
      { signal: "price_only_inquiry", points: -10 },
      { signal: "rude_or_abusive", points: -20 },
    ],
  }),
  "scoring.auto_disqualify": setting({
    label: "Always disqualify",
    help: "Contacts of these kinds are never leads, whatever their score.",
    field: f.multiSelect([
      ["spam", "Spam and scams"],
      ["solicitation", "Vendors and sales pitches"],
      ["job_seeker", "People looking for work"],
      ["wrong_number", "Wrong number or wrong business"],
    ]),
    default: ["spam", "solicitation", "job_seeker", "wrong_number"],
  }),
});
