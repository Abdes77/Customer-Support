import type { EngineTurnInput } from "@repo/core";

import type { LeadFieldSpec } from "../lead-fields";
import type { AfterHoursDirective, TurnPurpose, TurnSituation } from "./situation";

/**
 * The turn in structured form, attached to every reply request as `hints.reply`. It is never
 * sent to the API. The offline model answers from it, and a scripted model in a test can
 * look at it instead of parsing the prompt.
 */
export interface ReplyHints {
  readonly purpose: TurnPurpose;
  /** What the customer wrote in the messages this turn answers. */
  readonly customerText: string;
  readonly firstReply: boolean;
  readonly businessName: string;
  readonly botName: string;
  /** The lead fields still to find out, in order. */
  readonly open: readonly Pick<LeadFieldSpec, "key" | "type" | "options" | "group" | "label">[];
  /** Keys the lead record already holds. */
  readonly recorded: readonly string[];
  /** The first emergency class whose example phrases matched, if any. */
  readonly emergency: { readonly key: string; readonly instructions: string } | null;
  /** The routing outcome in force at the start of the turn. */
  readonly routing: string | null;
  readonly afterHours: AfterHoursDirective;
  /** Nothing may be sent unless this is an emergency (an opted-out customer). */
  readonly emergencyOnly: boolean;
  readonly questionsPerMessage: number;
  readonly contactLaterTimeframe: string;
  readonly unanalyzedPhotos: readonly string[];
  readonly photoAnalysis: boolean;
  readonly maxCharacters: number;
  readonly email: boolean;
}

export function replyHints(
  input: EngineTurnInput,
  situation: TurnSituation,
): { readonly reply: ReplyHints } {
  const { values } = situation;
  const hint = situation.emergencyHints[0];
  return {
    reply: {
      purpose: situation.purpose,
      customerText: situation.customerText,
      firstReply: situation.firstReply,
      businessName: input.business.name,
      botName: values["persona.bot_name"],
      open: situation.open.map(({ key, type, options, group, label }) => ({
        key,
        type,
        ...(options === undefined ? {} : { options }),
        group,
        label,
      })),
      recorded: Object.keys(input.lead.fields),
      emergency:
        hint === undefined ? null : { key: hint.key, instructions: hint.safety_instructions },
      routing: input.lead.routing?.outcome ?? null,
      afterHours: situation.afterHours,
      emergencyOnly: situation.emergencyOnly !== null,
      questionsPerMessage: values["qualification.questions_per_message"],
      contactLaterTimeframe: values["routing.contact_later_timeframe"],
      unanalyzedPhotos: situation.unanalyzedPhotos,
      photoAnalysis: values["photos.analysis_enabled"],
      maxCharacters: situation.limits.maxCharacters,
      email: input.channel.capabilities.format === "email",
    },
  };
}
