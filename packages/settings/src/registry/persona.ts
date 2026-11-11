import { defineCategory, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

export const AI_DISCLOSURE_MODES = ["upfront", "when_asked"] as const;

/** Who the bot is, and how it says that it is an AI. Consumed by the conversation engine (C4). */
export const personaSettings = defineCategory("persona", {
  "persona.bot_name": setting({
    label: "Bot name",
    help: "The first name the bot introduces itself with and signs emails with.",
    field: f.text({ minLength: 1, maxLength: 40, placeholder: "Alex" }),
    default: "Alex",
    clientEditable: true,
  }),
  "persona.role_title": setting({
    label: "Role",
    help: 'How the bot describes its job when it introduces itself, for example "virtual assistant" or "office assistant".',
    field: f.text({ minLength: 1, maxLength: 60 }),
    default: "virtual assistant",
    clientEditable: true,
  }),
  "persona.description": setting({
    label: "Persona",
    help: "Who the bot is: background, attitude and how it treats customers. The bot stays in this character for the whole conversation.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 1200 }),
    default:
      "A sharp, friendly member of the office team who has helped hundreds of homeowners and knows the trade well. Practical, warm and never pushy: listens first, explains things in plain words and always moves the customer one step closer to getting their problem solved.",
    clientEditable: true,
  }),
  "persona.speaks_as": setting({
    label: "Speaks as",
    help: 'Whether the bot talks about the business as "we" ("we can come out Tuesday") or as a named person on the team ("I\'ll get this to our estimator").',
    field: f.select([
      ["team_member", "A person on the team (I)"],
      ["business", "The business (we)"],
    ]),
    default: "team_member",
  }),
  "persona.ai_disclosure": setting({
    label: "AI disclosure",
    help: "When the bot says that it is an AI assistant. It never claims to be human under either option: when a customer asks, it answers truthfully.",
    field: f.select([
      ["upfront", "In its first message", "The first reply uses the disclosure wording below."],
      [
        "when_asked",
        "Only when asked",
        "The bot does not bring it up, and confirms it truthfully whenever a customer asks.",
      ],
    ]),
    default: "upfront",
  }),
  "persona.ai_disclosure_wording": setting({
    label: "Disclosure wording",
    help: 'The sentence the bot uses to introduce itself as an AI when disclosure is set to "in its first message".',
    field: f.text({
      minLength: 1,
      maxLength: 300,
      variables: variables("bot_name", "business_name"),
    }),
    default: "I'm {{bot_name}}, the virtual assistant for {{business_name}}.",
  }),
  "persona.ai_question_answer": setting({
    label: 'Answer to "Are you a bot?"',
    help: "What the bot says when a customer asks whether they are talking to a person or a machine. It must stay truthful; the bot may rephrase it to fit the conversation.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 400,
      variables: variables("bot_name", "business_name"),
    }),
    default:
      "I'm an AI assistant for {{business_name}}. I can take down everything the team needs and bring in a person whenever you'd like.",
  }),
});
