import { defineCategory, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

/** The same three outcomes as `ROUTING_OUTCOMES` in `@repo/core`, with labels for the form. */
const OUTCOMES = [
  ["book_meeting", "Book a meeting", "The bot offers times and books the customer straight in."],
  ["contact_later", '"We\'ll contact you"', "The bot says the team will be in touch and when."],
  ["disqualify", "Disqualify politely", "The bot closes with a polite no."],
] as const;

/** What each score band leads to. Consumed by lead routing (C5) and the engine (C4). */
export const routingSettings = defineCategory("routing", {
  "routing.mode": setting({
    label: "Routing mode",
    help: 'How the outcome of a lead is decided. "Always contact later" tells every lead that the team will be in touch, whatever the score; leads still get a score and a report.',
    field: f.select([
      ["by_score_band", "By score band", "Each band gets the outcome chosen below."],
      ["always_contact_later", 'Always "we\'ll contact you"', "Nobody is booked directly."],
    ]),
    default: "by_score_band",
  }),
  "routing.hot_outcome": setting({
    label: "Hot leads",
    help: "What happens to a lead in the hot band.",
    field: f.select(OUTCOMES),
    default: "book_meeting",
  }),
  "routing.warm_outcome": setting({
    label: "Warm leads",
    help: "What happens to a lead in the warm band.",
    field: f.select(OUTCOMES),
    default: "contact_later",
  }),
  "routing.cold_outcome": setting({
    label: "Cold leads",
    help: "What happens to a lead in the cold band.",
    field: f.select(OUTCOMES),
    default: "contact_later",
  }),
  "routing.booking_requires": setting({
    label: "Details needed before booking",
    help: "The bot does not book a meeting until it has these details.",
    field: f.multiSelect([
      ["name", "Name"],
      ["phone", "Phone number"],
      ["email", "Email address"],
      ["address", "Street address of the job"],
    ]),
    default: ["name", "phone"],
  }),
  "routing.booking_unavailable_outcome": setting({
    label: "When booking is not possible",
    help: "What a lead who should be booked gets when no calendar is connected or no time is free.",
    field: f.select([
      ["contact_later", '"We\'ll contact you"'],
      ["handoff", "Hand the conversation to a person"],
    ]),
    default: "contact_later",
  }),
  "routing.after_hours_booking": setting({
    label: "Booking outside business hours",
    help: "Whether the bot books meetings while the business is closed.",
    field: f.select([
      ["allowed", "Book as usual"],
      ["contact_later", "Tell them the team will be in touch"],
    ]),
    default: "allowed",
  }),
  "routing.existing_customer_outcome": setting({
    label: "Existing customers",
    help: "What happens when the person is already a customer with a new job in mind.",
    field: f.select([
      ["by_score", "Route by score like anyone else"],
      ["contact_later", '"We\'ll contact you"'],
      ["handoff", "Hand the conversation to a person"],
    ]),
    default: "by_score",
  }),
  "routing.contact_later_timeframe": setting({
    label: "When the team gets back",
    help: 'The time frame the bot promises with "we\'ll contact you". Keep it honest: the bot repeats it word for word.',
    field: f.text({ minLength: 1, maxLength: 80 }),
    default: "within one business day",
    clientEditable: true,
  }),
  "routing.contact_later_guidance": setting({
    label: '"We\'ll contact you" message',
    help: "How the bot tells a customer that the team will be in touch. Guidance, not a script: the bot words it to fit the conversation.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 600,
      variables: variables("business_name", "timeframe"),
    }),
    default:
      "Thank the customer, say that someone from {{business_name}} will reach out {{timeframe}}, confirm the best number or email to use, and ask if there is anything else the team should know first.",
  }),
  "routing.disqualify_guidance": setting({
    label: "Polite-no message",
    help: "How the bot turns a customer down. Guidance, not a script. The bot never mentions scores or qualification.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 600,
      variables: variables("business_name"),
    }),
    default:
      "Thank the customer for reaching out, say plainly and kindly that this is not something {{business_name}} can take on, give the reason in one sentence when it is a simple one (outside the service area, a service we do not offer), and wish them well.",
  }),
  "routing.disqualify_referral": setting({
    label: "Where to send people the business cannot help",
    help: 'Optional pointer the bot may add to a polite no, for example "For appliance repair, try a local appliance service." Leave it empty to add nothing.',
    field: f.text({ multiline: true, maxLength: 300 }),
    default: "",
    clientEditable: true,
  }),
});
