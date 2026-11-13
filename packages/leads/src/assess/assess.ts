import { CONTACT_FIELD_KEYS } from "@repo/ai";
import {
  type LeadFieldValue,
  type LeadStatus,
  type RoutingDecision,
  type RoutingOutcome,
  SYSTEM_LEAD_FIELDS,
} from "@repo/core";
import type { AppResolvedSettings, AppSettings, ScoreBand } from "@repo/settings";

import { type CriterionResult, evaluateCriteria, type FitFinding, viewField } from "./criteria";
import type { AreaCheck } from "./service-area";

/**
 * Scoring and routing (C5): from the lead fields and the settings snapshot of a turn to a
 * score, a band, a routing decision and a lead status. Pure and deterministic; the store
 * calls it after every change, the dry runs call it in memory.
 */

/** The signals of `scoring.adjustments` the conversation can show. */
export const MODEL_SIGNALS = [
  "existing_customer",
  "referral",
  "repeat_inquiry",
  "comparing_quotes",
  "price_only_inquiry",
  "rude_or_abusive",
] as const;

export interface LeadFacts {
  /** Every recorded lead field by key, the system fields included. */
  readonly fields: Readonly<Record<string, LeadFieldValue>>;
  /** The status as stored (`new` for a lead not stored yet). */
  readonly status: LeadStatus;
  /** Photos the customer sent in this conversation. */
  readonly photoCount?: number;
}

export interface Adjustment {
  readonly signal: string;
  readonly points: number;
}

export interface LeadAssessment {
  readonly score: number;
  readonly band: ScoreBand;
  readonly bandLabel: string;
  /** The score from the criteria alone, before adjustments. */
  readonly baseScore: number;
  readonly criteria: readonly CriterionResult[];
  readonly adjustments: readonly Adjustment[];
  readonly area: AreaCheck | null;
  /** Null: no decision yet, keep qualifying. */
  readonly decision: RoutingDecision | null;
  /** Machine-readable reason for a disqualification ("spam", "out_of_area", "low_score"). */
  readonly disqualifyCode: string | null;
  /** Required criteria still missing or only guessed: the decision waits for them. */
  readonly pending: readonly CriterionResult[];
  readonly status: LeadStatus;
  /** The emergency class escalated in this conversation, if any. */
  readonly emergencyClass: string | null;
  /** The `mark_not_a_fit` category, if the bot recorded one. */
  readonly notAFit: string | null;
}

const OUTCOME_WORDS: Readonly<Record<RoutingOutcome, string>> = {
  book_meeting: "book a meeting",
  contact_later: "the team will be in touch",
  disqualify: "polite no",
};

/** Statuses that belong to a later step owned by another chunk; routing does not move them. */
const HELD_STATUSES: ReadonlySet<LeadStatus> = new Set(["meeting_booked", "handed_off"]);

/**
 * `mark_not_a_fit` categories that a criterion's fit rule decides, while that criterion is
 * used. The rule applies even when the field itself was never recorded (the bot judged the
 * job outside the area without saving the location).
 */
function notAFitRule(
  category: string,
  values: AppSettings,
): { readonly criterion: string; readonly finding: FitFinding | null } | null {
  if (category === "outside_service_area") {
    const action = values["qualification.service_area.out_of_area_action"];
    return {
      criterion: "service_area",
      finding:
        action === "accept"
          ? null
          : {
              action,
              code: "out_of_area",
              text: "Outside the service area. The bot found the job is outside the service area.",
            },
    };
  }
  if (category === "service_not_offered") {
    return {
      criterion: "service_type",
      finding: {
        action: values["qualification.service_type.not_offered_action"],
        code: "service_not_offered",
        text: "The service asked for is one the business does not take.",
      },
    };
  }
  return null;
}

const SEVERITY: Readonly<Record<RoutingOutcome, number>> = {
  book_meeting: 0,
  contact_later: 1,
  disqualify: 2,
};

