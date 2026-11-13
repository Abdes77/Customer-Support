import { type CustomerChannel, defineCategory, group, perChannel, setting } from "../define";
import { f } from "../fields";

const REPLY_WAIT_SECONDS: Readonly<Record<CustomerChannel, number>> = {
  whatsapp: 8,
  instagram: 8,
  messenger: 8,
  widget: 4,
  email: 120,
};

/**
 * Reply timing, conversation limits and unusual messages. Consumed by the message pipeline
 * (C3: wait, read receipts, typing, limits) and the engine (C4: the rest).
 */
export const conversationSettings = defineCategory("conversation", {
  ...group(
    "Reply wait",
    perChannel("conversation.reply_wait_seconds", (channel, channelLabel) => ({
      label: `Wait before replying on ${channelLabel}`,
      help: `How long the bot waits after a customer's message on ${channelLabel} before it answers, so that several quick messages get one reply. Each new message restarts the wait.`,
      field: f.integer({ min: 0, max: 900, unit: "seconds" }),
      default: REPLY_WAIT_SECONDS[channel],
    })),
  ),
  "conversation.max_wait_seconds": setting({
    label: "Longest wait",
    help: "A customer who keeps typing is answered after this long at the latest, counted from their first unanswered message.",
    field: f.integer({ min: 5, max: 1800, unit: "seconds" }),
    default: 180,
  }),
  "conversation.typing_indicator": setting({
    label: "Show typing",
    help: "The bot shows that it is typing while a reply is being written, on channels that support it.",
    field: f.boolean(),
    default: true,
  }),
  "conversation.mark_as_read": setting({
    label: "Mark messages as read",
    help: "Customer messages are marked as read when the bot starts on its reply, on channels that support it.",
    field: f.boolean(),
    default: true,
  }),
  "conversation.max_bot_replies": setting({
    label: "Longest conversation",
    help: "After this many bot replies in one conversation the bot stops and hands it to a person, so a conversation cannot run on forever. The customer is told (the message when a limit stops the bot), the team is alerted, and a message that may describe an emergency is still answered.",
    field: f.integer({ min: 5, max: 200, unit: "replies" }),
    default: 40,
  }),
  "conversation.history_messages": setting({
    label: "Messages the bot rereads",
    help: "How many of the most recent messages the bot reads before each reply. Older ones are covered by the lead record. Higher is safer for long conversations and costs more.",
    field: f.integer({ min: 10, max: 400, unit: "messages" }),
    default: 80,
  }),
  "conversation.idle_close_hours": setting({
    label: "Close idle conversations after",
    help: "A conversation with no message from either side for this long is closed. A customer who writes again later starts a new conversation that still knows the lead.",
    field: f.integer({ min: 1, max: 2160, unit: "hours" }),
    default: 168,
  }),
  "conversation.off_topic": setting({
    label: "Off-topic messages",
    help: "What the bot does with questions that have nothing to do with the business.",
    field: f.select([
      ["redirect", "Steer back politely", "One friendly sentence, then back to the project."],
      [
        "brief_answer_then_redirect",
        "Answer briefly, then steer back",
        "Only for harmless small talk; never for the topics under Guardrails.",
      ],
    ]),
    default: "redirect",
  }),
  "conversation.spam": setting({
    label: "Spam",
    help: "What the bot does with obvious spam, scams and bulk advertising.",
    field: f.select([
      ["no_reply", "Do not reply"],
      ["one_polite_reply", "Reply once, then stop"],
    ]),
    default: "no_reply",
  }),
  "conversation.existing_customer_requests": setting({
    label: "Questions about existing jobs",
    help: "What the bot does when a current customer asks about a job in progress, an invoice or an appointment that it has no information about.",
    field: f.select([
      [
        "take_message",
        "Take a message",
        "The bot notes the request, alerts the team and says who will get back and when.",
      ],
      ["handoff", "Hand the conversation to a person"],
    ]),
    default: "take_message",
  }),
  "conversation.other_language": setting({
    label: "Messages in another language",
    help: "The bot writes English only. This sets what happens when a customer writes in another language.",
    field: f.select([
      [
        "reply_in_english",
        "Reply in simple English",
        "The bot says once that it can help in English and keeps its wording simple.",
      ],
      ["handoff", "Hand the conversation to a person"],
    ]),
    default: "reply_in_english",
  }),
  "conversation.profanity": setting({
    label: "Abusive messages",
    help: "What the bot does when a customer is abusive toward it, as opposed to upset about a problem.",
    field: f.select([
      ["stay_calm", "Stay calm and carry on", "The bot ignores the abuse and keeps offering help."],
      [
        "warn_then_end",
        "Ask once for civility, then end",
        "After a second abusive message the bot ends the conversation politely.",
      ],
    ]),
    default: "stay_calm",
  }),
});
