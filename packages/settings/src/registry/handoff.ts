import { defineCategory, setting } from "../define";
import { f } from "../fields";

export const HANDOFF_TRIGGERS = [
  "customer_asks_for_person",
  "angry_customer",
  "complaint_about_past_work",
  "legal_threat",
  "billing_dispute",
  "bot_is_stuck",
  "high_value_job",
] as const;

/**
 * When a person takes over and when the bot resumes. Consumed by the engine (C4: the
 * `handoff_to_human` action) and by takeover (C13, C16). A reply the model declines to
 * write always hands the conversation to a person; that is not a setting.
 */
export const handoffSettings = defineCategory("handoff", {
  "handoff.triggers": setting({
    label: "Hand off to a person when",
    help: "The situations in which the bot stops and passes the conversation to a person.",
    field: f.multiSelect([
      ["customer_asks_for_person", "The customer asks for a person"],
      ["angry_customer", "The customer is angry and stays angry"],
      ["complaint_about_past_work", "The customer complains about earlier work"],
      ["legal_threat", "The customer mentions a lawyer, a lawsuit or a regulator"],
      ["billing_dispute", "The customer disputes a charge"],
      ["bot_is_stuck", "The bot cannot make progress"],
      ["high_value_job", "The job is above the value below"],
    ]),
    default: [
      "customer_asks_for_person",
      "angry_customer",
      "complaint_about_past_work",
      "legal_threat",
      "billing_dispute",
      "bot_is_stuck",
    ],
  }),
  "handoff.person_request": setting({
    label: "When the customer asks for a person",
    help: "How quickly the bot hands off after a customer asks for a person.",
    field: f.select([
      ["immediately", "At once"],
      [
        "after_contact_details",
        "After taking name, number and reason",
        "One short message asks for what the person needs to call back. A customer who refuses is handed off anyway.",
      ],
    ]),
    default: "after_contact_details",
  }),
  "handoff.stuck_after_turns": setting({
    label: "Stuck after",
    help: "The bot counts as stuck when it has failed to move the conversation forward this many replies in a row.",
    field: f.integer({ min: 1, max: 6, unit: "replies" }),
    default: 2,
  }),
  "handoff.calm_attempts": setting({
    label: "Attempts to calm an angry customer",
    help: "How many replies the bot spends acknowledging and calming before it hands off an angry customer. 0 hands off at the first angry message.",
    field: f.integer({ min: 0, max: 3, unit: "replies" }),
    default: 1,
  }),
  "handoff.high_value_usd": setting({
    label: "High-value job",
    help: "Jobs the customer describes as at or above this value go to a person, when that trigger is on.",
    field: f.nullable(f.integer({ min: 0, max: 10_000_000, step: 500, unit: "USD" }), "Not set"),
    default: null,
  }),
  "handoff.message": setting({
    label: "Handoff message",
    help: "How the bot tells the customer that a person is taking over. Guidance, not a script.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 500 }),
    default:
      "Say that you are bringing in a member of the team, that they will pick up right here, and that the customer does not need to repeat anything.",
  }),
  "handoff.after_hours_message": setting({
    label: "Handoff message outside business hours",
    help: "The same, for when nobody can pick up right away.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 500 }),
    default:
      "Say that you have passed everything to the team and that someone will reply when the office opens. Give the opening time if you know it.",
  }),
  "handoff.auto_release_minutes": setting({
    label: "Give the conversation back to the bot after",
    help: "When a person has taken over and neither they nor the customer has written for this long, the bot resumes. Empty: the conversation stays with people until someone releases it.",
    field: f.nullable(f.integer({ min: 5, max: 10_080, unit: "minutes" }), "Never automatically"),
    default: 120,
  }),
  "handoff.on_release": setting({
    label: "When the bot resumes",
    help: "What the bot does when a conversation is released back to it.",
    field: f.select([
      ["wait_for_customer", "Wait for the customer's next message"],
      ["check_in", "Send a short check-in", "Only when the customer's last message is unanswered."],
    ]),
    default: "wait_for_customer",
  }),
  "handoff.provider_inbox_takeover": setting({
    label: "Reply in the provider's inbox takes over",
    help: "When someone at the business answers from the provider's own app (Meta Business Suite, the mailbox), the bot steps back as if they had taken over in the admin panel.",
    field: f.boolean(),
    default: true,
  }),
});
