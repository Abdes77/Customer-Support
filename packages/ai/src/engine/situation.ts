import type { ConversationTurn, EngineTurnInput, KnowledgeFact } from "@repo/core";
import { type AppSettings, channelSetting, type ModelTask } from "@repo/settings";

import { businessHoursState, type HoursState } from "../hours";
import {
  CONTACT_FIELD_KEYS,
  type LeadFieldSpec,
  leadFieldCatalogue,
  openFields,
} from "../lead-fields";
import { fillTemplate } from "../prompt/business-block";
import { type ConversationFacts, conversationFacts, customerText } from "../prompt/conversation";

/**
 * Everything about one turn that is worked out in code before the model is asked: the
 * office hours, where the conversation stands, what the channel allows, what kind of
 * message is due. The turn context is rendered from it, the output guard enforces it, and
 * the offline model reads it instead of the prompt.
 */

/** The emergency classes of a business that are switched on. */
export type EmergencyClass = AppSettings["emergency.classes"][number];

export interface ReplyLimits {
  /** Separate messages one reply may consist of (always 1 on email). */
  readonly maxMessages: number;
  /** Longest single message, in characters. */
  readonly maxCharacters: number;
  readonly quickReplies: { readonly maxOptions: number; readonly maxTitleLength: number } | null;
}

/**
 * What the after-hours mode demands of this turn.
 * - "none": reply normally (the office is open, or the mode leaves replies alone).
 * - "send_message": unless it is an emergency, the only thing sent is the after-hours message.
 * - "stay_silent": unless it is an emergency, nothing is sent.
 */
export type AfterHoursDirective = "none" | "send_message" | "stay_silent";

/**
 * What the turn is for.
 * - "reply": answer the customer's new messages.
 * - "backlog": no new message, but the customer's last ones were never answered.
 * - "nudge": a follow-up to a customer who went quiet.
 * - "check_in": the conversation came back from a person; pick it up.
 * - "none": nothing to write.
 */
export type TurnPurpose = "reply" | "backlog" | "nudge" | "check_in" | "none";

export interface TurnSituation {
  readonly values: AppSettings;
  readonly now: Date;
  readonly hours: HoursState;
  readonly conversation: ConversationFacts;
  readonly purpose: TurnPurpose;
  /** Which model and effort settings apply. */
  readonly task: Extract<ModelTask, "reply" | "follow_up">;
  /** True when the bot has not written in this conversation yet. */
  readonly firstReply: boolean;
  readonly limits: ReplyLimits;
  readonly afterHours: AfterHoursDirective;
  /** The after-hours message with its placeholders filled in. */
  readonly afterHoursMessage: string;
  /** The sentence the first reply must contain (`persona.ai_disclosure` is "upfront"). */
  readonly disclosure: string | null;
  /** The text the first reply must start with on this channel, if one is set. */
  readonly openingMessage: string | null;
  /** The greeting the website chat already showed before the customer wrote. */
  readonly shownGreeting: string | null;
  readonly catalogue: readonly LeadFieldSpec[];
  readonly open: readonly LeadFieldSpec[];
  /** Emergency classes whose example phrases occur in the newest messages. A hint only. */
  readonly emergencyHints: readonly EmergencyClass[];
  /** Photos in the newest messages that nothing has looked at yet. */
  readonly unanalyzedPhotos: readonly string[];
  /** For a nudge: which one it is. */
  readonly nudge: { readonly number: number; readonly max: number; readonly last: boolean } | null;
  /** What the customer wrote in the messages this turn answers (plain text). */
  readonly customerText: string;
}

/** Whether the office counts as closed for the after-hours rules. */
function closedDirective(
  values: AppSettings,
  hours: HoursState,
  history: readonly ConversationTurn[],
): AfterHoursDirective {
  if (hours.open) return "none";
  const mode = values["hours.after_hours_mode"];
  if (mode === "silent") return "stay_silent";
  if (mode !== "auto_reply") return "none";
  // One message per conversation per closed period: has the bot written since closing?
  const since = hours.closedSince?.getTime() ?? Number.NEGATIVE_INFINITY;
  const alreadySent = history.some(
    (turn) => turn.author === "bot" && Date.parse(turn.sentAt) >= since,
  );
  return alreadySent ? "stay_silent" : "send_message";
}

function sameText(a: string, b: string): boolean {
  const normal = (text: string) => text.toLowerCase().replaceAll(/\s+/g, " ").trim();
  return normal(a) === normal(b);
}

/**
 * The customer messages at the end of the history that never got a real answer: nothing
 * after them, or only the after-hours message.
 */
function unanswered(
  history: readonly ConversationTurn[],
  afterHoursMessage: string,
): ConversationTurn[] {
  let end = history.length;
  while (end > 0) {
    const turn = history[end - 1];
    if (turn?.author !== "bot" || !sameText(turn.text ?? "", afterHoursMessage)) break;
    end -= 1;
  }
  let start = end;
  while (start > 0 && history[start - 1]?.author === "customer") start -= 1;
  return history.slice(start, end);
}

