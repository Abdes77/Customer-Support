import { estimateCostMicroUsd } from "@repo/ai";
import type { Logger, ModelCallRecord, ModelCallSink } from "@repo/core";
import { type Database, modelCalls } from "@repo/db";

/**
 * Stores the model calls of this package (playbook generation, fact extraction) in
 * `model_calls`, in the system scope of the business the work is for. Prompts and outputs
 * belong in that tenant-scoped table, never in the application log.
 *
 * A failure to store is logged and swallowed: losing an audit row must not lose the work.
 */
export function createKnowledgeModelCallSink(options: {
  readonly db: Database;
  readonly logger: Logger;
  readonly settingsVersion?: string | null;
}): ModelCallSink {
  const { db, logger } = options;
  return {
    async record(call: ModelCallRecord) {
      try {
        await db
          .forBusiness(call.trace.businessId, { agencyId: call.trace.agencyId })
          .run(async (ctx) => {
            await ctx.tx.insert(modelCalls).values({
              ...ctx.tenant,
              conversationId: null,
              traceId: call.trace.traceId,
              purpose: call.purpose,
              model: call.model,
              effort: call.effort,
              promptVersion: call.promptVersion,
              settingsVersion: options.settingsVersion ?? null,
              mode: "live",
              startedAt: new Date(call.startedAt),
              latencyMs: Math.round(call.latencyMs),
              stopReason: call.stopReason,
              inputTokens: call.usage.inputTokens,
              outputTokens: call.usage.outputTokens,
              cacheReadInputTokens: call.usage.cacheReadInputTokens,
              cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
              costMicroUsd: estimateCostMicroUsd(call.model, call.usage),
              requestId: call.requestId,
              request: call.request,
              response: call.response,
              errorCode: call.error?.code ?? null,
              errorMessage: call.error?.message ?? null,
            });
          });
      } catch (error) {
        logger.error("model_call.record_failed", {
          traceId: call.trace.traceId,
          businessId: call.trace.businessId,
          purpose: call.purpose,
          error,
        });
      }
    },
  };
}

/** For work that belongs to no business (a segment without one): the call is only logged. */
export const discardModelCalls: ModelCallSink = { record: async () => undefined };
