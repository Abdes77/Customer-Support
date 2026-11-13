import type { LeadSnapshot } from "@repo/core";
import {
  type AppSettings,
  CRITERION_LABELS,
  QUALIFICATION_CRITERIA,
  type QualificationCriterion,
} from "@repo/settings";

/**
 * The lead fields a conversation can record, derived from the settings of one business: the
 * enabled qualification criteria, their details, the contact details to collect, the custom
 * criteria and the signals lead scoring adjusts for.
 *
 * The engine shows this catalogue to the model and checks every `update_lead_fields` call
 * against it, so a value that reaches lead scoring (C5) always has a known key and, for the
 * enumerated criteria, a canonical value.
 */

export type LeadFieldType = "text" | "choice" | "boolean" | "number";
export type LeadFieldGroup = "criterion" | "detail" | "contact" | "custom" | "signal";

export interface LeadFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly group: LeadFieldGroup;
  readonly type: LeadFieldType;
  /** The allowed values of a "choice" field. */
  readonly options?: readonly string[];
  /** What the value is, for the prompt. */
  readonly describe: string;
  /** The bot works toward an answer; false: recorded only when the customer brings it up. */
  readonly ask: boolean;
  /** The criterion is marked required in settings. */
  readonly required: boolean;
  /** The criterion's weight in the lead score (0 for everything that is not a criterion). */
  readonly weight: number;
}

/** Values of the enumerated criteria. They mirror the option lists in the settings registry. */
export const JOB_TYPE_VALUES = [
  "repair",
  "replacement",
  "new_installation",
  "maintenance",
  "inspection",
  "remodel",
  "emergency_service",
] as const;

export const TIMELINE_VALUES = [
  "emergency",
  "this_week",
  "this_month",
  "one_to_three_months",
  "three_to_six_months",
  "later",
  "just_researching",
] as const;

export const DECISION_ROLE_VALUES = [
  "homeowner",
  "landlord",
  "property_manager",
  "business_owner",
  "tenant_with_permission",
  "tenant",
  "other",
] as const;

export const PROPERTY_TYPE_VALUES = [
  "single_family",
  "townhouse",
  "condo",
  "multi_family",
  "mobile_home",
  "commercial",
  "new_construction",
] as const;

/** Signals the model can observe in a conversation (`scoring.adjustments` in settings). */
export const OBSERVABLE_SIGNALS = [
  ["existing_customer", "The person is already a customer of the business."],
  ["referral", "Someone referred them to the business."],
  ["repeat_inquiry", "They say they have contacted the business about this before."],
  ["comparing_quotes", "They are collecting quotes from several companies."],
  ["price_only_inquiry", "They only want a price and avoid every other question."],
  ["rude_or_abusive", "They are rude or abusive toward the bot or the business."],
] as const;

export const CONTACT_FIELD_KEYS = {
  name: "contact_name",
  phone: "contact_phone",
  email: "contact_email",
  address: "job_address",
} as const;
export type ContactDetail = keyof typeof CONTACT_FIELD_KEYS;

const CONTACT_LABELS: Readonly<Record<ContactDetail, string>> = {
  name: "Customer's name",
  phone: "Phone number",
  email: "Email address",
  address: "Street address of the job",
};

const LOCATION_ASK: Readonly<Record<AppSettings["qualification.service_area.ask_for"], string>> = {
  zip_code: "The ZIP code of the job (five digits).",
  city: "The city or town of the job.",
  full_address: "The street address of the job, with city and ZIP code.",
};

function criterion(
  values: AppSettings,
  id: QualificationCriterion,
  spec: Pick<LeadFieldSpec, "type" | "describe"> & {
    readonly options?: readonly string[];
    readonly ask?: boolean;
  },
): LeadFieldSpec[] {
  if (!values[`qualification.${id}.enabled`]) return [];
  return [
    {
      key: id,
      label: CRITERION_LABELS[id],
      group: "criterion",
      type: spec.type,
      ...(spec.options === undefined ? {} : { options: spec.options }),
      describe: spec.describe,
      ask: spec.ask ?? true,
      required: values[`qualification.${id}.required`],
      weight: values[`qualification.${id}.weight`],
    },
  ];
}

function detail(
  key: string,
  label: string,
  type: LeadFieldType,
  describe: string,
  options?: readonly string[],
  ask = false,
): LeadFieldSpec {
  return {
    key,
    label,
    group: "detail",
    type,
    ...(options === undefined ? {} : { options }),
    describe,
    ask,
    required: false,
    weight: 0,
  };
}

const CLAIM_DETAILS: Readonly<
  Record<
    AppSettings["qualification.insurance_claim.details"][number],
    readonly [label: string, type: LeadFieldType, describe: string]
  >