function stricter(a: RoutingOutcome, b: RoutingOutcome): RoutingOutcome {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export function bandFor(score: number, values: AppSettings): ScoreBand {
  const thresholds = values["scoring.thresholds"];
  return score >= thresholds.hot ? "hot" : score >= thresholds.warm ? "warm" : "cold";
}

/** The signals seen in the conversation, from the lead fields. */
export function observedSignals(facts: LeadFacts, values: AppSettings): Set<string> {
  const minimum = values["scoring.minimum_confidence"];
  const seen = new Set<string>();
  for (const signal of MODEL_SIGNALS) {
    const view = viewField(facts.fields, signal, minimum);
    if (view.state === "known" && view.value === true) seen.add(signal);
  }
  if (typeof facts.fields[SYSTEM_LEAD_FIELDS.emergency]?.value === "string") seen.add("emergency");
  const phone = viewField(facts.fields, CONTACT_FIELD_KEYS.phone, minimum);
  if (phone.state === "known") seen.add("shared_phone");
  const photos = viewField(facts.fields, "photos", minimum);
  if ((photos.state === "known" && photos.value === true) || (facts.photoCount ?? 0) > 0) {
    seen.add("sent_photos");
  }
  return seen;
}

export function assessLead(input: {
  readonly settings: AppResolvedSettings;
  readonly facts: LeadFacts;
  readonly now: string;
}): LeadAssessment {
  const { settings, facts, now } = input;
  const values = settings.values;
  const { criteria, area } = evaluateCriteria({
    values,
    fields: facts.fields,
    photoCount: facts.photoCount ?? 0,
  });

  // Score: the weighted share of the criteria, then the adjustments, kept within 0 to 100.
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned = criteria.reduce((sum, criterion) => sum + criterion.weight * criterion.credit, 0);
  // Rounded half up after removing floating-point noise (57.5 stays 57.5, not 57.4999...).
  // With no weight at all (every criterion off or weighted 0) nothing is known either way:
  // the lead stands where an unanswered criterion would, `scoring.unknown_credit_percent`.
  const share = total === 0 ? values["scoring.unknown_credit_percent"] / 100 : earned / total;
  const baseScore = Math.round(Number((share * 100).toFixed(6)));
  const signals = observedSignals(facts, values);
  const adjustments: Adjustment[] = values["scoring.adjustments"]
    .filter((entry) => signals.has(entry.signal) && entry.points !== 0)
    .map((entry) => ({ signal: entry.signal, points: entry.points }));
  const score = Math.max(
    0,
    Math.min(100, baseScore + adjustments.reduce((sum, entry) => sum + entry.points, 0)),
  );
  const band = bandFor(score, values);
  const bandLabel = values["scoring.band_labels"][band];

  const notAFitValue = facts.fields[SYSTEM_LEAD_FIELDS.notAFit]?.value;
  const notAFit = typeof notAFitValue === "string" ? notAFitValue : null;
  const emergencyValue = facts.fields[SYSTEM_LEAD_FIELDS.emergency]?.value;
  const emergencyClass = typeof emergencyValue === "string" ? emergencyValue : null;
  const findings: FitFinding[] = criteria.flatMap((criterion) => criterion.findings);
  // A not-a-fit judgement that a used criterion's fit rule decides: that rule applies, also
  // when the field was not recorded. Any other judgement goes to a person (below).
  const rule = notAFit === null ? null : notAFitRule(notAFit, values);
  const settledByRule =
    rule !== null && criteria.some((criterion) => criterion.key === rule.criterion);
  if (
    settledByRule &&
    rule.finding !== null &&
    !findings.some((entry) => entry.code === rule.finding?.code)
  ) {
    findings.push(rule.finding);
  }
  const pending = criteria.filter(
    (criterion) =>
      criterion.required && (criterion.state === "missing" || criterion.state === "unconfirmed"),
  );

  const reasons: string[] = [];
  let outcome: RoutingOutcome | null = null;
  let disqualifyCode: string | null = null;

  // 1. Contacts that are never leads, and fit rules that turn a lead away.
  const autoDisqualify = values["scoring.auto_disqualify"] as readonly string[];
  if (notAFit !== null && autoDisqualify.includes(notAFit)) {
    outcome = "disqualify";
    disqualifyCode = notAFit;
    reasons.push(`Not a lead: ${notAFit.replaceAll("_", " ")}.`);
  } else {
    const turnedAway = findings.find((entry) => entry.action === "disqualify");
    if (turnedAway !== undefined) {
      outcome = "disqualify";
      disqualifyCode = turnedAway.code;
      reasons.push(turnedAway.text);
    }
  }

  // A contact the bot judged not a fit, of a kind the business does not turn away by itself:
  // a person looks at it.
  // (A service the business does not offer and a job outside the area are settled by their
  // fit rules instead, while those criteria are used.)
  if (outcome === null && notAFit !== null && !settledByRule) {
    outcome = "contact_later";
    reasons.push("The bot judged this contact not a fit; the team should review it.");
  }

  // 2. Otherwise a decision waits for every required criterion.
  if (outcome === null && pending.length === 0) {
    const existingCustomerRule =
      signals.has("existing_customer") &&
      values["routing.existing_customer_outcome"] !== "by_score";
    if (values["routing.mode"] === "always_contact_later") {
      outcome = "contact_later";
      reasons.push("Every lead is told that the team will be in touch.");
    } else if (existingCustomerRule) {
      // The business routes existing customers itself, whatever their band: never booked
      // directly, never turned away for a low score.
      outcome = "contact_later";
      reasons.push(
        values[`routing.${band}_outcome`] === "book_meeting"
          ? "Already a customer: the team takes it from here. Not booked directly."
          : "Already a customer: the team takes it from here.",
      );
    } else {
      outcome = values[`routing.${band}_outcome`];
      reasons.push(`${bandLabel} leads: ${OUTCOME_WORDS[outcome]}.`);
      if (outcome === "disqualify") disqualifyCode = "low_score";
    }
    // 3. Nothing makes the outcome friendlier than a fit rule or a hold on direct booking.
    const holds: string[] = [];
    for (const entry of findings) {
      if (entry.action === "contact_later" || entry.action === "unverified") holds.push(entry.text);
    }
    for (const criterion of criteria) {
      if (criterion.required && criterion.state === "declined") {
        holds.push(`Required detail not given: ${criterion.label}.`);
      }
    }
    if (holds.length > 0) {
      const held = stricter(outcome, "contact_later");
      if (held !== outcome) reasons.push(...holds.map((text) => `${text} Not booked directly.`));
      else reasons.push(...holds);
      outcome = held;
    }
  }

  const decision: RoutingDecision | null =
    outcome === null
      ? null
      : {
          outcome,
          score,
          band,
          reasons: unique(reasons),
          decidedAt: now,
          settingsVersion: settings.version,
        };

  let status: LeadStatus;
  if (HELD_STATUSES.has(facts.status)) status = facts.status;
  else if (decision === null) {
    status = Object.keys(facts.fields).length > 0 ? "qualifying" : "new";
  } else {
    status =
      decision.outcome === "disqualify"
        ? "disqualified"
        : decision.outcome === "book_meeting"
          ? "meeting_requested"
          : "qualified";
  }

  return {
    score,
    band,
    bandLabel,
    baseScore,
    criteria,
    adjustments,
    area,
    decision,
    disqualifyCode: decision?.outcome === "disqualify" ? disqualifyCode : null,
    pending,
    status,
    emergencyClass,
    notAFit,
  };
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}
