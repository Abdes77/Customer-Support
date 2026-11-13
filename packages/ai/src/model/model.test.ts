import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  type AgencyId,
  AppError,
  type BusinessId,
  ConfigError,
  createLogger,
  ExternalServiceError,
  type LogRecord,
  type ModelCallRecord,
  type TraceId,
} from "@repo/core";
import { loadEnv } from "@repo/core/env";

import {
  type AnthropicMessagesApi,
  createAnthropicModelClient,
  fromMessagesResponse,
  SERVER_SIDE_FALLBACK_BETA,
  toMessagesRequest,
  toModelError,
} from "./anthropic-client";
import { callModel } from "./call";
import { createModelClientFromEnv, modelModeFromEnv } from "./from-env";
import { estimateCostMicroUsd } from "./pricing";
import {
  createScriptedModelClient,
  fallbackBlock,
  scriptedResponse,
  text,
  thinking,
  toolUse,
} from "./scripted";
import {
  assistantEcho,
  type ModelRequest,
  responseText,
  responseToolUses,
  supportsMidConversationSystem,
} from "./types";

const request: ModelRequest = {
  purpose: "reply",
  model: "claude-fable-5-2",
  effort: "medium",
  maxTokens: 16_000,
  system: [{ type: "text", text: "You answer customers.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Hello" }],
  tools: [
    {
      name: "end_conversation",
      description: "Ends it.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
    },
  ],
};

function apiMessage(
  overrides: Partial<Anthropic.Beta.BetaMessage> = {},
): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-fable-5-2",
    content: [{ type: "text", text: "Hi there.", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    ...overrides,
  };
}

