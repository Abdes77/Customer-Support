import type { Logger, ModelCallRecord, ModelCallSink } from "@repo/core";
import { type Database, modelCalls } from "@repo/db";

/**
 * Stores every model call in `model_calls`, in the business's system scope (never in the
 * application log: it holds prompts and customer text). C4 owns what goes into the record;
 * C17's retention job and the `data.store_model_io` setting decide how long it stays.
 *
 * A failure to store is logged and swallowed: losing an audit row must not lose the reply.
 */
export function createModelCallSink(options: {
  readonly db: Database;
  readonly logger: Logger;
  readonly mode?: "live" | "dry_run";
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
              conversationId: call.trace.conversationId,
              traceId: call.trace.traceId,
              purpose: call.purpose,
              model: call.model,
              effort: call.effort,
              promptVersion: call.promptVersion,
              settingsVersion: options.settingsVersion ?? null,
              mode: options.mode ?? "live",
              startedAt: new Date(call.startedAt),
              latencyMs: Math.round(call.latencyMs),
              stopReason: call.stopReason,
              inputTokens: call.usage.inputTokens,
              outputTokens: call.usage.outputTokens,
              cacheReadInputTokens: call.usage.cacheReadInputTokens,
              cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
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
