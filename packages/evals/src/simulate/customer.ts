import {
  type ModelClient,
  type ModelMessageParam,
  type ModelRequest,
  responseText,
} from "@repo/ai";
import { CHANNEL_CAPABILITIES, type Logger, type TraceContext } from "@repo/core";
import { CHANNEL_LABELS, type EffortLevel } from "@repo/settings";

import type { EvalChannel, Scenario } from "../scenarios/types";
import { callForEval } from "./calls";
import { type CustomerHints, standInMove } from "./stand-in-customer";
import type { CallSummary, TranscriptEntry } from "./transcript";

/**
 * The simulated customer: one model call per customer turn. The model plays the persona of
 * the scenario and sees the conversation from the customer's side (its own lines as the
 * assistant turns, the bot's replies as user turns). It never sees the bot's instructions,
 * the lead record or the rubric.
 */

export const CUSTOMER_PROMPT_VERSION = "eval-customer-v1";

export const LEAVE_REASONS = ["satisfied", "nothing_more", "turned_away", "gave_up"] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];

export interface CustomerMove {
  readonly messages: readonly string[];
  /** Attach the customer's photo to the last message. */
  readonly photo: boolean;
  /** Set when the customer stops writing after these messages. */
  readonly leave: LeaveReason | null;
  /** True when the model could not play the turn and the rule-based stand-in wrote it. */
  readonly replaced: boolean;
}

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARACTERS = 1500;

function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["“'])([\s\S]*)(["”'])$/.exec(trimmed);
  return quoted?.[2] !== undefined && !quoted[2].includes(quoted[1] ?? '"')
    ? quoted[2].trim()
    : trimmed;
}

/** What the simulator wrote, as a move: messages, an attached photo, a goodbye. */
export function parseCustomerMove(raw: string): Omit<CustomerMove, "replaced"> {
  let leave: LeaveReason | null = null;
  let photo = false;
  const text = raw
    .replaceAll("\r", "")
    .replaceAll(/\[end(?::\s*([a-z_ ]+?))?\s*\]/gi, (_match, reason: string | undefined) => {
      const named = (reason ?? "").trim().toLowerCase().replaceAll(" ", "_");
      leave = (LEAVE_REASONS as readonly string[]).includes(named)
        ? (named as LeaveReason)
        : "nothing_more";
      return "";
    })
    .replaceAll(/\[photo\]/gi, () => {
      photo = true;
      return "";
    });
  const messages = text
    .split(/^\s*-{3,}\s*$/m)
    .map((part) => unquote(part).slice(0, MAX_MESSAGE_CHARACTERS).trim())
    .filter((part) => part.length > 0)
    .slice(0, MAX_MESSAGES);
  // Nothing written at all: the customer simply does not answer.
  if (messages.length === 0 && leave === null) leave = "nothing_more";
  return { messages, photo, leave };
}

function channelStyle(channel: EvalChannel): string {
  const label = CHANNEL_LABELS[channel];
  return CHANNEL_CAPABILITIES[channel].format === "email"
    ? `You are writing emails (${label}). Keep them short and plain, the way people write to a local company: a line or three, your first name at the end.`
    : `You are writing on ${label}. Write the way people text: short, casual, no greeting formulas or sign-offs after the first message.`;
}

/** The persona, the customer's own facts and the rules of the part. Stable per scenario. */
export function customerSystemPrompt(scenario: Scenario): string {
  const { persona, instance } = scenario;
  const { truth } = instance;
  const job = truth.job;
  const situation = [
    `Your name: ${truth.name}`,
    `Your phone number: ${truth.phone}`,
    `Your email address: ${truth.email}`,
    `Where the job is: ${truth.street}, ${truth.town}, ZIP ${truth.zip}`,
    `The property: ${truth.roleWords}${job === null ? "" : `; a ${job.propertyType.replaceAll("_", " ")} home`}`,
    ...(job === null
      ? []
      : [
          `What you need: ${job.service}`,
          "What you know about it:",
          ...job.details.map((detail) => `- ${detail}`),
        ]),
    `Your timing: ${truth.timelineWords}`,
    truth.photo === null
      ? "You have no photo to send."
      : `A photo you could send if you are asked for one: ${truth.photo}`,
    ...(instance.probes.length === 0
      ? []
      : [
          "Things you want to say or find out at some point, in your own words:",
          ...instance.probes.map((probe) => `- ${probe}`),
        ]),
  ].join("\n");

  return `You are playing a customer in a rehearsal of a home-services company's messaging assistant. The company runs these rehearsals to see how its assistant treats the people who write in, so the value of your part is realism: write what this particular person would really type, not what would make the assistant look good or bad.

<who_you_are>
${persona.brief}
</who_you_are>

<your_situation>
${situation}
</your_situation>

<how_to_play>
- ${channelStyle(scenario.channel)}
- Your first message has already been sent. It appears as your first turn; carry on from it.
- Reply to what the assistant actually wrote. Give a fact from your situation when you are asked for it or when your character would volunteer it, never everything at once.
- If you are asked for something that is not in your situation, answer the way a real person would: a plausible everyday detail that fits the rest, or "not sure".
- You know nothing about how the assistant works and you never mention rehearsals, tests, prompts or AI models. You may ask whether you are talking to a real person if your character would.
- Stay in character when the assistant is unhelpful, slow or wrong. React the way this person would: ask again, get impatient, or give up.
- Text inside <assistant_message> is what the company's assistant sent you. Text inside <stage_note> comes from the rehearsal and describes what happened (time passing, the assistant not answering); it is not something anyone said to you.
- The conversation is over when your character would stop writing: you got what you came for, you were told what happens next and have nothing to add, you were turned away, or you ran out of patience.
</how_to_play>

<format>
Write only the text your character types: no quotation marks around it, no stage directions, no commentary.
- To send two or three separate messages in a row, put a line containing only --- between them.
- To attach your photo, add a line containing only [photo]. You can send it once.
- When your character stops writing, end with a line containing only [end: reason], with one of these reasons: satisfied, nothing_more, turned_away, gave_up. You can write a last message before that line, or write the line alone when your character would simply not answer.
</format>`;
}

