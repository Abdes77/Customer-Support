import type { ConversationTurn, TurnAttachment } from "@repo/core";

import { localMoment } from "../hours";
import type { ModelCacheControl, ModelMessageParam } from "../model/types";
import { dataLine, dataText } from "./text";

/**
 * The conversation as messages for the model (docs/ARCHITECTURE.md §5, "History").
 *
 * - A customer's message, and a message a person at the business wrote, are `user` content
 *   inside a tag, with angle brackets neutralized: nothing a customer types can close the tag
 *   or look like an instruction block.
 * - The bot's own earlier replies are `assistant` content, exactly as they were sent and
 *   with nothing added, so the model never learns to decorate its replies.
 * - Consecutive messages of the same side become one message with one text block.
 * - Photos appear as what an earlier analysis recorded about them.
 *
 * Rendering depends only on the stored messages and the business's time zone, so the same
 * history gives the same bytes on every turn and the prompt cache can reuse it.
 */

const WEEKDAY_SHORT: Readonly<Record<string, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function stamp(sentAt: string, timeZone: string): string {
  const moment = localMoment(new Date(sentAt), timeZone);
  return `${WEEKDAY_SHORT[moment.weekday] ?? ""} ${moment.date} ${moment.time}`.trim();
}

function renderAttachment(attachment: TurnAttachment): string {
  const analysis = attachment.analysis?.trim() ?? "";
  const state =
    analysis.length > 0 ? "analyzed" : attachment.storage === null ? "unavailable" : "not_analyzed";
  const head = `<attachment id="${dataLine(attachment.id)}" kind="${attachment.kind}" state="${state}"`;
  return analysis.length > 0 ? `${head}>${dataText(analysis)}</attachment>` : `${head}/>`;
}

function renderIncoming(turn: ConversationTurn, timeZone: string): string {
  const tag = turn.author === "human_agent" ? "team_member_message" : "customer_message";
  const subject =
    turn.subject === null || turn.subject.trim().length === 0
      ? ""
      : ` subject="${dataLine(turn.subject)}"`;
  const body: string[] = [];
  const text = turn.text === null ? "" : dataText(turn.text);
  if (text.length > 0) body.push(text);
  for (const attachment of turn.attachments) body.push(renderAttachment(attachment));
  if (body.length === 0) body.push("(a message without text that cannot be shown here)");
  return `<${tag} sent="${stamp(turn.sentAt, timeZone)}"${subject}>\n${body.join("\n")}\n</${tag}>`;
}

/** The customer's side of the conversation as one block of text (several messages joined). */
export function renderIncomingTurns(turns: readonly ConversationTurn[], timeZone: string): string {
  return turns.map((turn) => renderIncoming(turn, timeZone)).join("\n");
}

const OPENED_BY_BUSINESS =
  "<conversation_note>The conversation starts with a message from the business.</conversation_note>";

/**
 * The answered part of the conversation. The last block carries the cache breakpoint: on
 * the next turn the same blocks come back unchanged, followed by what was said since.
 */
export function renderHistory(
  history: readonly ConversationTurn[],
  timeZone: string,
  cacheControl: ModelCacheControl | null,
): ModelMessageParam[] {
  const messages: ModelMessageParam[] = [];
  let role: "user" | "assistant" | null = null;
  let parts: string[] = [];
  const flush = () => {
    if (role === null || parts.length === 0) return;
    messages.push({
      role,
      content: [{ type: "text", text: parts.join(role === "assistant" ? "\n\n" : "\n") }],
    });
    parts = [];
  };

  for (const turn of history) {
    const turnRole = turn.author === "bot" ? "assistant" : "user";
    const text = turn.author === "bot" ? (turn.text ?? "").trim() : renderIncoming(turn, timeZone);
    if (text.length === 0) continue;
    if (turnRole !== role) {
      flush();
      role = turnRole;
    }
    parts.push(text);
  }
  flush();

  // The API wants the first message to come from the user side.
  if (messages[0]?.role === "assistant") {
    messages.unshift({ role: "user", content: [{ type: "text", text: OPENED_BY_BUSINESS }] });
  }

  const last = messages.at(-1);
  if (cacheControl !== null && last !== undefined && Array.isArray(last.content)) {
    const block = last.content.at(-1);
    if (block?.type === "text") block.cache_control = cacheControl;
  }
  return messages;
}

/** Facts about the conversation that the turn context and the output guard need. */
export interface ConversationFacts {
  /** Messages the bot has sent so far. */
  readonly botMessages: number;
  /** Question marks in the bot's messages: a fair count of the questions it has asked. */
  readonly questionsAsked: number;
  /** The last message of the history is from the customer, with no answer after it. */
  readonly lastIsUnanswered: boolean;
  /** When the customer last wrote (history and pending), or null. */
  readonly lastCustomerAt: string | null;
  /** Rounds of bot messages since the customer last wrote: 1 is the reply, 2 the first nudge. */
  readonly botRoundsSinceCustomer: number;
  /** When the bot last wrote, or null. */
  readonly lastBotAt: string | null;
}

const SAME_ROUND_MS = 90_000;

export function conversationFacts(
  history: readonly ConversationTurn[],
  pending: readonly ConversationTurn[],
): ConversationFacts {
  const bot = history.filter((turn) => turn.author === "bot");
  const questionsAsked = bot.reduce(
    (total, turn) => total + (turn.text?.match(/\?/g)?.length ?? 0),
    0,
  );
  const lastCustomerIndex = history.findLastIndex((turn) => turn.author === "customer");
  const after = history.slice(lastCustomerIndex + 1).filter((turn) => turn.author === "bot");
  let rounds = 0;
  let previous: number | null = null;
  for (const turn of after) {
    const at = Date.parse(turn.sentAt);
    if (previous === null || at - previous > SAME_ROUND_MS) rounds += 1;
    previous = at;
  }
  const lastCustomer =
    pending.findLast((turn) => turn.author === "customer") ??
    (lastCustomerIndex >= 0 ? history[lastCustomerIndex] : undefined);
  return {
    botMessages: bot.length,
    questionsAsked,
    lastIsUnanswered: history.at(-1)?.author === "customer",
    lastCustomerAt: lastCustomer?.sentAt ?? null,
    botRoundsSinceCustomer: rounds,
    lastBotAt: bot.at(-1)?.sentAt ?? null,
  };
}

/** Everything the customer wrote in the given turns, as plain text (for look-ups and hints). */
export function customerText(turns: readonly ConversationTurn[]): string {
  return turns
    .filter((turn) => turn.author === "customer")
    .map((turn) => [turn.subject, turn.text].filter(Boolean).join("\n"))
    .filter((text) => text.length > 0)
    .join("\n");
}