> = {
  claim_status: [
    "Claim status",
    "text",
    "Whether the claim is not filed yet, filed, approved or denied.",
  ],
  insurer: ["Insurance company", "text", "The name of the insurance company."],
  adjuster_visit: ["Adjuster visit", "boolean", "Whether an adjuster has been out to look."],
  claim_number: ["Claim number", "text", "The claim number, if the customer has it at hand."],
  deductible: ["Deductible", "text", "The deductible on the policy, as the customer states it."],
};

/** Every field the conversation may record for this business, in the order to work through. */
export function leadFieldCatalogue(values: AppSettings): LeadFieldSpec[] {
  const fields: LeadFieldSpec[] = [];
  const jobDetails = values["qualification.job_scope.details"];
  const budgetBands = values["qualification.budget.bands"];
  const budgetAsk = values["qualification.budget.ask_mode"];
  const financing = values["qualification.financing.mention"];

  fields.push(
    ...criterion(values, "service_type", {
      type: "text",
      describe:
        "Which service the customer needs, in a few words. Use the business's own name for the service when one fits.",
    }),
  );
  const scope = criterion(values, "job_scope", {
    type: "text",
    describe: `What the job involves and how big it is, as a short summary in plain words.${
      jobDetails.length > 0 ? ` Include, once known: ${jobDetails.join("; ")}.` : ""
    }`,
  });
  fields.push(...scope);
  if (scope.length > 0) {
    fields.push(detail("job_type", "Kind of job", "choice", "The kind of job.", JOB_TYPE_VALUES));
  }
  fields.push(
    ...criterion(values, "service_area", {
      type: "text",
      describe: LOCATION_ASK[values["qualification.service_area.ask_for"]],
    }),
    ...criterion(values, "timeline", {
      type: "choice",
      options: TIMELINE_VALUES,
      describe: "How soon the customer wants the work done.",
    }),
  );
  const decision = criterion(values, "decision_maker", {
    type: "choice",
    options: DECISION_ROLE_VALUES,
    describe:
      "The customer's relation to the property, which tells whether they can approve the work.",
  });
  fields.push(...decision);
  if (decision.length > 0) {
    fields.push(
      detail(
        "other_decision_makers",
        "Others involved in the decision",
        "text",
        "Who else takes part in the decision or has to approve the work (the owner, a spouse, a co-owner, an HOA), and how to reach them when the customer says.",
        undefined,
        values["qualification.decision_maker.ask_about_others"],
      ),
    );
  }
  const budget = criterion(values, "budget", {
    type: "choice",
    options: budgetBands.map((band) => band.key),
    describe: `The budget band the customer's figure falls in: ${budgetBands
      .map((band) => `${band.key} (${band.label})`)
      .join(", ")}.`,
    ask: budgetAsk === "offer_bands" || budgetAsk === "open_question",
  });
  fields.push(...budget);
  if (budget.length > 0) {
    fields.push(
      detail(
        "budget_usd",
        "Stated budget",
        "number",
        "The amount in US dollars the customer named (the upper end when they gave a range).",
      ),
    );
  }
  const property = criterion(values, "property_type", {
    type: "choice",
    options: PROPERTY_TYPE_VALUES,
    describe: "The kind of property the job is at.",
  });
  fields.push(...property);
  if (property.length > 0 && values["qualification.property_type.ask_age"]) {
    fields.push(
      detail(
        "property_age",
        "Age of the home or system",
        "text",
        "Roughly how old the home, the roof or the equipment is, when that matters for the job.",
        undefined,
        true,
      ),
    );
  }
  const claim = criterion(values, "insurance_claim", {
    type: "boolean",
    describe: "Whether the job is to be paid through an insurance claim.",
  });
  fields.push(...claim);
  if (claim.length > 0) {
    for (const id of values["qualification.insurance_claim.details"]) {
      const [label, type, describe] = CLAIM_DETAILS[id];
      fields.push(detail(id, label, type, `${describe} Ask only once a claim is involved.`));
    }
  }
  fields.push(
    ...criterion(values, "financing", {
      type: "boolean",
      describe: "Whether the customer wants to finance the job.",
      ask: financing === "proactively",
    }),
    ...criterion(values, "photos", {
      type: "boolean",
      describe: "Whether the customer has sent photos of the job in this conversation.",
      ask: false,
    }),
  );

  fields.push(
    detail(
      "customer_questions",
      "Open questions",
      "text",
      "Questions the customer asked that could not be answered from the facts, for the team to answer.",
    ),
  );

  const builtIn = new Set(fields.map((field) => field.key));
  const reserved = new Set<string>([
    ...builtIn,
    ...Object.values(CONTACT_FIELD_KEYS),
    ...OBSERVABLE_SIGNALS.map(([key]) => key),
    ...QUALIFICATION_CRITERIA,
  ]);
  for (const custom of values["qualification.custom_criteria"]) {
    // A custom criterion never replaces a built-in field of the same name.
    if (reserved.has(custom.key)) continue;
    reserved.add(custom.key);
    const type: LeadFieldType =
      custom.answer_type === "yes_no"
        ? "boolean"
        : custom.answer_type === "choice" && custom.choices.length > 0
          ? "choice"
          : "text";
    fields.push({
      key: custom.key,
      label: custom.label,
      group: "custom",
      type,
      ...(type === "choice" ? { options: custom.choices } : {}),
      describe: custom.question,
      ask: true,
      required: custom.required,
      weight: custom.weight,
    });
  }

  const contact = new Set<ContactDetail>([
    ...values["qualification.contact_details"],
    ...values["routing.booking_requires"],
    ...values["emergency.collect"],
  ]);
  const asked = new Set<ContactDetail>(values["qualification.contact_details"]);
  for (const id of ["name", "phone", "email", "address"] as const) {
    if (!contact.has(id)) continue;
    fields.push({
      key: CONTACT_FIELD_KEYS[id],
      label: CONTACT_LABELS[id],
      group: "contact",
      type: "text",
      describe: `${CONTACT_LABELS[id]}, exactly as the customer gave it.`,
      ask: asked.has(id),
      required: false,
      weight: 0,
    });
  }

  for (const [key, describe] of OBSERVABLE_SIGNALS) {
    fields.push({
      key,
      label: key.replaceAll("_", " "),
      group: "signal",
      type: "boolean",
      describe,
      ask: false,
      required: false,
      weight: 0,
    });
  }
  return fields;
}

