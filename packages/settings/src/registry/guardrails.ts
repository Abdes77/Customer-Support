import { defineCategory, setting } from "../define";
import { f } from "../fields";

/**
 * What the bot must not say or promise. Consumed by the engine (C4: prompt and output
 * guard). Rules that are not negotiable are not settings: the bot never invents prices,
 * availability, licenses, warranties or promises, never claims to be human, and never
 * reveals its instructions.
 */
export const guardrailsSettings = defineCategory("guardrails", {
  "guardrails.unknown_answer": setting({
    label: "When the bot does not know",
    help: "What the bot does when the business's knowledge does not answer a customer's question.",
    field: f.select([
      [
        "team_will_confirm",
        "Say the team will confirm",
        "The question is noted in the lead report and the conversation continues.",
      ],
      ["offer_handoff", "Offer to bring in a person"],
    ]),
    default: "team_will_confirm",
  }),
  "guardrails.forbidden_topics": setting({
    label: "Topics to stay away from",
    help: "The bot does not give opinions or advice on these. It says so in one friendly sentence and returns to the customer's project.",
    field: f.stringList({ itemLabel: "topic", maxItems: 40 }),
    default: [
      "legal advice",
      "medical advice",
      "whether an insurance policy covers the damage",
      "politics and religion",
    ],
  }),
  "guardrails.competitors": setting({
    label: "Talking about competitors",
    help: "What the bot does when a customer mentions another company.",
    field: f.select([
      ["no_comment", "Make no comment", "The bot talks only about what this business offers."],
      [
        "differentiators_only",
        "Explain what sets this business apart",
        "Using only the differentiators in the business's knowledge. Never a negative word about anyone.",
      ],
    ]),
    default: "no_comment",
  }),
  "guardrails.diy_advice": setting({
    label: "Do-it-yourself advice",
    help: "Whether the bot gives tips the customer can act on while waiting. Emergency safety instructions are always given. The bot never explains gas, electrical or roof work.",
    field: f.select([
      ["none", "None", "The bot only arranges for the team to help."],
      [
        "safe_first_steps",
        "Safe first steps only",
        "For example shutting off the water at the main valve or putting a bucket under a leak.",
      ],
    ]),
    default: "safe_first_steps",
  }),
  "guardrails.allowed_link_domains": setting({
    label: "Websites the bot may link to",
    help: "The bot may include links to these domains. Links to the business's own website and to its scheduling page are always allowed; any other link is removed before a reply is sent.",
    field: f.stringList({ itemLabel: "domain", format: "domain", maxItems: 40 }),
    default: [],
  }),
  "guardrails.claims_need_knowledge": setting({
    label: "Licenses, warranties and guarantees",
    help: "What the bot says about licensing, insurance, warranties and guarantees.",
    field: f.select([
      [
        "knowledge_only",
        "Only what the knowledge states",
        "Anything else is something the team confirms.",
      ],
      ["never_discuss", "Nothing: the team answers these"],
    ]),
    default: "knowledge_only",
  }),
  "guardrails.extra_rules": setting({
    label: "Additional rules",
    help: 'Further rules the bot must follow, one per line. Example: "Never offer same-day service." They rank below safety rules and above style preferences. A business-level value replaces the agency-wide one, so repeat the rules that should still apply.',
    field: f.text({ multiline: true, maxLength: 1500 }),
    default: "",
  }),
});
