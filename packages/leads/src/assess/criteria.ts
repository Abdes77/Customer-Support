import { CONTACT_FIELD_KEYS } from "@repo/ai";
import { type LeadFieldValue, SYSTEM_LEAD_FIELDS } from "@repo/core";
import { type AppSettings, CRITERION_LABELS, type QualificationCriterion } from "@repo/settings";

import { type AreaCheck, checkServiceArea } from "./service-area";
import { asData, mentions, optionLabel, usd } from "./text";

/**
 * One evaluation per qualification criterion (the enabled built-in ones and the custom ones):
 * what is known, how much of the weight the lead earns, and what a fit rule makes of the
 * answer. Pure: the same fields and settings always give the same result.
 */

/**
 * known: a usable answer. declined: recorded as null (asked, the customer would not or could
 * not say). unconfirmed: a guess below `scoring.minimum_confidence`. missing: not recorded.
 */
export type CriterionState = "known" | "declined" | "unconfirmed" | "missing";

export type FitAction = "lower_score" | "contact_later" | "disqualify";

/** What a fit rule made of an answer. `unverified`: the team has to check it. */
export interface FitFinding {
  readonly action: FitAction | "unverified";
  /** Machine-readable, for `lead.disqualified.reasonCode` and analytics. */
  readonly code: string;
  /** For the report and the routing reasons. Written by code, never customer text. */
  readonly text: string;
}

export interface CriterionResult {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly required: boolean;
  readonly state: CriterionState;
  /** Share of the weight earned, 0 to 1. */
  readonly credit: number;
  /** The answer in words, customer text quoted as data. Null unless recorded with a value. */
  readonly value: string | null;
  readonly confidence: number | null;
  readonly evidence: string | null;
  readonly findings: readonly FitFinding[];
}

export interface FieldView {
  readonly state: CriterionState;
  readonly value: unknown;
  readonly field: LeadFieldValue | null;
}

/** How a recorded field stands, given the minimum confidence. */
export function viewField(
  fields: Readonly<Record<string, LeadFieldValue>>,
  key: string,
  minimum: number,
): FieldView {
  const field = fields[key] ?? null;
  if (field === null) return { state: "missing", value: null, field };
  if (field.value === null) return { state: "declined", value: null, field };
  if (field.confidence < minimum) return { state: "unconfirmed", value: field.value, field };
  return { state: "known", value: field.value, field };
}

