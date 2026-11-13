import {
  AppError,
  type Logger,
  type ModelCallRecord,
  type ModelCallSink,
  type TraceContext,
} from "@repo/core";

import { toMessagesRequest } from "./anthropic-client";
import { type ModelClient, type ModelRequest, type ModelResponse, ZERO_USAGE } from "./types";

export interface ModelCallContext {
  readonly trace: TraceContext;
  /** The version of the prompt the request was built from. */
  readonly promptVersion: string;
  readonly sink: ModelCallSink;
  readonly logger: Logger;
  /**
   * False (`data.store_model_io` off): the record keeps the model, tokens, latency and stop
   * reason, but neither the prompt nor the reply.
   */
  readonly storeIo: boolean;
  /** Wall clock for `startedAt` and the latency. Default: the system clock. */
  readonly clock?: () => Date;
}

const OMITTED = { omitted: true, reason: "data.store_model_io is off" } as const;

/** Image and document bytes do not belong in the audit table: keep their size instead. */
function withoutBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record["type"] === "base64" && typeof record["data"] === "string") {
    return { ...record, data: `[${record["data"].length} base64 characters omitted]` };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, withoutBinary(item)]),
  );
}

function requestForRecord(request: ModelRequest, storeIo: boolean): unknown {
  if (!storeIo) {
    return {
      ...OMITTED,
      systemBlocks: request.system.length,
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
      maxTokens: request.maxTokens,
    };
  }
  return withoutBinary(toMessagesRequest(request));
}

function responseForRecord(response: ModelResponse, storeIo: boolean): unknown {
  const summary = {
    id: response.id,
    model: response.model,
    stopReason: response.stopReason,
    stopCategory: response.stopDetails?.category ?? null,
    fellBack: response.fellBack,
  };
  if (!storeIo) {
    return { ...OMITTED, ...summary, blocks: response.content.map((block) => block.type) };
  }
  return { ...summary, content: response.content };
}

/**
 * Calls the model and records the call: full input and output in the tenant-scoped sink
 * (never in the application log), and one log line with the model, tokens, cache reads and
 * latency. A failed call is recorded too, then thrown.
 */
export async function callModel(
  client: ModelClient,
  request: ModelRequest,
  context: ModelCallContext,
): Promise<ModelResponse> {
  const clock = context.clock ?? (() => new Date());
  const started = clock();
  const base = {
    trace: context.trace,
    purpose: request.purpose,
    model: request.model,
    effort: request.effort,
    promptVersion: context.promptVersion,
    startedAt: started.toISOString(),
  };
  const fields = {
    purpose: request.purpose,
    model: request.model,
    effort: request.effort,
    client: client.name,
  };

  let response: ModelResponse;
  try {
    response = await client.call(request);
  } catch (error) {
    const latencyMs = clock().getTime() - started.getTime();
    const code = error instanceof AppError ? error.code : "internal";
    const message = error instanceof Error ? error.message : "The model call failed.";
    await record(context, {
      ...base,
      latencyMs,
      stopReason: null,
      usage: ZERO_USAGE,
      requestId: null,
      request: requestForRecord(request, context.storeIo),
      response: null,
      error: { code, message },
    });
    context.logger.warn("model.call_failed", {
      ...fields,
      latencyMs,
      code,
      retryable: error instanceof AppError ? error.retryable : null,
    });
    throw error;
  }

  const latencyMs = clock().getTime() - started.getTime();
  await record(context, {
    ...base,
    // The model that answered: a fallback model after a declined request, the offline
    // stand-in on a developer machine. The model that was asked for is in `request`.
    model: response.model,
    latencyMs,
    stopReason: response.stopReason,
    usage: response.usage,
    requestId: response.requestId,
    request: requestForRecord(request, context.storeIo),
    response: responseForRecord(response, context.storeIo),
    error: null,
  });
  context.logger.info("model.call", {
    ...fields,
    servedBy: response.model,
    fellBack: response.fellBack,
    stopReason: response.stopReason,
    latencyMs,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cacheReadInputTokens,
    cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
    requestId: response.requestId,
  });
  return response;
}

/** Losing an audit row must not lose the reply: a failing sink is logged, not thrown. */
async function record(context: ModelCallContext, call: ModelCallRecord): Promise<void> {
  try {
    await context.sink.record(call);
  } catch (error) {
    context.logger.error("model.call_record_failed", { purpose: call.purpose, error });
  }
}
