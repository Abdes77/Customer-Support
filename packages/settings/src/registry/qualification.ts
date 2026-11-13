import { BUSINESS_ONLY, defineCategory, group, setting, type SettingDraft } from "../define";
import { f } from "../fields";

/**
 * The built-in qualification criteria. Each one has `enabled`, `weight` and `required`
 * settings plus its own options; lead scoring (C5) reads them by these ids, and they are
 * the `key` of a lead field. Agencies add their own with `qualification.custom_criteria`.
 */
export const QUALIFICATION_CRITERIA = [
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
] as const;
export type QualificationCriterion = (typeof QUALIFICATION_CRITERIA)[number];

export const CRITERION_LABELS: Readonly<Record<QualificationCriterion, string>> = {
  service_type: "Service type",
  job_scope: "Job scope",
  service_area: "Service area",
  timeline: "Timeline and urgency",
  decision_maker: "Decision-maker",
  budget: "Budget",
  property_type: "Property type",
  insurance_claim: "Insurance claim",
  financing: "Financing",
  photos: "Photos",
};

export const JOB_TYPES = [
  "repair",
  "replacement",
  "new_installation",
  "maintenance",
  "inspection",
  "remodel",
  "emergency_service",
] as const;

export const TIMELINES = [
  "emergency",
  "this_week",
  "this_month",
  "one_to_three_months",
  "three_to_six_months",
  "later",
  "just_researching",
] as const;

export const DECISION_ROLES = [
  "homeowner",
  "landlord",
  "property_manager",
  "business_owner",
  "tenant_with_permission",
  "tenant",
  "other",
] as const;

export const PROPERTY_TYPES = [
  "single_family",
  "townhouse",
  "condo",
  "multi_family",
  "mobile_home",
  "commercial",
  "new_construction",
] as const;

export const CONTACT_FIELDS = ["name", "phone", "email", "address"] as const;

type CriterionSettings<C extends string> = Readonly<
  Record<`qualification.${C}.enabled`, SettingDraft<boolean>>
> &
  Readonly<Record<`qualification.${C}.weight`, SettingDraft<number>>> &
  Readonly<Record<`qualification.${C}.required`, SettingDraft<boolean>>>;

/** The three settings every criterion has. */
function criterion<const C extends QualificationCriterion>(
  id: C,
  options: {
    readonly what: string;
    readonly enabled: boolean;
    readonly weight: number;
    readonly required: boolean;
  },
): CriterionSettings<C> {
  const label = CRITERION_LABELS[id];
  return {
    [`qualification.${id}.enabled`]: setting({
      label: `${label}: use`,
      help: `Whether the bot finds out ${options.what} and the answer counts toward the lead score.`,
      field: f.boolean(),
      default: options.enabled,
    }),
    [`qualification.${id}.weight`]: setting({
      label: `${label}: weight`,
      help: "How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score.",
      field: f.integer({ min: 0, max: 100, unit: "points" }),
      default: options.weight,
    }),
    [`qualification.${id}.required`]: setting({
      label: `${label}: required`,
      help: "The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing.",
      field: f.boolean(),
      default: options.required,
    }),
  } as CriterionSettings<C>;
}

const ACCEPT = ["accept", "Accept", "No effect on the lead."] as const;
const LOWER_SCORE = ["lower_score", "Lower the score", "The criterion earns no points."] as const;
const CONTACT_LATER = [
  "contact_later",
  "Tell them the team will be in touch",
  "The lead is not booked directly.",
] as const;
const DISQUALIFY = [
  "disqualify",
  "Disqualify politely",
  "The bot closes the conversation with a polite no.",
] as const;
const FIT_ACTIONS = [ACCEPT, LOWER_SCORE, CONTACT_LATER, DISQUALIFY] as const;

const TIMELINE_OPTIONS = [
  ["emergency", "Emergency, right now"],
  ["this_week", "This week"],
  ["this_month", "This month"],
  ["one_to_three_months", "In one to three months"],
  ["three_to_six_months", "In three to six months"],
  ["later", "More than six months out"],
  ["just_researching", "Just researching"],
] as const;