/** A known value as text, or null. */
export function knownText(view: FieldView): string | null {
  if (view.state !== "known") return null;
  const value = view.value;
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

export function knownBoolean(view: FieldView): boolean | null {
  return view.state === "known" && typeof view.value === "boolean" ? view.value : null;
}

export function knownNumber(view: FieldView): number | null {
  return view.state === "known" && typeof view.value === "number" && Number.isFinite(view.value)
    ? view.value
    : null;
}

type AnyAction = "accept" | FitAction | "ask_for_owner";

/** A fit rule's action as a finding; `accept` is none. */
function finding(action: AnyAction, code: string, text: string): FitFinding | null {
  if (action === "accept") return null;
  return { action: action === "ask_for_owner" ? "contact_later" : action, code, text };
}

export interface CriteriaInput {
  readonly values: AppSettings;
  readonly fields: Readonly<Record<string, LeadFieldValue>>;
  /** Photos the customer sent in this conversation. */
  readonly photoCount?: number;
}

export interface CriteriaResult {
  readonly criteria: readonly CriterionResult[];
  /** The service-area check, when a location is known. */
  readonly area: AreaCheck | null;
}

function display(view: FieldView, render: (value: unknown) => string): string | null {
  if (view.state === "missing" || view.state === "declined") return null;
  return render(view.value);
}

const yesNo = (value: unknown) =>
  value === true ? "yes" : value === false ? "no" : asData(String(value));
const quoted = (value: unknown) => asData(String(value));

export function evaluateCriteria(input: CriteriaInput): CriteriaResult {
  const { values, fields } = input;
  const minimum = values["scoring.minimum_confidence"];
  const view = (key: string) => viewField(fields, key, minimum);
  const notAFit = fields[SYSTEM_LEAD_FIELDS.notAFit]?.value;
  const emergency = fields[SYSTEM_LEAD_FIELDS.emergency]?.value;
  const results: CriterionResult[] = [];
  let area: AreaCheck | null = null;

  const unknownCredit = values["scoring.unknown_credit_percent"] / 100;

  function push(
    id: QualificationCriterion,
    current: FieldView,
    evaluate: () => { credit: number; findings: (FitFinding | null)[] },
    render: (value: unknown) => string,
  ): void {
    if (!values[`qualification.${id}.enabled`]) return;
    const outcome =
      current.state === "known" ? evaluate() : { credit: unknownCredit, findings: [] };
    results.push({
      key: id,
      label: CRITERION_LABELS[id],
      weight: values[`qualification.${id}.weight`],
      required: values[`qualification.${id}.required`],
      state: current.state,
      credit: outcome.credit,
      value: display(current, render),
      confidence: current.field?.confidence ?? null,
      evidence: current.field?.evidence ?? null,
      findings: outcome.findings.filter((entry): entry is FitFinding => entry !== null),
    });
  }

  // Service type: turned away when it is on the "not offered" list or the bot marked it so.
  push(
    "service_type",
    view("service_type"),
    () => {
      const text = knownText(view("service_type")) ?? "";
      const offered = values["qualification.service_type.offered"];
      const notOffered =
        notAFit === "service_not_offered" ||
        values["qualification.service_type.not_offered"].some((entry) => mentions(text, entry));
      if (notOffered) {
        return {
          credit: 0,
          findings: [
            finding(
              values["qualification.service_type.not_offered_action"],
              "service_not_offered",
              "The service asked for is one the business does not take.",
            ),
          ],
        };
      }
      if (offered.length > 0 && !offered.some((entry) => mentions(text, entry))) {
        return {
          credit: 0.5,
          findings: [
            {
              action: "unverified",
              code: "service_unlisted",
              text: "The service is not clearly one of the services the business lists.",
            },
          ],
        };
      }
      return { credit: 1, findings: [] };
    },
    quoted,
  );

  // Job scope: the kind of job and the smallest job worth taking.
  push(
    "job_scope",
    view("job_scope"),
    () => {
      const findings: (FitFinding | null)[] = [];
      let credit = 1;
      const jobType = knownText(view("job_type"));
      if (
        jobType !== null &&
        !(values["qualification.job_scope.accepted_types"] as readonly string[]).includes(jobType)
      ) {
        const action = values["qualification.job_scope.other_type_action"];
        credit = 0;
        findings.push(
          finding(
            action,
            "job_type_not_accepted",
            `The kind of job (${optionLabel("qualification.job_scope.accepted_types", jobType).toLowerCase()}) is not one the business accepts.`,
          ),
        );
      }
      const minimumJob = values["qualification.job_scope.minimum_job_usd"];
      const stated = knownNumber(view("budget_usd"));
      if (minimumJob !== null && stated !== null && stated < minimumJob) {
        const action = values["qualification.job_scope.small_job_action"];
        if (action !== "accept") credit = 0;
        findings.push(
          finding(
            action,
            "job_too_small",
            "The job is smaller than the smallest job worth taking.",
          ),
        );
      }
      return { credit, findings };
    },
    quoted,
  );

  // Service area.
  const location = view("service_area");
  push(
    "service_area",
    location,
    () => {
      const text = knownText(location) ?? "";
      const check: AreaCheck =
        notAFit === "outside_service_area"
          ? {
              verdict: "outside",
              why: "The bot found the job is outside the service area.",
              zip: null,
              state: null,
            }
          : checkServiceArea(text, values);
      area = check;
      if (check.verdict === "outside") {
        const action = values["qualification.service_area.out_of_area_action"];
        return {
          credit: action === "accept" ? 1 : 0,
          findings: [finding(action, "out_of_area", `Outside the service area. ${check.why}`)],
        };
      }
      if (check.verdict === "unverified") {
        return {
          credit: unknownCredit,
          findings: [{ action: "unverified", code: "area_unverified", text: check.why }],
        };
      }
      return { credit: 1, findings: [] };
    },
    quoted,
  );
  if (location.state !== "known" && notAFit === "outside_service_area") {
    area = {
      verdict: "outside",
      why: "The bot found the job is outside the service area.",
      zip: null,
      state: null,
    };
  }

  // Timeline. An escalated emergency is a timeline of "right now" when none was recorded.
  const timelineRecorded = view("timeline");
  const timeline: FieldView =
    timelineRecorded.state !== "known" && typeof emergency === "string"
      ? { state: "known", value: "emergency", field: timelineRecorded.field }
      : timelineRecorded;
  push(
    "timeline",
    timeline,
    () => {
      const value = knownText(timeline) ?? "";
      const ideal = values["qualification.timeline.ideal"] as readonly string[];
      const acceptable = values["qualification.timeline.acceptable"] as readonly string[];
      return {
        credit: ideal.includes(value) ? 1 : acceptable.includes(value) ? 0.5 : 0,
        findings: [],
      };
    },
    (value) => optionLabel("qualification.timeline.ideal", String(value)),
  );

  // Decision-maker.
  push(
    "decision_maker",
    view("decision_maker"),
    () => {
      const role = knownText(view("decision_maker")) ?? "";
      if (
        (values["qualification.decision_maker.accepted_roles"] as readonly string[]).includes(role)
      ) {
        return { credit: 1, findings: [] };
      }
      const action = values["qualification.decision_maker.not_decision_maker_action"];
      return {
        credit: action === "accept" ? 1 : 0,
        findings: [
          finding(
            action,
            "not_decision_maker",
            action === "ask_for_owner"
              ? "The customer cannot approve the work: the team follows up with whoever decides."
              : "The customer cannot approve the work.",
          ),
        ],
      };
    },
    (value) => optionLabel("qualification.decision_maker.accepted_roles", String(value)),
  );

  // Budget: the band's fit, and the minimum budget against the stated amount.
  const bands = values["qualification.budget.bands"];
  const budgetRecorded = view("budget");
  const statedBudget = knownNumber(view("budget_usd"));
  const bandFromAmount =
    statedBudget === null
      ? undefined
      : bands.find(
          (band) =>
            (band.min_usd === null || statedBudget >= band.min_usd) &&
            (band.max_usd === null || statedBudget < band.max_usd),
        );
  const budget: FieldView =
    budgetRecorded.state !== "known" && bandFromAmount !== undefined
      ? { state: "known", value: bandFromAmount.key, field: view("budget_usd").field }
      : budgetRecorded;
  push(
    "budget",
    budget,
    () => {
      const band = bands.find((entry) => entry.key === knownText(budget));
      let credit =
        band === undefined
          ? unknownCredit
          : band.fit === "ideal"
            ? 1
            : band.fit === "acceptable"
              ? 0.5
              : 0;
      const findings: (FitFinding | null)[] = [];
      const minimum = values["qualification.budget.minimum_usd"];
      // A stated amount below the minimum; or a band that ends at or below it (a band's upper
      // end is exclusive, so every budget in it is below the minimum).
      const below =
        minimum !== null &&
        (statedBudget !== null
          ? statedBudget < minimum
          : band?.max_usd !== null && band?.max_usd !== undefined && band.max_usd <= minimum);
      if (below) {
        const action = values["qualification.budget.below_minimum_action"];
        if (action !== "accept") credit = 0;
        findings.push(
          finding(action, "budget_below_minimum", "The budget is below the business's minimum."),
        );
      }
      return { credit, findings };
    },
    (value) => {
      const band = bands.find((entry) => entry.key === value);
      const label = band?.label ?? asData(String(value));
      return statedBudget === null ? label : `${label} (stated ${usd(statedBudget)})`;
    },
  );

  // Property type.
  push(
    "property_type",
    view("property_type"),
    () => {
      const type = knownText(view("property_type")) ?? "";
      if ((values["qualification.property_type.accepted"] as readonly string[]).includes(type)) {
        return { credit: 1, findings: [] };
      }
      const action = values["qualification.property_type.other_action"];
      return {
        credit: action === "accept" ? 1 : 0,
        findings: [
          finding(
            action,
            "property_type_not_accepted",
            `The property (${optionLabel("qualification.property_type.accepted", type).toLowerCase()}) is not a kind the business accepts.`,
          ),
        ],
      };
    },
    (value) => optionLabel("qualification.property_type.accepted", String(value)),
  );

  // Insurance claim and financing: a preference, not a fit rule.
  push(
    "insurance_claim",
    view("insurance_claim"),
    () => {
      const claim = knownBoolean(view("insurance_claim"));
      const preference = values["qualification.insurance_claim.preference"];
      const credit =
        preference === "neutral" ? 1 : preference === "prefer" ? (claim ? 1 : 0.5) : claim ? 0 : 1;
      return { credit, findings: [] };
    },
    yesNo,
  );
  push(
    "financing",
    view("financing"),
    () => {
      const wants = knownBoolean(view("financing"));
      const effect = values["qualification.financing.interest_effect"];
      const credit =
        effect === "neutral" ? 1 : effect === "positive" ? (wants ? 1 : 0.5) : wants ? 0 : 1;
      return { credit, findings: [] };
    },
    yesNo,
  );
  // Photos: photos the customer sent in this conversation count, recorded or not.
  const photosRecorded = view("photos");
  const photos: FieldView =
    knownBoolean(photosRecorded) !== true && (input.photoCount ?? 0) > 0
      ? { state: "known", value: true, field: null }
      : photosRecorded;
  push("photos", photos, () => ({ credit: knownBoolean(photos) ? 1 : 0, findings: [] }), yesNo);

  // Custom criteria: an answer among the ideal answers earns the full weight.
  const builtIn = new Set<string>([
    "service_type",
    "job_scope",
    "service_area",
    "timeline",
    "decision_maker",
    "budget",
    "property_type",
    "insurance_claim",
    "financing",
    "photos",
    "job_type",
    "budget_usd",
    "other_decision_makers",
    "property_age",
    "customer_questions",
    ...Object.values(CONTACT_FIELD_KEYS),
  ]);
  const seen = new Set<string>();
  for (const custom of values["qualification.custom_criteria"]) {
    if (builtIn.has(custom.key) || seen.has(custom.key)) continue;
    seen.add(custom.key);
    const current = view(custom.key);
    let credit = unknownCredit;
    if (current.state === "known") {
      const ideal = custom.ideal_answers.map((answer) => answer.trim().toLowerCase());
      const answer =
        typeof current.value === "boolean"
          ? current.value
            ? "yes"
            : "no"
          : String(current.value).trim().toLowerCase();
      credit = ideal.length === 0 || ideal.includes(answer) ? 1 : 0;
    }
    results.push({
      key: custom.key,
      label: custom.label,
      weight: custom.weight,
      required: custom.required,
      state: current.state,
      credit,
      value: display(current, custom.answer_type === "yes_no" ? yesNo : quoted),
      confidence: current.field?.confidence ?? null,
      evidence: current.field?.evidence ?? null,
      findings: [],
    });
  }
  return { criteria: results, area };
}
