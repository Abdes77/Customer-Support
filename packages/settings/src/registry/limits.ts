import { defineCategory, GLOBAL_ONLY, setting } from "../define";
import { f } from "../fields";

/**
 * Rate limits and spend caps. Consumed by the pipeline's limits guard (C17,
 * `packages/pipeline/src/limits`); the widget's own limits are used by C8. A limit that is hit
 * never drops a message: the message is stored and shown in the inbox, only the bot's reply
 * is withheld, the customer gets `limits.notice_message` (at most once an hour, always with
 * the instruction to call 911) and the agency an alert. A message that may describe an
 * emergency is still answered, a few times a day. The longest conversation
 * (`conversation.max_bot_replies`) is handled the same way.
 */
export const limitsSettings = defineCategory("limits", {
  "limits.contact_messages_per_hour": setting({
    label: "Messages answered per customer per hour",
    help: "Messages beyond this from one customer in an hour are stored but not answered by the bot.",
    field: f.integer({ min: 5, max: 500, unit: "messages" }),
    default: 60,
  }),
  "limits.contact_replies_per_day": setting({
    label: "Bot replies per customer per day",
    help: "The most replies the bot writes to one customer in a day.",
    field: f.integer({ min: 5, max: 500, unit: "replies" }),
    default: 100,
  }),
  "limits.business_replies_per_day": setting({
    label: "Bot replies per business per day",
    help: "The most replies the bot writes for one business in a day.",
    field: f.nullable(f.integer({ min: 10, max: 100_000, unit: "replies" }), "No limit"),
    default: 3000,
  }),
  "limits.contact_daily_spend_usd": setting({
    label: "Model spend per customer per day",
    help: "When the model cost of one customer's conversations reaches this in a day, the bot stops replying to them until the next day.",
    field: f.nullable(f.number({ min: 0.1, max: 1000, step: 0.5, unit: "USD" }), "No cap"),
    default: 5,
  }),
  "limits.business_daily_spend_usd": setting({
    label: "Model spend per business per day",
    help: "When the model cost of one business reaches this in a day, the bot pauses for that business until the next day.",
    field: f.nullable(f.number({ min: 1, max: 100_000, step: 5, unit: "USD" }), "No cap"),
    default: 100,
  }),
  "limits.business_monthly_spend_usd": setting({
    label: "Model spend per business per month",
    help: "When the model cost of one business reaches this in a calendar month, the bot pauses for that business until the next month.",
    field: f.nullable(f.number({ min: 1, max: 1_000_000, step: 50, unit: "USD" }), "No cap"),
    default: null,
  }),
  "limits.agency_daily_spend_usd": setting({
    label: "Model spend for the whole agency per day",
    help: "When the model cost across all businesses reaches this in a day, the bot pauses everywhere until the next day.",
    field: f.nullable(f.number({ min: 1, max: 1_000_000, step: 50, unit: "USD" }), "No cap"),
    default: null,
    scopes: GLOBAL_ONLY,
  }),
  "limits.on_limit": setting({
    label: "When a limit is reached",
    help: "What happens to conversations that hit a limit or a spend cap. The agency is alerted in both cases.",
    field: f.select([
      ["pause_bot", "Pause the bot", "Messages wait in the inbox."],
      ["handoff", "Hand the conversations to people"],
    ]),
    default: "pause_bot",
  }),
  "limits.notice_message": setting({
    label: "Message when a limit stops the bot",
    help: 'Sent to a customer whose conversation a limit or spend cap has stopped, at most once an hour while they keep writing, so nobody is left without an answer. The sentence "If anyone is in danger right now, call 911." is added when the message does not mention 911, and is sent alone when the message is empty. A message that may describe an emergency is still answered by the bot, with its safety instructions, a few times a day.',
    field: f.text({ maxLength: 400, multiline: true }),
    default:
      "Thanks for your message. Our team will get back to you as soon as they can. If anyone is in danger right now, call 911.",
  }),
  "limits.max_inbound_characters": setting({
    label: "Longest customer message",
    help: "The bot reads this much of a single customer message; the rest is kept in the inbox but not given to the model.",
    field: f.integer({ min: 500, max: 50_000, step: 500, unit: "characters" }),
    default: 6000,
  }),
  "limits.widget_messages_per_minute": setting({
    label: "Website chat: messages per visitor per minute",
    help: "A visitor who sends more than this in a minute is asked to slow down.",
    field: f.integer({ min: 3, max: 120, unit: "messages" }),
    default: 12,
  }),
  "limits.widget_messages_per_business_per_minute": setting({
    label: "Website chat: messages per business per minute",
    help: "The most website-chat messages the business accepts in a minute from all visitors together. Visitors beyond it are asked to try again shortly.",
    field: f.integer({ min: 10, max: 10_000, unit: "messages" }),
    default: 300,
  }),
  "limits.widget_photos_per_visitor_per_hour": setting({
    label: "Website chat: photos per visitor per hour",
    help: "The most photos one website-chat visitor can send in an hour. Stops a single visitor from filling the business's storage.",
    field: f.integer({ min: 1, max: 200, unit: "photos" }),
    default: 20,
  }),
  "limits.widget_sessions_per_ip_per_hour": setting({
    label: "Website chat: new visitors per address per hour",
    help: "The most new chat sessions from one network address in an hour.",
    field: f.integer({ min: 1, max: 1000, unit: "sessions" }),
    default: 30,
  }),
});
