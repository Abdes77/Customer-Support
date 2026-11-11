/**
 * Placeholders that template settings may use, written `{{name}}`. A template field lists
 * the ones that make sense for it; the chunk that sends the text fills them in with
 * `renderTemplate` from this package.
 */
export const TEMPLATE_VARIABLES = {
  business_name: "The business's name.",
  business_phone: "The business's main phone number.",
  business_website: "The business's website address.",
  bot_name: "The bot's name (`persona.bot_name`).",
  contact_name: 'The customer\'s name, or "a new contact" when it is not known yet.',
  contact_phone: "The customer's phone number, when known.",
  service: "The service the customer asked about.",
  channel: "The channel of the conversation, for example WhatsApp.",
  score: "The lead score, 0 to 100.",
  band: "The label of the lead's score band (`scoring.band_labels`).",
  summary: "The one-paragraph summary from the lead report.",
  link: "Link to the conversation in the admin panel.",
  emergency: "The label of the emergency class that was detected.",
  meeting_type: "The kind of meeting (`scheduling.meeting_type`).",
  meeting_time: "The date and time of the meeting, in the business's time zone.",
  timeframe: "When the team gets back to the customer (`routing.contact_later_timeframe`).",
} as const;

export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;

/** Picks placeholder names with a compile-time check that each one exists. */
export function variables<const V extends readonly TemplateVariable[]>(...names: V): V {
  return names;
}
