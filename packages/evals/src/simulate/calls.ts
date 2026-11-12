import {
  callModel,
  estimateCostMicroUsd,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "@repo/ai";
import type { Logger, ModelCallRecord, TraceContext } from "@repo/core";

import type { CallSummary } from "./transcript";

/** A stored model call without its prompt: enough to cost it and to see how it ended. */
export function summarizeCall(record: ModelCallRecord): CallSummary {
  return {
    purpose: record.purpose,
    model: record.model,
    stopReason: record.stopReason,
    usage: record.usage,
    latencyMs: record.latencyMs,
    error: record.error?.code ?? null,
  };
}

/**
 * One model call of the harness itself (the simulated customer, the judge), through
 * `callModel` like every other call in the product. The audit record stays in memory; the
 * prompt is not kept (the transcript and the rubric reproduce it).
 */
export async function callForEval(
  client: ModelClient,
  request: ModelRequest,
  context: {
    readonly trace: TraceContext;
    readonly promptVersion: string;
    readonly logger: Logger;
    readonly calls: CallSummary[];
  },
): Promise<ModelResponse> {
  return callModel(client, request, {
    trace: context.trace,
    promptVersion: context.promptVersion,
    logger: context.logger,
    storeIo: false,
    sink: {
      record: async (record) => {
        context.calls.push(summarizeCall(record));
      },
    },
  });
}

/**
 * The list-price cost of some calls in millionths of a US dollar: each call priced by the
 * model that answered it. Null when a call was answered by a model without a known price.
 */
export function costOfCalls(calls: readonly CallSummary[]): number | null {
  let total = 0;
  for (const call of calls) {
    const cost = estimateCostMicroUsd(call.model, call.usage);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}