function purposeOf(
  input: EngineTurnInput,
  values: AppSettings,
  facts: ConversationFacts,
  backlog: readonly ConversationTurn[],
): TurnPurpose {
  if (input.pending.length > 0) return "reply";
  if (input.trigger === "inbound_message") return "none";
  if (input.trigger === "takeover_released") {
    return values["handoff.on_release"] === "check_in" && facts.lastIsUnanswered
      ? "check_in"
      : "none";
  }
  // A follow-up with unanswered customer messages is a late reply, not a nudge.
  if (backlog.length > 0) return "backlog";
  return facts.botMessages > 0 ? "nudge" : "none";
}

export function emergencyHints(values: AppSettings, text: string): EmergencyClass[] {
  const haystack = text.toLowerCase();
  if (haystack.trim().length === 0) return [];
  return values["emergency.classes"].filter(
    (item) =>
      item.enabled &&
      item.phrases.some((phrase) => {
        const needle = phrase.trim().toLowerCase();
        return needle.length > 0 && haystack.includes(needle);
      }),
  );
}

export function describeSituation(input: EngineTurnInput, values: AppSettings): TurnSituation {
  const now = new Date(input.now);
  const hours = businessHoursState(values, input.business.timezone, now);
  const facts = conversationFacts(input.history, input.pending);
  const fill = (template: string) => fillTemplate(template, input.business, values);
  const afterHoursMessage = fill(values["hours.after_hours_message"]);
  const backlog = unanswered(input.history, afterHoursMessage);
  const purpose = purposeOf(input, values, facts, backlog);
  const channel = input.channel;
  const email = channel.capabilities.format === "email";
  const firstReply = facts.botMessages === 0;

  const answered = purpose === "backlog" || purpose === "check_in" ? backlog : input.pending;
  const text = customerText(answered);

  const catalogue = leadFieldCatalogue(values);
  const opening = fill(channelSetting(values, "voice.opening_message", channel.id));
  const quick = channel.capabilities.quickReplies;
  const max = channelSetting(values, "follow_up.max_nudges", channel.id);
  const nudgeNumber = Math.max(1, facts.botRoundsSinceCustomer);

  return {
    values,
    now,
    hours,
    conversation: facts,
    purpose,
    task: purpose === "nudge" ? "follow_up" : "reply",
    firstReply,
    limits: {
      maxMessages: email ? 1 : values["voice.max_messages_per_turn"],
      maxCharacters: Math.min(
        channelSetting(values, "voice.max_reply_characters", channel.id),
        channel.capabilities.maxTextLength,
      ),
      quickReplies:
        quick === null
          ? null
          : { maxOptions: quick.maxOptions, maxTitleLength: quick.maxTitleLength },
    },
    afterHours:
      purpose === "reply" || purpose === "backlog"
        ? closedDirective(values, hours, input.history)
        : "none",
    afterHoursMessage,
    disclosure:
      firstReply && values["persona.ai_disclosure"] === "upfront"
        ? fill(values["persona.ai_disclosure_wording"])
        : null,
    // The website chat shows its greeting itself, before the visitor writes.
    openingMessage:
      firstReply && channel.id !== "widget" && channel.id !== "test" && opening.length > 0
        ? opening
        : null,
    shownGreeting: firstReply && channel.id === "widget" && opening.length > 0 ? opening : null,
    catalogue,
    open: openFields(catalogue, input.lead, values).filter(
      (field) =>
        !(
          (field.key === CONTACT_FIELD_KEYS.name && Boolean(input.customer?.name)) ||
          (field.key === CONTACT_FIELD_KEYS.phone && Boolean(input.customer?.phone)) ||
          (field.key === CONTACT_FIELD_KEYS.email && Boolean(input.customer?.email))
        ),
    ),
    emergencyHints: emergencyHints(values, text),
    unanalyzedPhotos: answered.flatMap((turn) =>
      turn.attachments
        .filter(
          (attachment) =>
            attachment.kind === "image" &&
            attachment.storage !== null &&
            (attachment.analysis ?? "").trim().length === 0,
        )
        .map((attachment) => attachment.id),
    ),
    nudge: purpose === "nudge" ? { number: nudgeNumber, max, last: nudgeNumber >= max } : null,
    customerText: text,
  };
}

/** Facts looked up for the turn that are not already among the core facts. */
export function turnFacts(
  retrieved: readonly KnowledgeFact[],
  core: readonly KnowledgeFact[],
): KnowledgeFact[] {
  const known = new Set(core.map((fact) => fact.id));
  return retrieved.filter((fact) => !known.has(fact.id));
}