describe("the request sent to the Messages API (ARCHITECTURE §5)", () => {
  it("always sends effort, never thinking or sampling parameters, and never forces a tool", () => {
    const body = toMessagesRequest(request) as unknown as Record<string, unknown>;
    expect(body["output_config"]).toEqual({ effort: "medium" });
    expect(body["tool_choice"]).toEqual({ type: "auto" });
    for (const key of ["thinking", "temperature", "top_p", "top_k", "stop_sequences", "stream"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body["max_tokens"]).toBe(16_000);
    expect(body["system"]).toEqual(request.system);
    // No assistant prefill: the last message is whatever the caller built.
    expect((body["messages"] as { role: string }[]).at(-1)?.role).toBe("user");
  });

  it("uses tool_choice none when the model may only write, and omits it without tools", () => {
    expect(toMessagesRequest({ ...request, toolChoice: "none" }).tool_choice).toEqual({
      type: "none",
    });
    const bare = toMessagesRequest({ ...request, tools: [] }) as unknown as Record<string, unknown>;
    expect(bare).not.toHaveProperty("tools");
    expect(bare).not.toHaveProperty("tool_choice");
  });

  it("opts in to server-side fallbacks with the default chain and its beta, only when asked", () => {
    const withFallbacks = toMessagesRequest({ ...request, fallbacks: true });
    expect(withFallbacks.fallbacks).toBe("default");
    expect(withFallbacks.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    const without = toMessagesRequest(request) as unknown as Record<string, unknown>;
    expect(without).not.toHaveProperty("fallbacks");
    expect(without).not.toHaveProperty("betas");
  });

  it("never sends fallbacks to a Haiku model, which has no server-side fallback", () => {
    const haiku = toMessagesRequest({
      ...request,
      model: "claude-haiku-5-5",
      fallbacks: true,
    }) as unknown as Record<string, unknown>;
    expect(haiku).not.toHaveProperty("fallbacks");
    expect(haiku).not.toHaveProperty("betas");
  });

  it("leaves effort out only for a model from before the effort parameter", () => {
    const old = toMessagesRequest({ ...request, model: "claude-haiku-4-5" }) as unknown as Record<
      string,
      unknown
    >;
    expect(old).not.toHaveProperty("output_config");
    for (const model of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "a-future-model",
    ]) {
      expect(toMessagesRequest({ ...request, model }).output_config).toEqual({ effort: "medium" });
    }
  });

  it("never sends the hints", () => {
    const body = toMessagesRequest({ ...request, hints: { reply: { secret: true } } });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("createAnthropicModelClient", () => {
  function standIn(message: Anthropic.Beta.BetaMessage) {
    const calls: { kind: string; body: unknown; options: Anthropic.RequestOptions | undefined }[] =
      [];
    const client: AnthropicMessagesApi = {
      beta: {
        messages: {
          create: async (body, options) => {
            calls.push({ kind: "create", body, options });
            return Object.assign(message, { _request_id: "req_123" });
          },
          stream: (body, options) => {
            calls.push({ kind: "stream", body, options });
            return { finalMessage: async () => message };
          },
        },
      },
    };
    return { client, calls };
  }

  it("passes the timeout, the retries and the abort signal, and maps the response", async () => {
    const { client, calls } = standIn(apiMessage());
    const model = createAnthropicModelClient({ apiKey: "test", client });
    const signal = AbortSignal.timeout(60_000);
    const response = await model.call({ ...request, timeoutMs: 45_000, signal });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("create");
    expect(calls[0]?.options).toMatchObject({ timeout: 45_000, maxRetries: 2, signal });
    expect(response).toMatchObject({
      id: "msg_1",
      model: "claude-fable-5-2",
      stopReason: "end_turn",
      requestId: "req_123",
      fellBack: false,
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("streams a request with a large output limit", async () => {
    const { client, calls } = standIn(apiMessage());
    const model = createAnthropicModelClient({ apiKey: "test", client });
    await model.call({ ...request, maxTokens: 64_000 });
    expect(calls[0]?.kind).toBe("stream");
  });

  it("adds up every attempt of a call that fell back, and says which model answered", () => {
    const response = fromMessagesResponse(
      apiMessage({
        model: "claude-opus-5",
        content: [
          {
            type: "fallback",
            from: { model: "claude-fable-5-2" },
            to: { model: "claude-opus-5" },
          } as unknown as Anthropic.Beta.BetaContentBlock,
          { type: "text", text: "Hello.", citations: null },
        ],
        usage: {
          ...apiMessage().usage,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          iterations: [
            {
              type: "message",
              model: "claude-fable-5-2",
              input_tokens: 90,
              output_tokens: 0,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 0,
              cache_creation: null,
            },
            {
              type: "fallback_message",
              model: "claude-opus-5",
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 4000,
              cache_creation: null,
            },
          ],
        },
      }),
    );
    expect(response.fellBack).toBe(true);
    expect(response.model).toBe("claude-opus-5");
    expect(response.usage).toEqual({
      inputTokens: 190,
      outputTokens: 20,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 4000,
    });
  });

  it("hands a refusal back with its category instead of content", () => {
    const response = fromMessagesResponse(
      apiMessage({
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: null,
        } as Anthropic.Beta.BetaRefusalStopDetails,
      }),
    );
    expect(response.stopReason).toBe("refusal");
    expect(response.stopDetails).toEqual({ category: "cyber", explanation: null });
  });
});

describe("toModelError", () => {
  const generate = (status: number, headers: Record<string, string> = {}) =>
    Anthropic.APIError.generate(
      status,
      { type: "error", error: { type: "some_error", message: "customer text must not leak" } },
      "customer text must not leak",
      new Headers(headers),
    );

  it("marks rate limits, overloads and server errors as retryable", () => {
    const limited = toModelError(generate(429, { "retry-after": "7" }), "claude-fable-5-2");
    expect(limited).toBeInstanceOf(ExternalServiceError);
    expect(limited).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: 7 });
    for (const status of [408, 409, 500, 503, 529]) {
      expect(toModelError(generate(status), "m")).toMatchObject({ retryable: true });
    }
  });

  it("marks a bad request, a missing model and a forbidden request as final", () => {
    for (const status of [400, 403, 404, 413, 422]) {
      const error = toModelError(generate(status), "m");
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ retryable: false });
    }
  });

  it("turns a rejected key into a configuration error", () => {
    const error = toModelError(generate(401), "m");
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("treats timeouts, connection errors and our own deadline as retryable", () => {
    expect(toModelError(new Anthropic.APIConnectionTimeoutError(), "m")).toMatchObject({
      retryable: true,
    });
    expect(toModelError(new Anthropic.APIConnectionError({ message: "reset" }), "m")).toMatchObject(
      { retryable: true },
    );
    expect(toModelError(new Anthropic.APIUserAbortError(), "m")).toMatchObject({
      retryable: true,
      details: { reason: "deadline" },
    });
  });

  it("never copies the API's message, which can quote the request, into the error", () => {
    expect(toModelError(generate(400), "m").message).not.toContain("customer text");
  });
});

describe("callModel", () => {
  const trace = {
    traceId: "0e000000-0000-4000-8000-000000000009" as TraceId,
    agencyId: "0a000000-0000-4000-8000-000000000001" as AgencyId,
    businessId: "0b000000-0000-4000-8000-000000000001" as BusinessId,
    conversationId: null,
  };

  function context(storeIo = true) {
    const records: ModelCallRecord[] = [];
    const logs: LogRecord[] = [];
    const times = [new Date("2026-11-10T17:00:00.000Z"), new Date("2026-11-10T17:00:02.500Z")];
    return {
      records,
      logs,
      context: {
        trace,
        promptVersion: "reply-v1.r1",
        sink: { record: async (call: ModelCallRecord) => void records.push(call) },
        logger: createLogger({ level: "debug", sink: (record) => logs.push(record) }),
        storeIo,
        clock: () => times.shift() ?? new Date("2026-11-10T17:00:03.000Z"),
      },
    };
  }

  it("records inputs, outputs, tokens, cache reads and latency, and logs the numbers only", async () => {
    const model = createScriptedModelClient([
      scriptedResponse([text("Hi Pat.")], {
        usage: { inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 7000 },
      }),
    ]);
    const { records, logs, context: ctx } = context();
    const response = await callModel(model, request, ctx);
    expect(response.stopReason).toBe("end_turn");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "reply",
      model: "claude-fable-5-2",
      effort: "medium",
      promptVersion: "reply-v1.r1",
      startedAt: "2026-11-10T17:00:00.000Z",
      latencyMs: 2500,
      stopReason: "end_turn",
      requestId: "req_scripted",
      error: null,
      usage: { inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 7000 },
    });
    expect(JSON.stringify(records[0]?.request)).toContain("You answer customers.");
    expect(JSON.stringify(records[0]?.response)).toContain("Hi Pat.");
    const line = logs.find((entry) => entry.msg === "model.call");
    expect(line).toMatchObject({ cacheReadInputTokens: 7000, latencyMs: 2500 });
    expect(JSON.stringify(logs)).not.toContain("Hi Pat.");
    expect(JSON.stringify(logs)).not.toContain("You answer customers.");
  });

  it("records the model that answered, which can be a fallback model", async () => {
    const model = createScriptedModelClient([
      scriptedResponse([fallbackBlock("claude-fable-5-2", "claude-opus-5"), text("Hello.")], {
        model: "claude-opus-5",
      }),
    ]);
    const { records, context: ctx } = context();
    await callModel(model, request, ctx);
    expect(records[0]?.model).toBe("claude-opus-5");
    expect(JSON.stringify(records[0]?.request)).toContain('"model":"claude-fable-5-2"');
  });

  it("keeps prompts and replies out of the record when model input and output are not stored", async () => {
    const model = createScriptedModelClient([scriptedResponse([text("Hi Pat.")])]);
    const { records, context: ctx } = context(false);
    await callModel(model, request, ctx);
    const stored = JSON.stringify(records[0]);
    expect(stored).not.toContain("Hi Pat.");
    expect(stored).not.toContain("You answer customers.");
    expect(records[0]?.usage.inputTokens).toBeGreaterThan(0);
  });

  it("records a failed call and throws it on", async () => {
    const failure = new ExternalServiceError("The Claude API answered 529.", {
      provider: "anthropic",
      status: 529,
    });
    const { records, context: ctx } = context();
    await expect(callModel(createScriptedModelClient([failure]), request, ctx)).rejects.toBe(
      failure,
    );
    expect(records[0]).toMatchObject({
      stopReason: null,
      response: null,
      error: { code: "external_service_failed" },
    });
  });

  it("does not lose the reply when the audit record cannot be written", async () => {
    const model = createScriptedModelClient([scriptedResponse([text("Still here.")])]);
    const { context: ctx } = context();
    const response = await callModel(model, request, {
      ...ctx,
      sink: {
        record: async () => {
          throw new Error("database down");
        },
      },
    });
    expect(responseText(response.content)).toBe("Still here.");
  });

  it("stores the size of an image instead of its bytes", async () => {
    const model = createScriptedModelClient([scriptedResponse([text("A ceiling.")])]);
    const { records, context: ctx } = context();
    await callModel(
      model,
      {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "QUJDREVGRw==" },
              },
            ],
          },
        ],
      },
      ctx,
    );
    const stored = JSON.stringify(records[0]?.request);
    expect(stored).not.toContain("QUJDREVGRw==");
    expect(stored).toContain("12 base64 characters omitted");
  });
});

