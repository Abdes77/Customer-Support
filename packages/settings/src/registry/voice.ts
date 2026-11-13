import { type CustomerChannel, defineCategory, group, perChannel, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

const MAX_REPLY_CHARACTERS: Readonly<Record<CustomerChannel, number>> = {
  whatsapp: 600,
  instagram: 500,
  messenger: 500,
  widget: 500,
  email: 2500,
};

const OPENING_MESSAGES: Readonly<Record<CustomerChannel, string>> = {
  whatsapp: "",
  instagram: "",
  messenger: "",
  widget: "Hi! Thanks for stopping by {{business_name}}. What can we help you with today?",
  email: "",
};

/** Tone, reading level, length, emoji and opening messages. Consumed by the engine (C4). */
export const voiceSettings = defineCategory("voice", {
  "voice.tone": setting({
    label: "Tone",
    help: "The overall tone of the bot's replies.",
    field: f.select([
      ["friendly", "Friendly", "Warm and approachable, like a helpful neighbor."],
      ["professional", "Professional", "Polite and businesslike, without small talk."],
      ["casual", "Casual", "Relaxed and conversational."],
      ["empathetic", "Empathetic", "Reassuring; acknowledges stress before anything else."],
      ["direct", "Direct", "Brief and to the point."],
      ["upbeat", "Upbeat", "Energetic and positive."],
    ]),
    default: "friendly",
    clientEditable: true,
  }),
  "voice.style_notes": setting({
    label: "Style notes",
    help: "Extra guidance on how the bot should sound, in your own words: regional phrases, things the owner always says, things to avoid. Example: \"Say 'y'all'. Never say 'unfortunately'.\"",
    field: f.text({ multiline: true, maxLength: 1200 }),
    default: "",
    clientEditable: true,
  }),
  "voice.reading_level": setting({
    label: "Reading level",
    help: "How simple the wording is. Trade terms are always explained in plain words at the simple and standard levels.",
    field: f.select([
      ["simple", "Simple", "Short words and short sentences (about grade 5)."],
      ["standard", "Standard", "Everyday language (about grade 8)."],
      ["advanced", "Advanced", "Fuller sentences and trade vocabulary where it helps."],
    ]),
    default: "standard",
  }),
  "voice.reply_length": setting({
    label: "Reply length",
    help: "How much the bot writes in a chat reply. Emails are written as proper emails regardless; the character limits below are the hard cap.",
    field: f.select([
      ["brief", "Brief", "One or two short sentences."],
      ["balanced", "Balanced", "Two to four sentences."],
      ["detailed", "Detailed", "A short paragraph when the question needs it."],
    ]),
    default: "brief",
  }),
  ...group(
    "Maximum reply length",
    perChannel("voice.max_reply_characters", (channel, channelLabel) => ({
      label: `Longest reply on ${channelLabel}`,
      help: `Hard limit for one reply on ${channelLabel}, in characters. A draft over the limit is rewritten shorter before it is sent.`,
      field: f.integer({ min: 80, max: 6000, step: 20, unit: "characters" }),
      default: MAX_REPLY_CHARACTERS[channel],
    })),
  ),
  "voice.max_messages_per_turn": setting({
    label: "Messages per reply",
    help: "How many separate chat messages the bot may send in a row when answering (for example a short answer, then a question). Email always gets one.",
    field: f.integer({ min: 1, max: 3 }),
    default: 2,
  }),
  "voice.emoji": setting({
    label: "Emoji",
    help: "How often the bot uses emoji in chat. Emails and emergency replies never contain emoji.",
    field: f.select([
      ["never", "Never"],
      ["sparingly", "Sparingly", "At most one, and only where it feels natural."],
      ["freely", "Freely"],
    ]),
    default: "sparingly",
    clientEditable: true,
  }),
  "voice.use_customer_name": setting({
    label: "Use the customer's name",
    help: "How often the bot addresses the customer by first name once it knows it.",
    field: f.select([
      ["never", "Never"],
      ["sometimes", "Sometimes", "In greetings and at important moments."],
      ["often", "Often"],
    ]),
    default: "sometimes",
  }),
  "voice.humor": setting({
    label: "Humor",
    help: "Whether the bot may make a light remark when the customer's mood invites it. It never jokes about a customer's problem, and never in an emergency.",
    field: f.select([
      ["none", "None"],
      ["light", "Light"],
    ]),
    default: "none",
  }),
  "voice.banned_phrases": setting({
    label: "Words and phrases to avoid",
    help: "The bot never uses these words or phrases. A reply that contains one is rewritten before it is sent.",
    field: f.stringList({ itemLabel: "phrase", maxItems: 100 }),
    default: [],
    clientEditable: true,
  }),
  ...group(
    "Opening message",
    perChannel("voice.opening_message", (channel, channelLabel) => ({
      label: `Opening message on ${channelLabel}`,
      help:
        channel === "widget"
          ? "The first message a visitor sees when they open the website chat, before they have written anything."
          : `If set, the bot's first reply in a new ${channelLabel} conversation starts with this text and then answers what the customer wrote. Leave it empty to let the bot write its own greeting.`,
      field: f.text({
        multiline: true,
        maxLength: 500,
        variables: variables("business_name", "bot_name"),
      }),
      default: OPENING_MESSAGES[channel],
      clientEditable: true,
    })),
  ),
  "voice.closing_message": setting({
    label: "Closing message",
    help: "How the bot signs off when a conversation is finished. Leave it empty to let the bot close in its own words.",
    field: f.text({
      multiline: true,
      maxLength: 400,
      variables: variables("business_name", "bot_name"),
    }),
    default: "",
    clientEditable: true,
  }),
});
