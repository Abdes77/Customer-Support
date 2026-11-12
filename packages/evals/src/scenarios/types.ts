import type { ChannelId, RoutingOutcome } from "@repo/core";
import type { AppResolvedSettings, AppSettings } from "@repo/settings";

import type { EvalBusiness, EvalSegment, JobCase } from "../fixtures/businesses";

/**
 * What a scenario is: one simulated customer (a persona with the facts of their own
 * situation) writing to one business on one channel under one settings profile, plus what
 * the conversation has to come to.
 */

export const PERSONA_IDS = [
  "ready_to_book",
  "price_shopper",
  "tire_kicker",
  "renter",
  "out_of_area",
  "emergency",
  "angry_past_job",
  "one_word",
  "spam",
  "prompt_injection",
  "broken_english",
  "silent_returner",
] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export const PROFILE_IDS = [
  "default",
  "booking_with_ranges",
  "contact_only",
  "transparent_pricing",
  "strict",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** The customer channels a scenario can run on (the test channel is not a customer channel). */
export const EVAL_CHANNELS = ["whatsapp", "widget", "messenger", "email", "instagram"] as const;
export type EvalChannel = Extract<ChannelId, (typeof EVAL_CHANNELS)[number]>;

/** Enumerated lead values, as the lead-field catalogue spells them. */
export type TimelineValue =
  | "emergency"
  | "this_week"
  | "this_month"
  | "one_to_three_months"
  | "three_to_six_months"
  | "later"
  | "just_researching";
export type DecisionRole = "homeowner" | "landlord" | "property_manager" | "tenant";

/** The customer's own situation: what is true, whether or not they say it. */
export interface CustomerTruth {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly zip: string;
  readonly town: string;
  readonly street: string;
  readonly role: DecisionRole;
  /** How they would say it ("we own it", "I rent, my landlord handles repairs"). */
  readonly roleWords: string;
  readonly timeline: TimelineValue;
  readonly timelineWords: string;
  /** Null: no job (spam). */
  readonly job: JobCase | null;
  /** A photo they can send when asked. Null: none. */
  readonly photo: string | null;
}

/** The lead fields a persona gives up when asked. Decides what the routing oracle expects. */
export type Revealed =
  | "service_type"
  | "job_scope"
  | "service_area"
  | "timeline"
  | "decision_maker"
  | "property_type"
  | "contact_name"
  | "contact_phone";

/** A customer line that is fixed by the scenario instead of written by the simulator. */
export interface ScriptedBeat {
  /** Customer turn it replaces, counted from 1; turn 1 is the opening. */
  readonly turn: number;
  readonly messages: readonly string[];
}

export interface Silence {
  /** The customer stops answering after this many bot replies. */
  readonly afterBotTurns: number;
  /** Follow-up turns the harness fires while the customer is quiet. */
  readonly nudges: number;
  /** Hours between the last bot reply and the customer's return. */
  readonly returnAfterHours: number;
}

export interface Expectations {
  /** Emergency classes that fit what the customer reports. Null: there is no emergency. */
  readonly emergencyClasses: readonly string[] | null;
  /**
   * "required": the conversation must be handed to a person. "allowed": either way.
   * "unexpected": a handoff here means the bot gave up on something it should handle.
   */
  readonly handoff: "required" | "allowed" | "unexpected";
  /** The contact is not a customer at all (solicitation). */
  readonly spam: boolean;
  /**
   * Routing outcomes the business's rules give for this customer (worked out from the
   * customer's true facts by `assessLead`); `null` in the list means "no decision" is
   * acceptable too. Undefined: routing is not what this scenario is about.
   */
  readonly routing?: readonly (RoutingOutcome | null)[];
  /** No meeting may be offered or booked, whatever the score. */
  readonly mustNotBook: boolean;
  /** Lead fields the bot should have recorded by the end. */
  readonly fieldsToCapture: readonly string[];
  /** Must never appear in a bot reply (attack payloads). */
  readonly forbiddenInReplies: readonly (string | RegExp)[];
}

export interface Persona {
  readonly id: PersonaId;
  readonly title: string;
  /** One line for reports. */
  readonly summary: string;
  /** Character and behaviour, for the simulated customer. */
  readonly brief: string;
  /** What a good conversation with this customer looks like, for the judge. */
  readonly goodOutcome: string;
  /** Channels this customer would plausibly use. Default: all. */
  readonly channels?: readonly EvalChannel[];
  readonly maxCustomerTurns: number;
  build(business: EvalBusiness): PersonaInstance;
}

/** A persona applied to one business. */
export interface PersonaInstance {
  readonly truth: CustomerTruth;
  readonly opening: readonly string[];
  /** Local time of day of the first message ("HH:MM"). Default: mid-morning. */
  readonly startsAt?: string;
  readonly beats: readonly ScriptedBeat[];
  readonly silence: Silence | null;
  /** Questions the customer wants answered at some point, in their words. */
  readonly probes: readonly string[];
  readonly revealed: readonly Revealed[];
  /**
   * Facts the customer states whether or not they are asked (the renter says they rent).
   * A record of this customer always holds them, required by the business or not.
   */
  readonly volunteered?: readonly Revealed[];
  /** Signals lead scoring may or may not pick up (each widens the expected routing). */
  readonly possibleSignals: readonly string[];
  /** True: every customer line is scripted and no simulator is asked. */
  readonly fullyScripted: boolean;
  readonly expect: Omit<Expectations, "routing"> & {
    /** How the expected routing is worked out. */
    readonly routing: "oracle" | "oracle_or_none" | "any";
  };
}

export interface SettingsProfile {
  readonly id: ProfileId;
  readonly title: string;
  readonly summary: string;
  readonly overrides: Partial<AppSettings>;
  /** Meeting slots the stand-in calendar offers. Empty: booking is not available. */
  readonly slots: readonly { readonly id: string; readonly label: string }[];
}

export interface Scenario {
  /** `<segment>.<persona>`, unique in the matrix. */
  readonly id: string;
  /** The suite it belongs to: its segment. */
  readonly suite: EvalSegment;
  readonly persona: Persona;
  readonly instance: PersonaInstance;
  readonly business: EvalBusiness;
  readonly profile: SettingsProfile;
  readonly channel: EvalChannel;
  readonly settings: AppResolvedSettings;
  /** The first message's time, ISO 8601. */
  readonly startAt: string;
  readonly expect: Expectations;
  /** Part of the smaller `--core` selection. */
  readonly core: boolean;
}
