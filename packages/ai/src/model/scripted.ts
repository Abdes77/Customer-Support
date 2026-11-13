import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
} from "./types";

/**
 * A model client that plays back responses written (or recorded) in the API's own response
 * format, and keeps every request it was given. It is the mock for tests in this package and
 * in every package that calls the model (BUILD_PLAN: C5, C6, C7, C13).
 *
 *   const model = createScriptedModelClient([
 *     scriptedResponse([toolUse("update_lead_fields", { fields: [...] })]),
 *     scriptedResponse([text("Got it. What's the ZIP code?")]),
 *   ]);
 *   ...
 *   expect(model.requests).toHaveLength(2);
 */

export type ScriptedStep =
  | ModelResponse
  | Error
  | ((request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>);

export interface ScriptedModelClient extends ModelClient {
  /** Every request so far, oldest first. */
  readonly requests: ModelRequest[];
  /** Steps not played yet. */
  remaining(): number;
  /** Adds steps to the end of the script. */
  push(...steps: ScriptedStep[]): void;
}

export function createScriptedModelClient(
  steps: readonly ScriptedStep[] = [],
  options: {
    /** Answers when the script has run out. Default: an error that names the request. */
    readonly fallback?: (request: ModelRequest, index: number) => ModelResponse;
  } = {},
): ScriptedModelClient {
  const queue: ScriptedStep[] = [...steps];
  const requests: ModelRequest[] = [];
  return {
    name: "scripted",
    requests,
    remaining: () => queue.length,
    push: (...more) => {
      queue.push(...more);
    },
    async call(request) {
      const index = requests.length;
      requests.push(request);
      const step = queue.shift();
      if (step === undefined) {
        if (options.fallback !== undefined) return options.fallback(request, index);
        throw new Error(
          `The scripted model has no response left for request ${index + 1} (${request.purpose}).`,
        );
      }
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(request, index) : step;
    },
  };
}

let toolCallCounter = 0;

/** A `text` block as the API returns it. */
export function text(value: string): ModelContentBlock {
  return { type: "text", text: value, citations: null };
}

/** A `tool_use` block. Ids are unique per process unless one is given. */
export function toolUse(name: string, input: unknown, id?: string): ModelContentBlock {
  toolCallCounter += 1;
  return {
    type: "tool_use",
    id: id ?? `toolu_test_${String(toolCallCounter).padStart(4, "0")}`,
    name,
    input,
  };
}

/** A thinking block as the current models return it by default: empty text, a signature. */
export function thinking(signature = "sig_test"): ModelContentBlock {
  return { type: "thinking", thinking: "", signature };
}

/** The boundary block the API inserts when a fallback model took over. */
export function fallbackBlock(from: string, to: string): ModelContentBlock {
  return {
    type: "fallback",
    from: { model: from },
    to: { model: to },
    trigger: { type: "refusal", category: null },
  } as unknown as ModelContentBlock;
}

export interface ScriptedResponseOptions {
  readonly stopReason?: ModelStopReason | null;
  readonly usage?: Partial<ModelUsage>;
  readonly model?: string;
  readonly stopCategory?: string | null;
  readonly fellBack?: boolean;
}

/**
 * A response with the stop reason the blocks imply: "tool_use" when a tool is called,
 * otherwise "end_turn".
 */
export function scriptedResponse(
  content: readonly ModelContentBlock[],
  options: ScriptedResponseOptions = {},
): ModelResponse {
  const stopReason =
    options.stopReason === undefined
      ? content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn"
      : options.stopReason;
  return {
    id: "msg_scripted",
    model: options.model ?? "claude-fable-5-2",
    content,
    stopReason,
    stopDetails:
      stopReason === "refusal"
        ? { category: options.stopCategory ?? null, explanation: null }
        : null,
    usage: {
      inputTokens: 120,
      outputTokens: 60,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      ...options.usage,
    },
    requestId: "req_scripted",
    fellBack: options.fellBack ?? content.some((block) => block.type === "fallback"),
  };
}

/** A refusal: no usable content, `stop_reason: "refusal"`. */
export function scriptedRefusal(category: string | null = null): ModelResponse {
  return scriptedResponse([], { stopReason: "refusal", stopCategory: category });
}
