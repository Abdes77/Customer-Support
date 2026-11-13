import type { z } from "zod";

import { type ChannelId, SETTING_SCOPES, type SettingScope } from "@repo/core";

import type { AnyField, FieldValue } from "./fields";

/**
 * What a setting declaration is made of. The catalogue itself is in `./registry`, one file
 * per category; `docs/SETTINGS.md` is generated from it.
 */

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

/**
 * The categories, in the order the admin panel and the documentation show them. A setting's
 * key starts with its category id (`persona.bot_name`), which a test enforces.
 */
export const SETTING_CATEGORIES = [
  {
    id: "qualification",
    label: "Lead qualification",
    description:
      "What the bot finds out about a lead, criterion by criterion, and how much each one counts.",
  },
  {
    id: "scoring",
    label: "Lead scoring",
    description: "How the criteria turn into a score from 0 to 100 and into a score band.",
  },
  {
    id: "routing",
    label: "Routing",
    description:
      "What happens to a lead in each score band: a meeting, a promise to call back, or a polite no.",
  },
  {
    id: "persona",
    label: "Persona and AI disclosure",
    description: "Who the bot is, and how it says that it is an AI.",
  },
  {
    id: "voice",
    label: "Voice and style",
    description: "Tone, reading level, length, emoji and opening messages.",
  },
  {
    id: "pricing",
    label: "Pricing disclosure",
    description: "Whether and how the bot talks about prices.",
  },
  {
    id: "photos",
    label: "Photos",
    description: "When the bot asks for photos and what it does with them.",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    description: "What the bot must not say or promise.",
  },
  {
    id: "conversation",
    label: "Conversation flow",
    description: "Reply timing, conversation limits and how unusual messages are handled.",
  },
  {
    id: "emergency",
    label: "Emergencies",
    description: "Which situations are emergencies, what the bot says and who is alerted.",
  },
  {
    id: "hours",
    label: "Hours",
    description: "Business hours, holidays, after-hours behaviour and quiet hours.",
  },
  {
    id: "follow_up",
    label: "Follow-ups",
    description: "Nudges to customers who stopped replying.",
  },
  {
    id: "handoff",
    label: "Handoff and human takeover",
    description: "When a person takes over a conversation and when the bot resumes.",
  },
  {
    id: "alerts",
    label: "Alerts",
    description: "Who is told about leads, and how.",
  },
  {
    id: "scheduling",
    label: "Scheduling",
    description: "Calendars, meeting slots, booking rules and reminders.",
  },
  {
    id: "channels",
    label: "Channels",
    description: "Options of the website widget, WhatsApp, Instagram, Messenger and email.",
  },
  {
    id: "integrations",
    label: "CRM and webhooks",
    description: "When leads are pushed to a CRM, field mapping and outgoing webhooks.",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "How business knowledge is gathered and used in replies.",
  },
  {
    id: "client_portal",
    label: "Client portal",
    description: "What the business's own users may see and do when they have a login.",
  },
  {
    id: "model",
    label: "Model and effort",
    description: "Which Claude model does each task, and how hard it thinks.",
  },
  {
    id: "limits",
    label: "Limits and spend caps",
    description: "Rate limits and model-spend caps that stop floods and runaway cost.",
  },
  {
    id: "data",
    label: "Data retention",
    description: "How long conversations, files and model records are kept.",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}[];

export type SettingCategoryId = (typeof SETTING_CATEGORIES)[number]["id"];

export interface SettingCategory {
  readonly id: SettingCategoryId;
  readonly label: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------

/** Every scope, in order of precedence (later wins). */
export const ALL_SCOPES: readonly SettingScope[] = SETTING_SCOPES;
/** For values that describe one business: its ZIP codes, its alert recipients. */
export const BUSINESS_ONLY: readonly SettingScope[] = ["business"];
/** For agency-wide policy that must not differ between businesses. */
export const GLOBAL_ONLY: readonly SettingScope[] = ["global"];
/** For agency policy with per-business exceptions, where a per-segment default makes no sense. */
export const GLOBAL_AND_BUSINESS: readonly SettingScope[] = ["global", "business"];

export interface SettingSpec<F extends AnyField> {
  /** Short name shown next to the control. */
  readonly label: string;
  /** One to three sentences: what the setting does, written for agency staff. */
  readonly help: string;
  readonly field: F;
  readonly default: NoInfer<FieldValue<F>>;
  /** Where an override may be stored. Default: global, segment and business. */
  readonly scopes?: readonly SettingScope[];
  /** Client users (the business's own logins) may change it for their business. Default false. */
  readonly clientEditable?: boolean;
  /**
   * The value can hold contact details or capability URLs. It is never logged and audit
   * entries record that it changed, not what it changed to. Default false.
   */
  readonly sensitive?: boolean;
  /** Sub-heading inside the category, to keep related settings together on screen. */
  readonly group?: string;
}

/** A setting without its key; the key comes from the property name it is declared under. */
export interface SettingDraft<T = unknown> {
  readonly label: string;
  readonly help: string;
  readonly field: AnyField;
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly scopes: readonly SettingScope[];
  readonly clientEditable: boolean;
  readonly sensitive: boolean;
  readonly group: string | null;
}

/** One declared setting: everything the resolver, the store, the docs and a form need. */
export interface SettingDefinition<T = unknown> extends SettingDraft<T> {
  readonly key: string;
  readonly category: SettingCategoryId;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Freezes a JSON value in place, so a shared default or snapshot cannot be edited by a consumer. */
export function freezeValue<T>(value: T): T {
  return deepFreeze(value);
}

/** Declares one setting. Its value type is the type of its field. */
export function setting<F extends AnyField>(spec: SettingSpec<F>): SettingDraft<FieldValue<F>> {
  return {
    label: spec.label,
    help: spec.help,
    field: spec.field,
    schema: spec.field.schema as z.ZodType<FieldValue<F>>,
    default: deepFreeze(spec.default),
    scopes: spec.scopes ?? ALL_SCOPES,
    clientEditable: spec.clientEditable ?? false,
    sensitive: spec.sensitive ?? false,
    group: spec.group ?? null,
  };
}

type Definitions<D> = {
  readonly [K in keyof D]: D[K] extends SettingDraft<infer T> ? SettingDefinition<T> : never;
};

/**
 * Declares the settings of one category. Every key must start with the category id; the
 * compiler checks it.
 */
export function defineCategory<
  const C extends SettingCategoryId,
  const D extends Record<`${C}.${string}`, SettingDraft>,
>(category: C, drafts: D): Definitions<D> {
  const definitions: Record<string, SettingDefinition> = {};
  for (const [key, draft] of Object.entries<SettingDraft>(drafts)) {
    definitions[key] = Object.freeze({ ...draft, key, category });
  }
  return Object.freeze(definitions) as Definitions<D>;
}

/** Applies a group heading to a set of drafts. */
export function group<const D extends Record<string, SettingDraft>>(name: string, drafts: D): D {
  const grouped: Record<string, SettingDraft> = {};
  for (const [key, draft] of Object.entries(drafts)) grouped[key] = { ...draft, group: name };
  return grouped as D;
}

// ---------------------------------------------------------------------------------------
// Settings that exist once per channel
// ---------------------------------------------------------------------------------------

/** The channels customers write on. The "test" channel behaves as the website widget. */
export const CUSTOMER_CHANNELS = [
  "whatsapp",
  "instagram",
  "messenger",
  "widget",
  "email",
] as const satisfies readonly ChannelId[];
export type CustomerChannel = (typeof CUSTOMER_CHANNELS)[number];

export const CHANNEL_LABELS: Readonly<Record<CustomerChannel, string>> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  widget: "Website chat",
  email: "Email",
};

/** The channel whose per-channel settings apply to `channel`. */
export function settingsChannelOf(channel: ChannelId): CustomerChannel {
  return channel === "test" ? "widget" : channel;
}

// Keeps the two lists in step: every channel except "test" has its own settings.
const _everyChannelCovered: Exclude<ChannelId, "test"> extends CustomerChannel ? true : never =
  true;
void _everyChannelCovered;

type PerChannel<B extends string, T> = {
  readonly [K in CustomerChannel as `${B}.${K}`]: SettingDraft<T>;
};

/**
 * Declares the same setting once per channel, as `<base>.<channel>`. Read the value for a
 * conversation with `channelSetting(values, base, channel)`.
 */
export function perChannel<const B extends string, F extends AnyField>(
  base: B,
  make: (channel: CustomerChannel, channelLabel: string) => SettingSpec<F>,
): PerChannel<B, FieldValue<F>> {
  const drafts: Record<string, SettingDraft> = {};
  for (const channel of CUSTOMER_CHANNELS) {
    drafts[`${base}.${channel}`] = setting(make(channel, CHANNEL_LABELS[channel]));
  }
  return drafts as PerChannel<B, FieldValue<F>>;
}
