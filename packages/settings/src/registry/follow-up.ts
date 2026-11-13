import {
  type CustomerChannel,
  defineCategory,
  GLOBAL_AND_BUSINESS,
  group,
  perChannel,
  setting,
} from "../define";
import { f } from "../fields";

const MAX_NUDGES: Readonly<Record<CustomerChannel, number>> = {
  whatsapp: 2,
  instagram: 2,
  messenger: 2,
  widget: 1,
  email: 3,
};

/** Minutes to wait before each nudge, counted from the last message of the conversation. */
const NUDGE_DELAYS: Readonly<Record<CustomerChannel, number[]>> = {
  // The first two stay inside the 24-hour window that starts with the customer's last message.
  whatsapp: [120, 1200],
  instagram: [120, 1200],
  messenger: [120, 1200],
  widget: [5],
  email: [1440, 4320, 10_080],
};

/**
 * Nudges to customers who stopped replying. Consumed by follow-ups (C13). Nudges always
 * stop when the customer replies, opts out or books; they respect quiet hours and each
 * channel's messaging window.
 */
export const followUpSettings = defineCategory("follow_up", {
  "follow_up.enabled": setting({
    label: "Follow-ups",
    help: "The bot nudges customers who stop replying before the conversation has reached an outcome.",
    field: f.boolean(),
    default: true,
  }),
  ...group(
    "Number of nudges",
    perChannel("follow_up.max_nudges", (channel, channelLabel) => ({
      label: `Nudges on ${channelLabel}`,
      help: `The most nudges one silent customer gets on ${channelLabel}. 0 switches follow-ups off for this channel.`,
      field: f.integer({ min: 0, max: 8, unit: "nudges" }),
      default: MAX_NUDGES[channel],
    })),
  ),
  ...group(
    "Cadence",
    perChannel("follow_up.delays_minutes", (channel, channelLabel) => ({
      label: `Cadence on ${channelLabel}`,
      help: `How long to wait before each nudge on ${channelLabel}: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats.`,
      field: f.list(f.integer({ min: 1, max: 43_200, unit: "minutes" }), {
        itemLabel: "wait",
        minItems: 1,
        maxItems: 8,
      }),
      default: NUDGE_DELAYS[channel],
    })),
  ),
  "follow_up.send_window": setting({
    label: "When nudges may be sent",
    help: "Nudges that fall outside this window wait for the next allowed moment.",
    field: f.select([
      ["outside_quiet_hours", "Any time outside quiet hours"],
      ["business_hours", "During business hours only"],
    ]),
    default: "outside_quiet_hours",
  }),
  "follow_up.guidance": setting({
    label: "How to nudge",
    help: "How the bot writes a nudge. Every nudge is written fresh from the conversation; no two are alike.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 800 }),
    default:
      "Pick up exactly where the conversation stopped. Mention the customer's project in a few words, add one thing that is useful to them, and ask one question that is easy to answer in a word or two. Never guilt, never pressure, never repeat an earlier nudge.",
  }),
  "follow_up.last_nudge_says_so": setting({
    label: "Announce the last nudge",
    help: "The final nudge says that it is the last message and how to get back in touch.",
    field: f.boolean(),
    default: true,
  }),
  "follow_up.after_outcome": setting({
    label: 'Nudge after a "we\'ll contact you"',
    help: "Whether a customer who was told the team will be in touch, and then asked something the bot answered, is still nudged when they go quiet.",
    field: f.boolean(),
    default: false,
  }),
  "follow_up.opt_out_scope": setting({
    label: "What an opt-out stops",
    help: 'Which messages stop for a customer who sent an opt-out word, until they send an opt-back-in word. Nudges, reminders and check-ins stop either way, and a customer who reports an emergency always gets the safety instructions and the emergency alerts. With "every automated message" the bot does not answer anything else they write, and the team is alerted instead.',
    field: f.select([
      ["all_automated", "Every automated message, including the bot's answers"],
      ["proactive_only", "Only messages the bot starts (the bot still answers them)"],
    ]),
    default: "all_automated",
    scopes: GLOBAL_AND_BUSINESS,
  }),
  "follow_up.opt_out_keywords": setting({
    label: "Opt-out words",
    help: 'A message that consists of one of these words opts the customer out, on every channel of the business. "What an opt-out stops" decides which messages stop.',
    field: f.stringList({ itemLabel: "word", minItems: 1, maxItems: 40, maxLength: 40 }),
    default: ["stop", "unsubscribe", "cancel", "quit", "end", "opt out", "remove me"],
    scopes: GLOBAL_AND_BUSINESS,
  }),
  "follow_up.opt_in_keywords": setting({
    label: "Opt-back-in words",
    help: "A message that consists of one of these words lifts an earlier opt-out.",
    field: f.stringList({ itemLabel: "word", minItems: 1, maxItems: 40, maxLength: 40 }),
    default: ["start", "unstop", "subscribe"],
    scopes: GLOBAL_AND_BUSINESS,
  }),
  "follow_up.opt_out_confirmation": setting({
    label: "Opt-out confirmation",
    help: "The one message a customer gets after opting out.",
    field: f.text({ minLength: 1, maxLength: 300 }),
    default: "You won't get any more messages from us. Reply START if you change your mind.",
  }),
});