/** Qualification criteria. Consumed by the engine (C4, what to ask) and lead scoring (C5). */
export const qualificationSettings = defineCategory("qualification", {
  ...group("General", {
    "qualification.depth": setting({
      label: "Qualification depth",
      help: "How thoroughly the bot qualifies before it hands off. Light asks only for the required criteria; thorough works through every enabled criterion.",
      field: f.select([
        ["light", "Light", "Required criteria only."],
        ["standard", "Standard", "Required criteria, then the highest-weighted others."],
        ["thorough", "Thorough", "Every enabled criterion."],
      ]),
      default: "standard",
    }),
    "qualification.max_questions": setting({
      label: "Maximum qualification questions",
      help: "After this many qualification questions the bot stops asking and routes the lead with what it knows.",
      field: f.integer({ min: 1, max: 25, unit: "questions" }),
      default: 8,
    }),
    "qualification.questions_per_message": setting({
      label: "Questions per message",
      help: "The most questions the bot asks in one message. One reads like a conversation; two gets through qualification faster.",
      field: f.integer({ min: 1, max: 2, unit: "questions" }),
      default: 2,
    }),
    "qualification.contact_details": setting({
      label: "Contact details to collect",
      help: "The details the bot asks for during the conversation. It never asks again for one the channel already supplies, such as the phone number on WhatsApp.",
      field: f.multiSelect([
        ["name", "Name"],
        ["phone", "Phone number"],
        ["email", "Email address"],
        ["address", "Street address of the job"],
      ]),
      default: ["name", "phone"],
    }),
    "qualification.contact_details_timing": setting({
      label: "When to ask for contact details",
      help: "When in the conversation the bot asks for the details above.",
      field: f.select([
        ["early", "Early", "Right after the first exchange."],
        ["after_interest", "Once the customer is engaged", "After the job is understood."],
        ["before_handoff", "At the end", "Just before booking or handing off."],
      ]),
      default: "after_interest",
    }),
    "qualification.custom_criteria": setting({
      label: "Custom criteria",
      help: "Extra things to find out that are specific to this agency, segment or business, each with its own question and weight. They are scored like the built-in criteria: an answer among the ideal answers earns the full weight.",
      field: f.list(
        f.object({
          key: {
            label: "Key",
            help: "Identifier used in lead reports and CRM field mapping.",
            field: f.text({ format: "slug", minLength: 2, maxLength: 40 }),
          },
          label: { label: "Name", field: f.text({ minLength: 1, maxLength: 60 }) },
          question: {
            label: "Question",
            help: "What the bot should find out, in your own words. The bot phrases it to fit the conversation.",
            field: f.text({ minLength: 1, maxLength: 300 }),
          },
          answer_type: {
            label: "Answer type",
            field: f.select([
              ["text", "Free text"],
              ["yes_no", "Yes or no"],
              ["choice", "One of the listed answers"],
            ]),
          },
          choices: {
            label: "Possible answers",
            help: 'For the answer type "one of the listed answers".',
            field: f.stringList({ itemLabel: "answer", maxItems: 12, maxLength: 80 }),
          },
          ideal_answers: {
            label: "Ideal answers",
            help: 'Answers that earn the full weight. For yes-or-no questions use "yes" or "no".',
            field: f.stringList({ itemLabel: "answer", maxItems: 12, maxLength: 80 }),
          },
          weight: { label: "Weight", field: f.integer({ min: 0, max: 100, unit: "points" }) },
          required: { label: "Required", field: f.boolean() },
        }),
        { itemLabel: "criterion", maxItems: 15, unique: "key" },
      ),
      default: [],
    }),
  }),

  ...group(CRITERION_LABELS.service_type, {
    ...criterion("service_type", {
      what: "which service the customer needs",
      enabled: true,
      weight: 20,
      required: true,
    }),
    "qualification.service_type.offered": setting({
      label: "Services to take leads for",
      help: "Leads for these services are a match. Leave it empty to use the services listed in the business's knowledge.",
      field: f.stringList({ itemLabel: "service", maxItems: 80 }),
      default: [],
      clientEditable: true,
    }),
    "qualification.service_type.not_offered": setting({
      label: "Services to turn away",
      help: "Requests for these services are never a match, even when they are close to something the business does.",
      field: f.stringList({ itemLabel: "service", maxItems: 80 }),
      default: [],
      clientEditable: true,
    }),
    "qualification.service_type.not_offered_action": setting({
      label: "When the service is not offered",
      help: "What happens to a lead who needs a service the business does not take.",
      field: f.select([CONTACT_LATER, DISQUALIFY]),
      default: "disqualify",
    }),
  }),

  ...group(CRITERION_LABELS.job_scope, {
    ...criterion("job_scope", {
      what: "what the job involves and how big it is",
      enabled: true,
      weight: 15,
      required: true,
    }),
    "qualification.job_scope.accepted_types": setting({
      label: "Kinds of job to accept",
      help: "Leads for other kinds of job are handled as the setting below says.",
      field: f.multiSelect(
        [
          ["repair", "Repair"],
          ["replacement", "Replacement"],
          ["new_installation", "New installation"],
          ["maintenance", "Maintenance or tune-up"],
          ["inspection", "Inspection or assessment"],
          ["remodel", "Remodel or renovation"],
          ["emergency_service", "Emergency service"],
        ],
        { minItems: 1 },
      ),
      default: [...JOB_TYPES],
    }),
    "qualification.job_scope.other_type_action": setting({
      label: "When the kind of job is not accepted",
      help: "What happens to a lead whose job is not one of the accepted kinds.",
      field: f.select([LOWER_SCORE, CONTACT_LATER, DISQUALIFY]),
      default: "contact_later",
    }),
    "qualification.job_scope.details": setting({
      label: "Details to collect about the job",
      help: 'Specifics the team needs before a visit, in your own words, for example "approximate roof age" or "number of rooms". The segment playbook\'s questions are used as well.',
      field: f.stringList({ itemLabel: "detail", maxItems: 20, maxLength: 160 }),
      default: [],
      clientEditable: true,
    }),
    "qualification.job_scope.minimum_job_usd": setting({
      label: "Smallest job worth taking",
      help: "Jobs that are clearly smaller than this are handled as the setting below says. The bot never tells the customer this number.",
      field: f.nullable(f.integer({ min: 0, max: 1_000_000, step: 50, unit: "USD" }), "No minimum"),
      default: null,
    }),
    "qualification.job_scope.small_job_action": setting({
      label: "When the job is too small",
      help: "What happens to a lead whose job is below the minimum.",
      field: f.select(FIT_ACTIONS),
      default: "lower_score",
    }),
  }),

  ...group(CRITERION_LABELS.service_area, {
    ...criterion("service_area", {
      what: "where the job is",
      enabled: true,
      weight: 15,
      required: true,
    }),
    "qualification.service_area.ask_for": setting({
      label: "Location to ask for",
      help: "How precisely the bot asks where the job is.",
      field: f.select([
        ["zip_code", "ZIP code"],
        ["city", "City or town"],
        ["full_address", "Full street address"],
      ]),
      default: "zip_code",
    }),
    "qualification.service_area.zip_codes": setting({
      label: "ZIP codes served",
      help: "A lead in one of these ZIP codes is in the service area. If ZIP codes, radius, cities and states are all empty, every location is accepted.",
      field: f.stringList({ itemLabel: "ZIP code", format: "zip", maxItems: 2000 }),
      default: [],
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.excluded_zip_codes": setting({
      label: "ZIP codes not served",
      help: "Always outside the service area, even inside the radius or a served city.",
      field: f.stringList({ itemLabel: "ZIP code", format: "zip", maxItems: 2000 }),
      default: [],
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.radius_miles": setting({
      label: "Service radius",
      help: "A lead within this distance of the center ZIP code is in the service area.",
      field: f.nullable(f.integer({ min: 1, max: 500, unit: "miles" }), "No radius"),
      default: null,
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.center_zip": setting({
      label: "Center of the radius",
      help: "The ZIP code the radius is measured from. Empty uses the ZIP code of the business address.",
      field: f.nullable(f.text({ format: "zip", minLength: 5 }), "Business address"),
      default: null,
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.cities": setting({
      label: "Cities and counties served",
      help: "A lead who names one of these places is in the service area.",
      field: f.stringList({ itemLabel: "place", maxItems: 300 }),
      default: [],
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.states": setting({
      label: "States served",
      help: "A lead outside these states is outside the service area. Empty means no restriction by state.",
      field: f.stringList({ itemLabel: "state", format: "us_state", maxItems: 51 }),
      default: [],
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "qualification.service_area.out_of_area_action": setting({
      label: "When the job is outside the service area",
      help: "What happens to a lead whose job is outside the area.",
      field: f.select(FIT_ACTIONS),
      default: "disqualify",
    }),
  }),

  ...group(CRITERION_LABELS.timeline, {
    ...criterion("timeline", {
      what: "how soon the customer wants the work done",
      enabled: true,
      weight: 15,
      required: true,
    }),
    "qualification.timeline.ideal": setting({
      label: "Ideal timelines",
      help: "Leads who want the work in one of these time frames earn the full weight.",
      field: f.multiSelect(TIMELINE_OPTIONS, { minItems: 1 }),
      default: ["emergency", "this_week", "this_month"],
    }),
    "qualification.timeline.acceptable": setting({
      label: "Acceptable timelines",
      help: "Leads in one of these time frames earn half the weight. Any other time frame earns nothing.",
      field: f.multiSelect(TIMELINE_OPTIONS),
      default: ["one_to_three_months"],
    }),
  }),

  ...group(CRITERION_LABELS.decision_maker, {
    ...criterion("decision_maker", {
      what: "whether the customer can approve the work",
      enabled: true,
      weight: 10,
      required: false,
    }),
    "qualification.decision_maker.accepted_roles": setting({
      label: "Who counts as a decision-maker",
      help: "Leads in one of these roles earn the full weight.",
      field: f.multiSelect(
        [
          ["homeowner", "Homeowner"],
          ["landlord", "Landlord"],
          ["property_manager", "Property manager"],
          ["business_owner", "Business owner"],
          ["tenant_with_permission", "Tenant with the owner's go-ahead"],
          ["tenant", "Tenant"],
          ["other", "Someone else (relative, neighbor, assistant)"],
        ],
        { minItems: 1 },
      ),
      default: ["homeowner", "landlord", "property_manager", "business_owner"],
    }),
    "qualification.decision_maker.not_decision_maker_action": setting({
      label: "When the customer cannot approve the work",
      help: "What happens with renters and others who need someone else's approval.",
      field: f.select([
        ["accept", "Accept", "No effect on the lead."],
        [
          "ask_for_owner",
          "Ask for the owner's contact",
          "The bot asks who decides and how to reach them, then the team follows up.",
        ],
        ["contact_later", "Tell them the team will be in touch"],
        ["disqualify", "Disqualify politely"],
      ]),
      default: "ask_for_owner",
    }),
    "qualification.decision_maker.ask_about_others": setting({
      label: "Ask who else is involved",
      help: "The bot asks whether anyone else takes part in the decision (a spouse, a co-owner, an HOA), so the estimate visit can include them.",
      field: f.boolean(),
      default: false,
    }),
  }),

  ...group(CRITERION_LABELS.budget, {
    ...criterion("budget", {
      what: "what the customer expects to spend",
      enabled: true,
      weight: 10,
      required: false,
    }),
    "qualification.budget.ask_mode": setting({
      label: "How to ask about budget",
      help: "Asking about money early can put customers off; for repairs it is rarely needed, for remodels it usually is.",
      field: f.select([
        ["never", "Never ask", "The bot only notes what the customer says on their own."],
        ["if_raised", "Only when the customer brings up money"],
        ["offer_bands", "Offer the budget bands to pick from"],
        ["open_question", "Ask an open question"],
      ]),
      default: "if_raised",
    }),
    "qualification.budget.bands": setting({
      label: "Budget bands",
      help: "The ranges a budget is sorted into, and how well each fits the business. An ideal band earns the full weight, an acceptable one half, a poor one nothing.",
      field: f.list(
        f.object(
          {
            key: { label: "Key", field: f.text({ format: "slug", minLength: 2, maxLength: 40 }) },
            label: { label: "Label", field: f.text({ minLength: 1, maxLength: 60 }) },
            min_usd: {
              label: "From",
              field: f.nullable(
                f.integer({ min: 0, max: 10_000_000, unit: "USD" }),
                "No lower end",
              ),
            },
            max_usd: {
              label: "To",
              field: f.nullable(
                f.integer({ min: 0, max: 10_000_000, unit: "USD" }),
                "No upper end",
              ),
            },
            fit: {
              label: "Fit",
              field: f.select([
                ["ideal", "Ideal"],
                ["acceptable", "Acceptable"],
                ["poor", "Poor"],
              ]),
            },
          },
          {
            check: (band) =>
              band.min_usd !== null && band.max_usd !== null && band.max_usd <= band.min_usd
                ? [{ path: ["max_usd"], message: "The upper end must be above the lower end." }]
                : [],
          },
        ),
        { itemLabel: "band", minItems: 1, maxItems: 10, unique: "key" },
      ),
      default: [
        { key: "under_1k", label: "Under $1,000", min_usd: null, max_usd: 1000, fit: "acceptable" },
        { key: "up_to_5k", label: "$1,000 to $5,000", min_usd: 1000, max_usd: 5000, fit: "ideal" },
        {
          key: "up_to_15k",
          label: "$5,000 to $15,000",
          min_usd: 5000,
          max_usd: 15_000,
          fit: "ideal",
        },
        {
          key: "up_to_50k",
          label: "$15,000 to $50,000",
          min_usd: 15_000,
          max_usd: 50_000,
          fit: "ideal",
        },
        { key: "over_50k", label: "Over $50,000", min_usd: 50_000, max_usd: null, fit: "ideal" },
      ],
    }),
    "qualification.budget.minimum_usd": setting({
      label: "Minimum budget",
      help: "A lead whose stated budget is below this is handled as the setting below says. The bot never tells the customer this number.",
      field: f.nullable(
        f.integer({ min: 0, max: 10_000_000, step: 100, unit: "USD" }),
        "No minimum",
      ),
      default: null,
    }),
    "qualification.budget.below_minimum_action": setting({
      label: "When the budget is below the minimum",
      help: "What happens to a lead whose budget is below the minimum.",
      field: f.select(FIT_ACTIONS),
      default: "lower_score",
    }),
  }),

  ...group(CRITERION_LABELS.property_type, {
    ...criterion("property_type", {
      what: "what kind of property the job is at",
      enabled: true,
      weight: 5,
      required: false,
    }),
    "qualification.property_type.accepted": setting({
      label: "Property types to accept",
      help: "Leads for these kinds of property earn the full weight.",
      field: f.multiSelect(
        [
          ["single_family", "Single-family home"],
          ["townhouse", "Townhouse"],
          ["condo", "Condo or apartment"],
          ["multi_family", "Multi-family building"],
          ["mobile_home", "Mobile or manufactured home"],
          ["commercial", "Commercial property"],
          ["new_construction", "New construction"],
        ],
        { minItems: 1 },
      ),
      default: ["single_family", "townhouse", "condo", "multi_family"],
    }),
    "qualification.property_type.other_action": setting({
      label: "When the property type is not accepted",
      help: "What happens to a lead whose property is of another kind.",
      field: f.select(FIT_ACTIONS),
      default: "contact_later",
    }),
    "qualification.property_type.ask_age": setting({
      label: "Ask how old the home or system is",
      help: "The bot asks roughly how old the home, roof or equipment is when that matters for the job.",
      field: f.boolean(),
      default: false,
    }),
  }),

  ...group(CRITERION_LABELS.insurance_claim, {
    ...criterion("insurance_claim", {
      what: "whether an insurance claim is involved",
      enabled: false,
      weight: 5,
      required: false,
    }),
    "qualification.insurance_claim.preference": setting({
      label: "Insurance work",
      help: "How a job paid through an insurance claim fits the business.",
      field: f.select([
        ["prefer", "Preferred", "A claim earns the full weight, no claim half."],
        ["neutral", "Neutral", "Either answer earns the full weight."],
        ["avoid", "Avoided", "A claim earns nothing."],
      ]),
      default: "neutral",
    }),
    "qualification.insurance_claim.details": setting({
      label: "Claim details to collect",
      help: "What the bot asks once the customer says a claim is involved.",
      field: f.multiSelect([
        ["claim_status", "Whether the claim is filed, approved or denied"],
        ["insurer", "Insurance company"],
        ["adjuster_visit", "Whether an adjuster has been out"],
        ["claim_number", "Claim number"],
        ["deductible", "Deductible"],
      ]),
      default: ["claim_status", "insurer"],
    }),
  }),

  ...group(CRITERION_LABELS.financing, {
    ...criterion("financing", {
      what: "whether the customer wants to finance the job",
      enabled: false,
      weight: 5,
      required: false,
    }),
    "qualification.financing.mention": setting({
      label: "Mentioning financing",
      help: "Whether the bot brings up financing. It only describes plans that are in the business's knowledge and never promises approval.",
      field: f.select([
        ["never", "Never"],
        ["when_asked", "Only when the customer asks"],
        ["proactively", "Proactively, when price comes up"],
      ]),
      default: "when_asked",
    }),
    "qualification.financing.interest_effect": setting({
      label: "Effect of financing interest",
      help: "How a customer who wants financing is scored.",
      field: f.select([
        ["positive", "Positive", "Interest earns the full weight, no interest half."],
        ["neutral", "Neutral", "Either answer earns the full weight."],
        ["negative", "Negative", "Interest earns nothing."],
      ]),
      default: "neutral",
    }),
  }),

  ...group(CRITERION_LABELS.photos, {
    ...criterion("photos", {
      what: "whether the customer has sent photos of the job (see the Photos category for when the bot asks)",
      enabled: true,
      weight: 5,
      required: false,
    }),
  }),
});
