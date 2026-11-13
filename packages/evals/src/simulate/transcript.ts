import type {
  EngineTurnDiagnostics,
  ExecutedAction,
  LeadSnapshot,
  RoutingOutcome,
  TurnTrigger,
} from "@repo/core";

/**
 * A conversation as the evaluation keeps it: what the customer wrote, what the bot would
 * have sent, what the bot did (its actions with their outcomes), and what the harness did
 * around them. It is the one thing every grader reads, the thing saved with the results and
 * the thing the report shows.
 */

/** Tokens of one or more model calls, as the API reports them. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

/** One model call, without its prompt: who answered, how it stopped, what it cost. */
export interface CallSummary {
  readonly purpose: string;
  /** The model that answered (a fallback model after a declined request). */
  readonly model: string;
  readonly stopReason: string | null;
  readonly usage: Usage;
  readonly latencyMs: number;
  readonly error: string | null;
}

export interface CustomerMessage {
  readonly text: string | null;
  /** What the attached photo shows, when one was sent. */
  readonly photo?: string;
  readonly subject?: string;
}

/** Where a customer line came from. */
export type CustomerSource = "opening" | "scripted" | "simulated" | "stand_in";

export interface CustomerEntry {
  readonly kind: "customer";
  /** Customer turn, counted from 1. */
  readonly turn: number;
  readonly at: string;
  readonly source: CustomerSource;
  readonly messages: readonly CustomerMessage[];
}

export interface BotReply {
  readonly text: string;
  readonly subject?: string | null;
  readonly quickReplies?: readonly string[];
}

export interface BotEntry {
  readonly kind: "bot";
  /** The customer turn this answers; for a follow-up, the last customer turn before it. */
  readonly turn: number;
  readonly at: string;
  readonly trigger: TurnTrigger;
  readonly outcome: "replied" | "no_reply" | "refused" | "failed";
  readonly replies: readonly BotReply[];
  readonly actions: readonly ExecutedAction[];
  readonly diagnostics: EngineTurnDiagnostics | null;
  /** The routing decision in force after the turn. */
  readonly routing: RoutingOutcome | null;
  readonly leadStatus: string;
  /** True on the bot's first message of the conversation. */
  readonly first: boolean;
  readonly usage: Usage;
  readonly latencyMs: number;
  readonly calls: readonly CallSummary[];
}

export type HarnessEvent =
  /** The customer stopped answering; follow-ups are due. */
  | "customer_silent"
  | "customer_returned"
  /** Production keeps the bot silent here: a person holds the conversation, or the bot ended it. */
  | "bot_held_silent"
  | "simulator_replaced";

export interface EventEntry {
  readonly kind: "event";
  readonly at: string;
  readonly event: HarnessEvent;
  readonly note: string;
}

export type TranscriptEntry = CustomerEntry | BotEntry | EventEntry;

/** Why the conversation stopped. */
export type EndReason =
  | "customer_left"
  | "script_finished"
  | "handed_off"
  | "bot_stopped_replying"
  | "refused"
  | "engine_failed"
  | "max_turns";

export interface Transcript {
  readonly scenarioId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly ended: EndReason;
  /** Why the simulated customer left, when they did. */
  readonly leaveReason: string | null;
  readonly lead: LeadSnapshot;
  readonly handedOff: boolean;
  readonly photosSent: number;
  readonly promptVersion: string;
  readonly usage: { readonly engine: Usage; readonly customer: Usage };
  /**
   * What the calls cost at list prices, in millionths of a US dollar, from the tokens each
   * call reported and the model that answered it. Null where a model has no known price
   * (the stand-ins).
   */
  readonly costMicroUsd: { readonly engine: number | null; readonly customer: number | null };
  /** The model that wrote the replies, as the API named it; null when the bot never called one. */
  readonly engineModels: readonly string[];
  readonly customerModels: readonly string[];
  /** Attempts beyond the first that a turn or a customer line needed. */
  readonly retries: number;
}

export function botEntries(transcript: Pick<Transcript, "entries">): BotEntry[] {
  return transcript.entries.filter((entry): entry is BotEntry => entry.kind === "bot");
}

export function customerEntries(transcript: Pick<Transcript, "entries">): CustomerEntry[] {
  return transcript.entries.filter((entry): entry is CustomerEntry => entry.kind === "customer");
}

/** Every text the bot would have sent, in order. */
export function botTexts(transcript: Pick<Transcript, "entries">): string[] {
  return botEntries(transcript).flatMap((entry) => entry.replies.map((reply) => reply.text));
}

/** Every action of the conversation, in order. */
export function allActions(transcript: Pick<Transcript, "entries">): ExecutedAction[] {
  return botEntries(transcript).flatMap((entry) => [...entry.actions]);
}

/** Actions that took effect: applied now, or accepted for right after the turn. */
export function effective(actions: readonly ExecutedAction[]): ExecutedAction[] {
  return actions.filter(
    (entry) => entry.outcome.status === "applied" || entry.outcome.status === "deferred",
  );
}
