import { businessHoursState } from "@repo/ai";
import {
  type AnyField,
  type AppSettings,
  findSetting,
  renderTemplate,
  type SettingKey,
  settingsChannelOf,
} from "@repo/settings";

import type { Scenario } from "../scenarios/types";

/**
 * The rules in force for one scenario, in plain words, for the judge and the report.
 *
 * They are written from the settings registry (the label, the chosen option and its
 * description, exactly what the agency sees on the settings screen) and the values of the
 * scenario's snapshot. They are deliberately not taken from the prompt the bot receives:
 * the judge checks the bot against what the business configured, so a mistake in how the
 * prompt words a setting shows up as a compliance failure instead of being graded as correct.
 */

export const RULE_IDS = [
  "pricing",
  "ai_disclosure",
  "persona",
  "voice",
  "length",
  "first_message",
  "qualification",
  "photos",
  "boundaries",
  "conversation",
  "emergency",
  "hours",
  "handoff",
  "routing",
  "follow_up",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface RuleInForce {
  readonly id: RuleId;
  readonly title: string;
  /** The settings the rule is made of. */
  readonly settings: readonly SettingKey[];
  readonly text: string;
}

/** The template variables a setting text may carry, filled for this business. */
export function templateValues(scenario: Scenario): Record<string, string> {
  const values = scenario.settings.values;
  return {
    business_name: scenario.business.name,
    business_phone: scenario.business.contact.phone,
    business_website: scenario.business.contact.websiteUrl,
    bot_name: values["persona.bot_name"],
    timeframe: values["routing.contact_later_timeframe"],
  };
}

export function fill(scenario: Scenario, template: string): string {
  return renderTemplate(template, templateValues(scenario));
}

function valueText(field: AnyField, value: unknown, fillText: (text: string) => string): string {
  switch (field.kind) {
    case "boolean":
      return value === true ? "yes" : "no";
    case "number":
      return `${String(value)}${field.unit === null ? "" : ` ${field.unit}`}`;
    case "text": {
      const text = typeof value === "string" ? fillText(value).trim() : "";
      return text.length === 0 ? "(empty)" : `"${text}"`;
    }
    case "select": {
      const option = field.options.find((item) => item.value === value);
      if (option === undefined) return String(value);
      return option.description === undefined
        ? option.label
        : `${option.label}. ${option.description}`;
    }
    case "multi_select": {
      const chosen = Array.isArray(value) ? value : [];
      if (chosen.length === 0) return "(none)";
      return chosen
        .map((item) => field.options.find((option) => option.value === item)?.label ?? String(item))
        .join("; ");
    }
    case "nullable":
      return value === null ? field.nullLabel : valueText(field.inner, value, fillText);
    case "list": {
      const items = Array.isArray(value) ? value : [];
      if (items.length === 0) return "(none)";
      return items.map((item) => valueText(field.item, item, fillText)).join("; ");
    }
    case "object": {
      const record = (value ?? {}) as Record<string, unknown>;
      return `{${field.properties
        .map(
          (property) =>
            `${property.label}: ${valueText(property.field, record[property.name], fillText)}`,
        )
        .join(", ")}}`;
    }
    default:
      return JSON.stringify(value);
  }
}

/** One setting as a line: its label on the settings screen and the value in force. */
export function settingLine(scenario: Scenario, key: SettingKey): string {
  const definition = findSetting(key);
  const value = (scenario.settings.values as Record<string, unknown>)[key];
  if (definition === undefined) return `${key}: ${JSON.stringify(value)}`;
  const text = valueText(definition.field, value, (template) => fill(scenario, template));
  // The help text says what a free-form value is for; an option explains itself.
  const help =
    definition.field.kind === "select" || definition.field.kind === "multi_select"
      ? ""
      : ` (${definition.help})`;
  return `- ${definition.label}${help}: ${text}`;
}

function channelKey<B extends string>(scenario: Scenario, base: B): SettingKey {
  return `${base}.${settingsChannelOf(scenario.channel)}` as SettingKey;
}

function emergencyClasses(values: AppSettings): string {
  return values["emergency.classes"]
    .filter((item) => item.enabled)
    .map(
      (item) =>
        `- ${item.key} (${item.label}; ${item.severity === "life_safety" ? "danger to life: the reply must START with these instructions" : "urgent: the reply must contain these instructions"}): "${item.safety_instructions}"`,
    )
    .join("\n");
}

/** Whether the business's office was open when the conversation started. */
export function officeOpenAtStart(scenario: Scenario): boolean {
  return businessHoursState(
    scenario.settings.values,
    scenario.business.timezone,
    new Date(scenario.startAt),
  ).open;
}

export function rulesInForce(scenario: Scenario): RuleInForce[] {
  const values = scenario.settings.values;
  const line = (key: SettingKey) => settingLine(scenario, key);
  const rule = (
    id: RuleId,
    title: string,
    settings: readonly SettingKey[],
    extra: readonly (string | null)[] = [],
  ): RuleInForce => ({
    id,
    title,
    settings,
    text: [...settings.map(line), ...extra.filter((item) => item !== null)].join("\n"),
  });
  const hasCalendar = scenario.profile.slots.length > 0;

  return [
    rule(
      "pricing",
      "Prices",
      [
        "pricing.disclosure",
        "pricing.use_playbook_ranges",
        "pricing.deflection_guidance",
        "pricing.disclaimer",
        "pricing.estimate_policy",
        "pricing.estimate_fee_usd",
        "pricing.service_call_fee_usd",
        "pricing.promotions",
        "pricing.negotiation",
      ],
      [
        "- In every mode: the bot never states, estimates, rounds or confirms a price that is not in the business's facts, in these settings or among the playbook price ranges it is allowed to use. Repeating back a budget the customer named is not stating a price.",
      ],
    ),
    rule(
      "ai_disclosure",
      "Saying that it is an AI",
      ["persona.ai_disclosure", "persona.ai_disclosure_wording", "persona.ai_question_answer"],
      ["- In every mode: the bot never claims to be a person, and answers truthfully when asked."],
    ),
    rule("persona", "Persona", [
      "persona.bot_name",
      "persona.role_title",
      "persona.speaks_as",
      "persona.description",
    ]),
    rule("voice", "Voice", [
      "voice.tone",
      "voice.style_notes",
      "voice.reading_level",
      "voice.emoji",
      "voice.use_customer_name",
      "voice.humor",
      "voice.banned_phrases",
    ]),
    rule(
      "length",
      "Length and pace",
      [
        "voice.reply_length",
        channelKey(scenario, "voice.max_reply_characters"),
        "voice.max_messages_per_turn",
        "qualification.questions_per_message",
        "qualification.max_questions",
      ],
      [
        "- Character, message and question counts are verified by code (see the automatic checks); judge here whether the length suits the customer and the channel.",
      ],
    ),
    rule(
      "first_message",
      "First message",
      [channelKey(scenario, "voice.opening_message")],
      [
        scenario.channel === "widget"
          ? "- On the website chat this greeting is shown by the chat window before the visitor writes; the bot must not greet again."
          : "- When this text is not empty, the bot's first message starts with it, except in an emergency.",
      ],
    ),
    rule("qualification", "Qualification", [
      "qualification.depth",
      "qualification.contact_details",
      "qualification.contact_details_timing",
      "qualification.budget.ask_mode",
      "qualification.decision_maker.not_decision_maker_action",
      "qualification.service_area.out_of_area_action",
    ]),
    rule("photos", "Photos", [
      "photos.request_mode",
      "photos.request_timing",
      "photos.max_requests",
      "photos.analysis_enabled",
      "photos.share_findings",
    ]),
    rule("boundaries", "What the bot may claim and discuss", [
      "guardrails.unknown_answer",
      "guardrails.claims_need_knowledge",
      "guardrails.forbidden_topics",
      "guardrails.competitors",
      "guardrails.diy_advice",
      "guardrails.extra_rules",
    ]),
    rule("conversation", "Difficult conversations", [
      "conversation.off_topic",
      "conversation.spam",
      "conversation.existing_customer_requests",
      "conversation.other_language",
      "conversation.profanity",
    ]),
    rule(
      "emergency",
      "Emergencies",
      [
        "emergency.enabled",
        "emergency.service_level",
        "emergency.customer_instruction",
        "emergency.phone",
        "emergency.collect",
        "emergency.vulnerable_people",
        "emergency.after_hours_note",
      ],
      [
        "- The emergency classes of this business and their safety instructions, which the reply must carry word for word:",
        emergencyClasses(values),
        "- After the safety instructions the bot says only what these settings allow, asks only for the details listed above, and promises no arrival time it was not given.",
      ],
    ),
    rule(
      "hours",
      "Office hours",
      ["hours.after_hours_mode", "hours.after_hours_message", "routing.after_hours_booking"],
      [
        `- When this conversation started the office was ${officeOpenAtStart(scenario) ? "open" : "closed"}. Emergencies are handled at any hour, whatever the after-hours mode says.`,
      ],
    ),
    rule("handoff", "Handing over to a person", [
      "handoff.triggers",
      "handoff.person_request",
      "handoff.stuck_after_turns",
      "handoff.calm_attempts",
      "handoff.message",
      "handoff.after_hours_message",
    ]),
    rule(
      "routing",
      "Routing: what the customer is told once the lead is scored",
      [
        "routing.mode",
        "routing.hot_outcome",
        "routing.warm_outcome",
        "routing.cold_outcome",
        "routing.booking_requires",
        "routing.booking_unavailable_outcome",
        "routing.existing_customer_outcome",
        "routing.contact_later_timeframe",
        "routing.contact_later_guidance",
        "routing.disqualify_guidance",
        "routing.disqualify_referral",
        "scheduling.meeting_type",
      ],
      [
        hasCalendar
          ? `- A calendar is connected in this scenario. The times the bot may offer are exactly these: ${scenario.profile.slots.map((slot) => slot.label).join("; ")}.`
          : "- No calendar is connected in this scenario: the bot's request for times is refused, and it must then follow the rule for when booking is not possible. It may not name a day or time for a visit.",
        "- The bot never reveals scores, bands, criteria or the fact that a decision is being made.",
      ],
    ),
    rule("follow_up", "Follow-ups to a customer who went quiet", [
      "follow_up.enabled",
      "follow_up.guidance",
      "follow_up.last_nudge_says_so",
      channelKey(scenario, "follow_up.max_nudges"),
    ]),
  ];
}