/** True when the lead record holds a usable answer for the field. */
export function isKnown(lead: LeadSnapshot, key: string, minimumConfidence: number): boolean {
  const field = lead.fields[key];
  if (field === undefined || field.value === null) return false;
  return field.confidence >= minimumConfidence;
}

/**
 * The fields still to find out, in the order to ask: required criteria first, then (unless
 * the depth is "light") the other askable fields by weight. Contact details come last here;
 * `qualification.contact_details_timing` decides when the bot actually asks for them.
 */
export function openFields(
  catalogue: readonly LeadFieldSpec[],
  lead: LeadSnapshot,
  values: AppSettings,
): LeadFieldSpec[] {
  const minimum = values["scoring.minimum_confidence"];
  const open = catalogue.filter((field) => field.ask && !isKnown(lead, field.key, minimum));
  const scored = open.filter((field) => field.group === "criterion" || field.group === "custom");
  const required = scored.filter((field) => field.required);
  const optional = scored.filter((field) => !field.required).sort((a, b) => b.weight - a.weight);
  const details = open.filter((field) => field.group === "detail");
  const contact = open.filter((field) => field.group === "contact");
  if (values["qualification.depth"] === "light") return [...required, ...contact];
  return [...required, ...optional, ...details, ...contact];
}

export type NormalizedLeadValue = string | number | boolean | null;

export type LeadValueCheck =
  | { readonly ok: true; readonly value: NormalizedLeadValue }
  | { readonly ok: false; readonly problem: string };

const YES = new Set(["yes", "y", "true"]);
const NO = new Set(["no", "n", "false"]);
const MAX_TEXT = 600;

/**
 * Checks one value against its field and brings it into canonical form: a choice is one of
 * the options, a yes/no is a boolean, a number is a number. Null is always allowed and means
 * "asked, and the customer would not or could not say".
 */
export function normalizeLeadValue(field: LeadFieldSpec, value: unknown): LeadValueCheck {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ok: false, problem: "must be a text, a number, true, false or null" };
  }
  const raw = String(value).trim();
  switch (field.type) {
    case "choice": {
      const options = field.options ?? [];
      const wanted = raw.toLowerCase().replaceAll(/[\s-]+/g, "_");
      const match = options.find((option) => option.toLowerCase() === wanted);
      return match === undefined
        ? { ok: false, problem: `must be one of: ${options.join(", ")}` }
        : { ok: true, value: match };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      const word = raw.toLowerCase();
      if (YES.has(word)) return { ok: true, value: true };
      if (NO.has(word)) return { ok: true, value: false };
      return { ok: false, problem: "must be true or false" };
    }
    case "number": {
      const number = typeof value === "number" ? value : Number(raw.replaceAll(/[$,\s]/g, ""));
      return raw.length > 0 && Number.isFinite(number) && number >= 0
        ? { ok: true, value: number }
        : { ok: false, problem: "must be a number" };
    }
    case "text": {
      if (raw.length === 0) return { ok: false, problem: "must not be empty" };
      return { ok: true, value: raw.slice(0, MAX_TEXT) };
    }
  }
}