describe("reading a response", () => {
  it("takes text and tool calls only from after a fallback boundary", () => {
    const content = [
      thinking(),
      toolUse("update_lead_fields", { fields: [] }, "toolu_declined"),
      fallbackBlock("claude-fable-5-2", "claude-opus-5"),
      thinking("sig_fallback"),
      toolUse("request_photo", { subject: "the ceiling" }, "toolu_ok"),
      text("One moment."),
    ];
    expect(responseText(content)).toBe("One moment.");
    expect(responseToolUses(content).map((call) => call.id)).toEqual(["toolu_ok"]);
    // Echoed back: the fallback block stays in place, the declined model's thinking and
    // tool call are left out, everything after the boundary is unchanged.
    expect(assistantEcho(content).map((block) => block.type)).toEqual([
      "fallback",
      "thinking",
      "tool_use",
      "text",
    ]);
  });

  it("echoes a normal turn unchanged, thinking blocks included", () => {
    const content = [thinking(), toolUse("request_photo", { subject: "x" }), text("ok")];
    expect(assistantEcho(content)).toEqual(content);
  });

  it("knows which models take system messages inside the conversation", () => {
    for (const model of [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-opus-4-8",
    ]) {
      expect(supportsMidConversationSystem(model)).toBe(true);
    }
    for (const model of [
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "some-future-model",
    ]) {
      expect(supportsMidConversationSystem(model)).toBe(false);
    }
  });
});

