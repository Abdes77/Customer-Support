import type Anthropic from "@anthropic-ai/sdk";

import type { ModelCallRecord } from "@repo/core";
import type { EffortLevel } from "@repo/settings";

/**
 * The model client port. Everything in the product that calls Claude builds a `ModelRequest`
 * and hands it to a `ModelClient`: the Anthropic SDK in production, a scripted client in
 * tests, the offline client on a developer machine without a key.
 *
 * The request and response reuse the SDK's own types for messages, content blocks and tools
 * (the beta namespace, which is a superset: it has `role: "system"` messages and the
 * `fallback` block). What the port fixes are the rules of docs/ARCHITECTURE.md §5: effort is
 * always explicit, there is no `thinking`, sampling or forced tool choice to set, and the
 * stop reason is always handed back.
 */

export type ModelSystemBlock = Anthropic.Beta.BetaTextBlockParam;
export type ModelMessageParam = Anthropic.Beta.BetaMessageParam;
export type ModelContentBlock = Anthropic.Beta.BetaContentBlock;
export type ModelContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ModelToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type ModelToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
/** A tool we define and execute ourselves. */
export type ModelTool = Anthropic.Beta.BetaTool;
/** Our tools and Anthropic's server tools (web search for playbook generation, C6). */
export type ModelToolUnion = Anthropic.Beta.BetaToolUnion;
export type ModelStopReason = Anthropic.Beta.BetaStopReason;
export type ModelCacheControl = Anthropic.Beta.BetaCacheControlEphemeral;

export type ModelUsage = ModelCallRecord["usage"];

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

export interface ModelRequest {
  /** What the call is for; a `ModelTask` from settings or a caller's own name ("eval_judge"). */
  readonly purpose: string;
  readonly model: string;
  /** Sent as `output_config.effort`, always. */
  readonly effort: EffortLevel;
  /** Upper bound for thinking plus text. */
  readonly maxTokens: number;
  /** Rendered after the tools and before the messages. Cache breakpoints are set by the caller. */
  readonly system: readonly ModelSystemBlock[];
  readonly messages: readonly ModelMessageParam[];
  /** In the order they are sent. Keep it stable: tools are the first bytes of the cached prefix. */
  readonly tools?: readonly ModelToolUnion[];
  /** "auto" (the default) or "none". Forcing a tool is rejected by the current models. */
  readonly toolChoice?: "auto" | "none";
  /** Let the API retry a declined request on its default fallback model (ARCHITECTURE §5). */
  readonly fallbacks?: boolean;
  /** Stream and collect the final message. Default: only for large `maxTokens`. */
  readonly stream?: boolean;
  /** Longest one attempt may take, in milliseconds. */
  readonly timeoutMs?: number;
  /** Aborts the call, retries included (the turn's deadline). */
  readonly signal?: AbortSignal;
  /**
   * Never sent to the API. Facts about the request in structured form, so a scripted or
   * offline client can answer without parsing the prompt.
   */
  readonly hints?: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  /** The API's message id, when there is one. */
  readonly id: string | null;
  /** The model that produced the message (a fallback model after a declined request). */
  readonly model: string;
  readonly content: readonly ModelContentBlock[];
  /** Always check this before reading `content`. */
  readonly stopReason: ModelStopReason | null;
  /** Present only on a refusal, and even then possibly null. */
  readonly stopDetails: {
    readonly category: string | null;
    readonly explanation: string | null;
  } | null;
  /** Every attempt of the call added up (a fallback has two). */
  readonly usage: ModelUsage;
  /** Provider request id, for support tickets. */
  readonly requestId: string | null;
  /** True when a fallback model served the response. */
  readonly fellBack: boolean;
}

export interface ModelClient {
  /** Shown in logs: "anthropic", "scripted", "offline". */
  readonly name: string;
  call(request: ModelRequest): Promise<ModelResponse>;
}

/** Model families that accept `role: "system"` messages inside `messages` (no beta header). */
const MID_CONVERSATION_SYSTEM_PREFIXES = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

/**
 * Whether operator text may be appended as a `role: "system"` message. Unknown models get
 * the conservative answer: the text then goes into the user turn inside a delimited block.
 */
export function supportsMidConversationSystem(model: string): boolean {
  return MID_CONVERSATION_SYSTEM_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** Older models that reject `output_config.effort`. Every current model takes it. */
const NO_EFFORT_PREFIXES = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3"];

/** Whether the model accepts an effort level. Unknown models are assumed to. */
export function supportsEffort(model: string): boolean {
  return !NO_EFFORT_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/**
 * Whether the server-side `fallbacks` parameter may be sent. Claude Haiku models have no
 * server-side fallback: the API documents not sending the parameter to them (a fallback list
 * is rejected, and "default" does nothing). Unknown models are assumed to have one.
 */
export function supportsServerSideFallbacks(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

/** The text of a response: every text block after the last fallback boundary, joined. */
export function responseText(content: readonly ModelContentBlock[]): string {
  return blocksAfterFallback(content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

/** The tool calls to run: only those after the last fallback boundary. */
export function responseToolUses(content: readonly ModelContentBlock[]): ModelToolUseBlock[] {
  return blocksAfterFallback(content).flatMap((block) =>
    block.type === "tool_use" ? [block] : [],
  );
}

function lastFallbackIndex(content: readonly ModelContentBlock[]): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === "fallback") return index;
  }
  return -1;
}

function blocksAfterFallback(content: readonly ModelContentBlock[]): ModelContentBlock[] {
  return content.slice(lastFallbackIndex(content) + 1);
}

/**
 * The assistant turn to send back inside one tool loop. Content is echoed unchanged, thinking
 * blocks included, with one exception from the API's fallback rules: thinking and client
 * tool calls that a declining model produced before the last `fallback` block are left out
 * (the block itself stays where it was).
 */
export function assistantEcho(content: readonly ModelContentBlock[]): ModelContentBlockParam[] {
  const boundary = lastFallbackIndex(content);
  const echoed: ModelContentBlockParam[] = [];
  content.forEach((block, index) => {
    if (
      index < boundary &&
      (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "tool_use")
    ) {
      return;
    }
    echoed.push(block);
  });
  return echoed;
}