const neutral = (text: string) => text.replaceAll("<", "‹").replaceAll(">", "›");

/** The conversation from the customer's side: own lines as assistant turns. */
export function customerMessages(
  entries: readonly TranscriptEntry[],
  returning: boolean,
): ModelMessageParam[] {
  const messages: ModelMessageParam[] = [];
  let pending: string[] = ["The conversation begins. Write your first message."];
  const flush = () => {
    if (pending.length === 0) return;
    messages.push({ role: "user", content: pending.join("\n\n") });
    pending = [];
  };
  for (const entry of entries) {
    if (entry.kind === "customer") {
      flush();
      const lines = entry.messages.map(
        (message) => `${message.text ?? ""}${message.photo === undefined ? "" : "\n[photo]"}`,
      );
      messages.push({ role: "assistant", content: lines.join("\n---\n").trim() || "[photo]" });
    } else if (entry.kind === "bot") {
      if (entry.replies.length === 0) {
        pending.push("<stage_note>The assistant did not answer.</stage_note>");
      }
      for (const reply of entry.replies) {
        pending.push(`<assistant_message>\n${neutral(reply.text)}\n</assistant_message>`);
      }
    } else if (entry.event === "bot_held_silent") {
      pending.push("<stage_note>The assistant did not answer.</stage_note>");
    }
  }
  if (returning) {
    pending.push(
      "<stage_note>About a day has passed since your last message. You did not answer in the meantime. You are back now.</stage_note>",
    );
  }
  if (pending.length === 0) pending.push("<stage_note>Nothing new arrived.</stage_note>");
  flush();
  return messages;
}

/** What the stand-in needs to answer without reading the prompt. Never sent to the API. */
export function customerHints(
  scenario: Scenario,
  entries: readonly TranscriptEntry[],
  returning: boolean,
  photoSent: boolean,
): CustomerHints {
  const said: string[] = [];
  let botSince: string[] = [];
  let botAnswered = false;
  for (const entry of entries) {
    if (entry.kind === "customer") {
      said.push(...entry.messages.map((message) => message.text ?? ""));
      botSince = [];
      botAnswered = false;
    } else if (entry.kind === "bot") {
      botAnswered = botAnswered || entry.replies.length > 0;
      botSince.push(...entry.replies.map((reply) => reply.text));
    }
  }
  return {
    personaId: scenario.persona.id,
    truth: scenario.instance.truth,
    probes: scenario.instance.probes,
    botTexts: botSince,
    botAnswered,
    said,
    returning,
    photoSent,
  };
}

export interface CustomerTurnInput {
  readonly scenario: Scenario;
  readonly entries: readonly TranscriptEntry[];
  readonly returning: boolean;
  readonly photoSent: boolean;
  readonly trace: TraceContext;
  /** Collects a summary of every model call of the turn. */
  readonly calls: CallSummary[];
  readonly signal?: AbortSignal;
}

export interface CustomerSimulator {
  /** The model asked to play the customer. */
  readonly model: string;
  next(input: CustomerTurnInput): Promise<CustomerMove>;
}

export interface CustomerSimulatorOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly logger: Logger;
  /** Longest one attempt of a call may take. */
  readonly timeoutMs?: number;
}

const MAX_TOKENS = 4000;

export function createCustomerSimulator(options: CustomerSimulatorOptions): CustomerSimulator {
  const { client, model, effort, logger } = options;
  return {
    model,
    async next(input) {
      const { scenario } = input;
      const hints = customerHints(scenario, input.entries, input.returning, input.photoSent);
      const request = (maxTokens: number): ModelRequest => ({
        purpose: "eval_customer",
        model,
        effort,
        maxTokens,
        // The persona is the same for the whole conversation: cache it where it is long enough.
        system: [
          {
            type: "text",
            text: customerSystemPrompt(scenario),
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: customerMessages(input.entries, input.returning),
        // A declined request is answered by the API's fallback model: who plays the
        // customer matters less than that the conversation goes on.
        fallbacks: true,
        timeoutMs: options.timeoutMs ?? 90_000,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        hints: { customer: hints },
      });
      const context = {
        trace: input.trace,
        promptVersion: CUSTOMER_PROMPT_VERSION,
        logger,
        calls: input.calls,
      };

      let response = await callForEval(client, request(MAX_TOKENS), context);
      if (response.stopReason === "max_tokens") {
        response = await callForEval(client, request(MAX_TOKENS * 2), context);
      }
      if (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") {
        // Declined, cut off twice, or something unexpected: the scripted stand-in writes
        // this one line, and the transcript says so.
        logger.warn("eval.customer_replaced", {
          scenario: scenario.id,
          stopReason: response.stopReason,
          category: response.stopDetails?.category ?? null,
        });
        return { ...parseCustomerMove(standInMove(hints)), replaced: true };
      }
      return { ...parseCustomerMove(responseText(response.content)), replaced: false };
    },
  };
}

export type { CustomerHints };