describe("choosing the model client from the environment", () => {
  const local = { environment: "local", commitSha: null, region: null } as const;
  const hosted = { environment: "production", commitSha: "abc", region: "iad1" } as const;

  it("uses the Claude API when a key is set and the offline model on a developer machine without one", () => {
    expect(modelModeFromEnv(loadEnv({ ANTHROPIC_API_KEY: "sk-test" }), local)).toBe("live");
    expect(modelModeFromEnv(loadEnv({ ANTHROPIC_API_KEY: "sk-test" }), hosted)).toBe("live");
    expect(modelModeFromEnv(loadEnv({}), local)).toBe("offline");
    expect(
      modelModeFromEnv(loadEnv({ ANTHROPIC_API_KEY: "sk-test", AI_MODEL_MODE: "offline" }), local),
    ).toBe("offline");
  });

  it("never lets the offline model answer on a hosted deployment", () => {
    expect(modelModeFromEnv(loadEnv({}), hosted)).toBe("unconfigured");
    expect(modelModeFromEnv(loadEnv({ AI_MODEL_MODE: "offline" }), hosted)).toBe("unconfigured");
    expect(
      modelModeFromEnv(loadEnv({ AI_MODEL_MODE: "offline", ANTHROPIC_API_KEY: "sk-test" }), hosted),
    ).toBe("live");
    expect(modelModeFromEnv(loadEnv({ AI_MODEL_MODE: "live" }), local)).toBe("unconfigured");
  });

  it("fails every call with a configuration error when nothing is configured", async () => {
    const quiet = createLogger({ level: "error", sink: () => {} });
    const client = createModelClientFromEnv({
      env: loadEnv({}),
      deployment: hosted,
      logger: quiet,
    });
    expect(client.name).toBe("unconfigured");
    await expect(client.call(request)).rejects.toBeInstanceOf(ConfigError);
    expect(
      createModelClientFromEnv({ env: loadEnv({}), deployment: local, logger: quiet }).name,
    ).toBe("offline");
    expect(
      createModelClientFromEnv({
        env: loadEnv({ ANTHROPIC_API_KEY: "sk-test" }),
        deployment: hosted,
        logger: quiet,
      }).name,
    ).toBe("anthropic");
  });
});

describe("estimateCostMicroUsd", () => {
  it("prices a call from its tokens, cache reads and cache writes", () => {
    // 1,000 input at $8/M, 500 output at $40/M, 10,000 cache reads at $0.20/M,
    // 2,000 cache writes at $10/M.
    expect(
      estimateCostMicroUsd("claude-fable-5-2", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 2000,
      }),
    ).toBe(8000 + 20_000 + 2000 + 20_000);
    expect(estimateCostMicroUsd("claude-opus-5-5", { ...zero(), inputTokens: 1_000_000 })).toBe(
      4_000_000,
    );
    expect(estimateCostMicroUsd("claude-opus-5", { ...zero(), inputTokens: 1_000_000 })).toBe(
      5_000_000,
    );
    expect(estimateCostMicroUsd("offline-rules-1", zero())).toBeNull();
  });
});

function zero() {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}
