import { defineCategory, setting } from "../define";
import { f } from "../fields";

/**
 * Photo requests and photo analysis. Consumed by the engine (C4: the `request_photo` and
 * `analyze_photos` actions). Channels that cannot carry images are skipped automatically.
 */
export const photosSettings = defineCategory("photos", {
  "photos.request_mode": setting({
    label: "Asking for photos",
    help: "Whether the bot asks customers to send photos of the job.",
    field: f.select([
      ["never", "Never"],
      ["when_helpful", "When a photo would help", "The bot decides from the kind of job."],
      ["always", "In every conversation"],
    ]),
    default: "when_helpful",
    clientEditable: true,
  }),
  "photos.request_timing": setting({
    label: "When to ask",
    help: "The point in the conversation at which the bot asks for photos.",
    field: f.select([
      ["early", "Right after the customer describes the problem"],
      ["after_basics", "After the basic questions"],
      ["before_handoff", "At the end, before booking or handing off"],
    ]),
    default: "after_basics",
  }),
  "photos.max_requests": setting({
    label: "Times to ask",
    help: "How many times the bot may ask for photos in one conversation. It never insists: a customer who cannot send one is qualified without.",
    field: f.integer({ min: 1, max: 5, unit: "requests" }),
    default: 2,
  }),
  "photos.subjects": setting({
    label: "What to photograph",
    help: 'What the bot asks customers to photograph, for example "the damaged area from a few steps back" or "the label on the unit". Empty lets the bot choose from the kind of job.',
    field: f.stringList({ itemLabel: "subject", maxItems: 12, maxLength: 160 }),
    default: [],
    clientEditable: true,
  }),
  "photos.safety_note": setting({
    label: "Safety reminder",
    help: "Added whenever the bot asks for a photo, so nobody climbs a roof or opens a panel for a picture.",
    field: f.text({ minLength: 1, maxLength: 300 }),
    default: "Only if it's safe and easy to take: please don't climb up or open anything.",
  }),
  "photos.analysis_enabled": setting({
    label: "Analyze photos",
    help: "The bot looks at the photos customers send and records what it sees in the lead report. When off, photos are stored for the team and the bot only thanks the customer.",
    field: f.boolean(),
    default: true,
  }),
  "photos.share_findings": setting({
    label: "Telling the customer what the photo shows",
    help: "How much the bot says about a photo. It never diagnoses a problem or names a cause from a picture: that is the team's job on site.",
    field: f.select([
      ["acknowledge", "Only thank the customer"],
      [
        "describe",
        "Describe what is visible",
        'For example: "I can see the stain is right below the bathroom."',
      ],
    ]),
    default: "acknowledge",
  }),
  "photos.max_per_conversation": setting({
    label: "Photos analyzed per conversation",
    help: "Further photos are stored for the team but not analyzed.",
    field: f.integer({ min: 1, max: 40, unit: "photos" }),
    default: 10,
  }),
  "photos.include_in_report": setting({
    label: "Photos in the lead report",
    help: "The lead report describes each photo and links to it.",
    field: f.boolean(),
    default: true,
  }),
  "photos.accept_video": setting({
    label: "Accept videos",
    help: "Videos are stored for the team. They are not analyzed; the bot thanks the customer and carries on.",
    field: f.boolean(),
    default: true,
  }),
});
