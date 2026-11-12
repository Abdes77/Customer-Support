import {
  type AppResolvedSettings,
  type AppSettings,
  checkSettingValue,
  defaultSettings,
  resolveSettings,
  segmentPresetFor,
  type StoredSetting,
} from "@repo/settings";

import type { EvalBusiness } from "../fixtures/businesses";
import type { ProfileId, SettingsProfile } from "./types";

/**
 * Settings profiles: the configurations a scenario can run under. Between them they move
 * every setting the rubric names (pricing, disclosure, persona, length) and the routing
 * options of the spec: book straight into a meeting, "we'll contact you" by score band,
 * always "we'll contact you", and a polite no.
 *
 * A profile is a set of overrides. The snapshot a scenario runs under is resolved by the
 * product's own resolver from the layers a real business would have: registry defaults,
 * the segment's preset, the business's own values, then the profile.
 */

const CHAT_LIMIT = 320;

export const SETTINGS_PROFILES: Readonly<Record<ProfileId, SettingsProfile>> = {
  default: {
    id: "default",
    title: "Careful defaults",
    summary:
      "What a business gets on day one: no prices, AI disclosure in the first message, hot leads are to be booked but no calendar is connected, so everyone is told the team will be in touch.",
    overrides: {},
    slots: [],
  },
  booking_with_ranges: {
    id: "booking_with_ranges",
    title: "Books meetings, shares price ranges",
    summary:
      "A calendar is connected; hot and warm leads are booked in chat. Price ranges may be shared, including the playbook's, and estimates are free.",
    overrides: {
      "scheduling.provider": "google_calendar",
      "routing.warm_outcome": "book_meeting",
      "pricing.disclosure": "ranges",
      "pricing.use_playbook_ranges": true,
      "pricing.estimate_policy": "free",
      "persona.bot_name": "Riley",
      "voice.tone": "upbeat",
    },
    slots: [
      { id: "slot-thu-0900", label: "Thursday, November 5 at 9:00 AM" },
      { id: "slot-thu-1330", label: "Thursday, November 5 at 1:30 PM" },
      { id: "slot-fri-1000", label: "Friday, November 6 at 10:00 AM" },
    ],
  },
  contact_only: {
    id: "contact_only",
    title: 'Everyone is told "we\'ll contact you"',
    summary:
      "No booking in chat, whatever the score. Short single messages, one question at a time, no emoji, no photo requests; the bot says it is an AI only when asked.",
    overrides: {
      "routing.mode": "always_contact_later",
      "routing.contact_later_timeframe": "by the end of the next business day",
      "persona.ai_disclosure": "when_asked",
      "persona.bot_name": "Sam",
      "voice.reply_length": "brief",
      "voice.max_reply_characters.whatsapp": CHAT_LIMIT,
      "voice.max_reply_characters.instagram": CHAT_LIMIT,
      "voice.max_reply_characters.messenger": CHAT_LIMIT,
      "voice.max_reply_characters.widget": CHAT_LIMIT,
      "voice.max_reply_characters.email": 900,
      "voice.max_messages_per_turn": 1,
      "qualification.questions_per_message": 1,
      "voice.emoji": "never",
      "photos.request_mode": "never",
    },
    slots: [],
  },
  transparent_pricing: {
    id: "transparent_pricing",
    title: "Exact prices and a current offer",
    summary:
      "The bot may state the exact figures in the business's facts and one current offer, and nothing else. A professional voice with two phrases banned.",
    overrides: {
      "pricing.disclosure": "exact",
      "pricing.promotions": [
        {
          title: "New customer offer",
          details: "$25 off the first service for new customers. One per household.",
          ends_on: null,
        },
      ],
      "persona.bot_name": "Maya",
      "voice.tone": "professional",
      "voice.reply_length": "balanced",
      "voice.banned_phrases": ["no problem", "to be honest"],
      "guardrails.diy_advice": "none",
    },
    slots: [],
  },
  strict: {
    id: "strict",
    title: "Strict fit rules",
    summary:
      "Cold leads are turned away, the decision-maker is required, a customer who asks for a person gets one at once, spam gets one polite reply, and every chat starts with a fixed opening line.",
    overrides: {
      "routing.cold_outcome": "disqualify",
      "qualification.decision_maker.required": true,
      "qualification.decision_maker.not_decision_maker_action": "contact_later",
      "conversation.spam": "one_polite_reply",
      "conversation.profanity": "warn_then_end",
      "handoff.person_request": "immediately",
      "handoff.calm_attempts": 0,
      "hours.after_hours_mode": "take_message",
      "voice.emoji": "never",
      "voice.opening_message.whatsapp": "Thanks for contacting {{business_name}}.",
      "voice.opening_message.messenger": "Thanks for contacting {{business_name}}.",
      "voice.opening_message.instagram": "Thanks for contacting {{business_name}}.",
      "persona.bot_name": "Jordan",
    },
    slots: [],
  },
};

export function settingsProfile(id: ProfileId): SettingsProfile {
  return SETTINGS_PROFILES[id];
}

function rows(values: Partial<AppSettings>): StoredSetting[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value,
    version: null,
    updatedAt: null,
  }));
}

/** The values an agency sets for one business, with its own emergency class appended. */
export function businessValues(business: EvalBusiness): Partial<AppSettings> {
  if (business.emergencyClass === undefined) return business.settings;
  return {
    ...business.settings,
    "emergency.classes": [
      ...defaultSettings().values["emergency.classes"],
      business.emergencyClass,
    ],
  };
}

/**
 * The settings snapshot of a scenario, resolved the way production resolves it. A value the
 * registry refuses is a bug in a fixture, so it throws instead of being skipped.
 */
export function scenarioSettings(
  business: EvalBusiness,
  profile: SettingsProfile,
): AppResolvedSettings {
  const preset = segmentPresetFor(business.segmentSlug)?.preset ?? {};
  const business_: StoredSetting[] = [];
  const global: StoredSetting[] = [];
  for (const row of rows({ ...businessValues(business), ...profile.overrides })) {
    // A few settings are the agency's to decide and cannot be set per business.
    const target = checkSettingValue(row.key, row.value, "business").ok ? business_ : global;
    target.push(row);
  }
  const resolved = resolveSettings({ global, segment: rows(preset), business: business_ });
  if (resolved.issues.length > 0) {
    throw new Error(
      `Settings profile "${profile.id}" for ${business.slug} is not valid: ${resolved.issues
        .map((issue) => issue.message)
        .join(" ")}`,
    );
  }
  return resolved;
}
