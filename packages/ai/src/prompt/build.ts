import type { EngineTurnInput, KnowledgeFact } from "@repo/core";
import type { AppSettings } from "@repo/settings";

import type { TurnSituation } from "../engine/situation";
import {
  type ModelCacheControl,
  type ModelMessageParam,
  type ModelSystemBlock,
  type ModelTool,
  supportsMidConversationSystem,
} from "../model/types";
import { modelTools } from "../tools/definitions";
import { renderBusinessBlock } from "./business-block";
import { renderHistory, renderIncomingTurns } from "./conversation";
import { CURRENT_REPLY_PROMPT } from "./core";
import { renderPlaybookBlock } from "./playbook-block";
import { renderTurnContext } from "./turn-context";

/**
 * Puts one request together in the order the prompt cache needs (docs/ARCHITECTURE.md §5):
 *
 *   tools (sorted)                       \
 *   system[0] core prompt        cache 1  } the same for every business
 *   system[1] playbook           cache 2    the same for every business of the segment
 *   system[2] business section   cache 3    the same until the business is edited
 *   messages  history            cache 4    grows by one turn at a time
 *   messages  newest customer messages      never cached
 *   messages  turn context (system)         never cached
 *
 * At most four breakpoints exist, and all four are used. A longer cache lifetime must come
 * before a shorter one, so the three system blocks share the lifetime from settings and the
 * history always uses the default five minutes.
 */

export interface PromptInput {
  readonly input: EngineTurnInput;
  readonly values: AppSettings;
  readonly situation: TurnSituation;
  /** The business's core facts, in the retriever's stable order. */
  readonly coreFacts: readonly KnowledgeFact[];
  /** Facts looked up for this turn, without the core ones. */
  readonly turnFacts: readonly KnowledgeFact[];
  readonly model: string;
  readonly strictTools: boolean;
}

export interface BuiltPrompt {
  readonly system: ModelSystemBlock[];
  readonly tools: ModelTool[];
  readonly messages: ModelMessageParam[];
  /** True: operator text goes into `role: "system"` messages. False: into the user turn. */
  readonly systemChannel: boolean;
}

const NO_NEW_MESSAGE =
  "<conversation_note>There is no new customer message. The turn context says what this turn is for.</conversation_note>";

function systemCache(values: AppSettings): ModelCacheControl {
  return values["model.cache_ttl"] === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

/** The three cached system blocks. Exported for the tests that pin their stability. */
export function buildSystemBlocks(
  prompt: Pick<PromptInput, "input" | "values" | "situation" | "coreFacts">,
): ModelSystemBlock[] {
  const cache = systemCache(prompt.values);
  return [
    { type: "text", text: CURRENT_REPLY_PROMPT.text, cache_control: cache },
    {
      type: "text",
      text: renderPlaybookBlock(prompt.input.playbook, prompt.input.business),
      cache_control: cache,
    },
    {
      type: "text",
      text: renderBusinessBlock({
        business: prompt.input.business,
        values: prompt.values,
        coreFacts: prompt.coreFacts,
        catalogue: prompt.situation.catalogue,
      }),
      cache_control: cache,
    },
  ];
}

export function buildPrompt(prompt: PromptInput): BuiltPrompt {
  const { input, situation } = prompt;
  const systemChannel = supportsMidConversationSystem(prompt.model);
  const messages = renderHistory(input.history, input.business.timezone, { type: "ephemeral" });
  const newest =
    input.pending.length > 0
      ? renderIncomingTurns(input.pending, input.business.timezone)
      : NO_NEW_MESSAGE;
  const context = renderTurnContext({ input, situation, facts: prompt.turnFacts });

  if (systemChannel) {
    messages.push({ role: "user", content: [{ type: "text", text: newest }] });
    messages.push({ role: "system", content: context });
  } else {
    // Without a system channel inside the conversation, the context is the last block of the
    // user turn. Customer text cannot imitate it: its angle brackets are neutralized.
    messages.push({
      role: "user",
      content: [
        { type: "text", text: newest },
        { type: "text", text: context },
      ],
    });
  }

  return {
    system: buildSystemBlocks(prompt),
    tools: modelTools({ strict: prompt.strictTools }),
    messages,
    systemChannel,
  };
}

/**
 * Adds an operator instruction after the last message, without touching anything a thinking
 * block could be bound to. With a system channel: a `role: "system"` message after the user
 * turn (merged into the turn context when that is still the last message). Without one: a
 * delimited text block at the end of the user turn.
 */
export function withOperatorNote(
  messages: readonly ModelMessageParam[],
  note: string,
  systemChannel: boolean,
): ModelMessageParam[] {
  const last = messages.at(-1);
  if (last === undefined) return [...messages];
  const head = messages.slice(0, -1);
  if (systemChannel) {
    if (last.role === "system" && typeof last.content === "string") {
      return [...head, { role: "system", content: `${last.content}\n\n${note}` }];
    }
    if (last.role === "user") return [...messages, { role: "system", content: note }];
    return [
      ...messages,
      { role: "user", content: [{ type: "text", text: NO_NEW_MESSAGE }] },
      { role: "system", content: note },
    ];
  }
  const block = { type: "text" as const, text: `<operator_note>\n${note}\n</operator_note>` };
  if (last.role === "user") {
    const content =
      typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content }, block]
        : [...last.content, block];
    return [...head, { role: "user", content }];
  }
  return [...messages, { role: "user", content: [block] }];
}
