import Anthropic from "@anthropic-ai/sdk";

import { ConfigError, ExternalServiceError } from "@repo/core";

import {
  type ModelClient,
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  supportsEffort,
  supportsServerSideFallbacks,
  ZERO_USAGE,
} from "./types";

/** The beta that carries `fallbacks: "default"` (docs/ARCHITECTURE.md §5). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Above this, a request is streamed: a long non-streaming response can outlive idle timeouts. */
const STREAM_ABOVE_MAX_TOKENS = 20_000;

const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicModelClientOptions {
  readonly apiKey: string;
  /** Proxies and tests only. */
  readonly baseUrl?: string;
  /** The SDK retries 408, 409, 429, 5xx and connection errors this many times. Default 2. */
  readonly maxRetries?: number;
  /** Longest one attempt may take when the request does not say. Default two minutes. */
  readonly defaultTimeoutMs?: number;
  /** Tests inject an SDK client (or a stand-in with the same two methods). */
  readonly client?: AnthropicMessagesApi;
}

/** The part of the SDK this file uses, so a test can stand in for it. */
export interface AnthropicMessagesApi {
  readonly beta: {
    readonly messages: {
      create(
        body: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: Anthropic.RequestOptions,
      ): PromiseLike<Anthropic.Beta.BetaMessage>;
      stream(
        body: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: Anthropic.RequestOptions,
      ): { finalMessage(): Promise<Anthropic.Beta.BetaMessage> };
    };
  };
}

/**
 * The request body for the Messages API, following docs/ARCHITECTURE.md §5: effort is always
 * sent, `thinking`, `temperature`, `top_p` and `top_k` never are, tool choice is "auto" or
 * "none", and nothing is prefilled. Exported for the tests that pin these rules.
 */
export function toMessagesRequest(
  request: ModelRequest,
): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const tools = request.tools ?? [];
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    // Always explicit: the default differs between models. (Only models from before the
    // effort parameter are sent without it; they would reject the request.)
    ...(supportsEffort(request.model) ? { output_config: { effort: request.effort } } : {}),
    system: [...request.system],
    messages: [...request.messages],
    ...(tools.length > 0
      ? { tools: [...tools], tool_choice: { type: request.toolChoice ?? "auto" } }
      : {}),
    ...(request.fallbacks === true && supportsServerSideFallbacks(request.model)
      ? { fallbacks: "default" as const, betas: [SERVER_SIDE_FALLBACK_BETA] }
      : {}),
  };
}

function usageOf(usage: Anthropic.Beta.BetaUsage): { usage: ModelUsage; fellBack: boolean } {
  const iterations = usage.iterations ?? [];
  const attempts = iterations.filter(
    (entry) => entry.type === "message" || entry.type === "fallback_message",
  );
  const fellBack = iterations.some((entry) => entry.type === "fallback_message");
  if (attempts.length === 0) {
    return {
      fellBack,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
  // With a fallback the top-level usage covers only the attempt that answered; the
  // iterations are what is billed.
  let total = ZERO_USAGE;
  for (const entry of attempts) {
    total = {
      inputTokens: total.inputTokens + entry.input_tokens,
      outputTokens: total.outputTokens + entry.output_tokens,
      cacheReadInputTokens: total.cacheReadInputTokens + entry.cache_read_input_tokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + entry.cache_creation_input_tokens,
    };
  }
  return { usage: total, fellBack };
}

/** The API's message as the port's response. Exported for tests and recorded fixtures. */
export function fromMessagesResponse(
  message: Anthropic.Beta.BetaMessage & { _request_id?: string | null },
): ModelResponse {
  const { usage, fellBack } = usageOf(message.usage);
  const content: readonly ModelContentBlock[] = message.content;
  return {
    id: message.id,
    model: message.model,
    content,
    stopReason: message.stop_reason,
    stopDetails:
      message.stop_details === null || message.stop_details === undefined
        ? null
        : {
            category: message.stop_details.category ?? null,
            explanation: message.stop_details.explanation ?? null,
          },
    usage,
    requestId: message._request_id ?? null,
    fellBack: fellBack || content.some((block) => block.type === "fallback"),
  };
}

function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/**
 * An SDK error as an `AppError` with a deliberate `retryable`: timeouts, connection errors,
 * 408, 409, 429 and 5xx (529 "overloaded" included) can succeed later; a 400, 401, 403 or
 * 404 cannot, however often the job retries. The message never contains request content.
 */
export function toModelError(error: unknown, model: string): Error {
  const details = { model };
  if (error instanceof Anthropic.APIUserAbortError) {
    return new ExternalServiceError("The model call was stopped at its deadline.", {
      provider: "anthropic",
      retryable: true,
      cause: error,
      details: { ...details, reason: "deadline" },
    });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ExternalServiceError("The model call timed out.", {
      provider: "anthropic",
      status: 408,
      cause: error,
      details: { ...details, reason: "timeout" },
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ExternalServiceError("The Claude API could not be reached.", {
      provider: "anthropic",
      retryable: true,
      cause: error,
      details: { ...details, reason: "connection" },
    });
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ConfigError(
      "The Claude API rejected the API key. Check ANTHROPIC_API_KEY (docs/HUMAN_TODO.md).",
      { cause: error, details: { ...details, status: 401 } },
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const headers: unknown = error.headers;
    const retryAfter = retryAfterSeconds(headers instanceof Headers ? headers : undefined);
    return new ExternalServiceError(
      `The Claude API answered ${status ?? "with an error"}${error.type ? ` (${error.type})` : ""}.`,
      {
        provider: "anthropic",
        ...(status === undefined ? {} : { status }),
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
        // 409 is retried by the SDK as well; the generic rule covers 408, 429 and 5xx.
        ...(status === 409 ? { retryable: true } : {}),
        cause: error,
        details: { ...details, status: status ?? null, type: error.type ?? null },
      },
    );
  }
  return error instanceof Error ? error : new Error("The model call failed.", { cause: error });
}

/**
 * The model client for the Claude API, on the official SDK. It makes exactly one logical call
 * per `call()`: the SDK's own retries cover transient failures, bounded by the request's
 * timeout per attempt and by its abort signal overall.
 */
export function createAnthropicModelClient(options: AnthropicModelClientOptions): ModelClient {
  let sdk: AnthropicMessagesApi | undefined = options.client;
  const maxRetries = options.maxRetries ?? 2;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  function client(): AnthropicMessagesApi {
    // Built on first use: constructing the SDK client has no side effect, but a process that
    // never calls the model (most tests) should not need one.
    sdk ??= new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      maxRetries,
    });
    return sdk;
  }

  return {
    name: "anthropic",
    async call(request) {
      const body = toMessagesRequest(request);
      const requestOptions: Anthropic.RequestOptions = {
        timeout: request.timeoutMs ?? defaultTimeoutMs,
        maxRetries,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const stream = request.stream ?? request.maxTokens > STREAM_ABOVE_MAX_TOKENS;
      try {
        const message = stream
          ? await client().beta.messages.stream(body, requestOptions).finalMessage()
          : await client().beta.messages.create(body, requestOptions);
        return fromMessagesResponse(message);
      } catch (error) {
        throw toModelError(error, request.model);
      }
    },
  };
}
