import { bigint, check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { ConversationId, TraceId } from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz } from "./columns";
import { conversationFk } from "./conversations";
import { businessPolicies } from "./policies";
import { MODEL_CALL_MODES } from "./vocab";

/**
 * One request to the Claude API (`ModelCallRecord` in @repo/core): full input and output,
 * tokens, cache reads and latency. This table, not the application log, is where prompts and
 * replies are kept; C17's retention job purges it. Agency staff may read it, client users
 * may not (it contains the system prompt and the playbook).
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    /** Null for work that is not tied to one conversation (imports, playbook generation). */
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    traceId: uuid("trace_id").$type<TraceId>().notNull(),
    /** "reply", "photo_analysis", "playbook", "report", "eval_judge", ... */
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    promptVersion: text("prompt_version").notNull(),
    settingsVersion: text("settings_version"),
    mode: text("mode", { enum: MODEL_CALL_MODES }).notNull().default("live"),
    startedAt: timestamptz("started_at").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    stopReason: text("stop_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    /** Cost in millionths of a US dollar, for the spend caps of C17. */
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    /** Provider request id, for support tickets. */
    requestId: text("request_id"),
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("model_calls", t),
    conversationFk("model_calls", t),
    index("model_calls_business_started_idx").on(t.businessId, t.startedAt),
    index("model_calls_conversation_idx").on(t.conversationId, t.startedAt),
    index("model_calls_trace_idx").on(t.traceId),
    check("model_calls_mode_check", oneOf(t.mode, MODEL_CALL_MODES)),
    ...businessPolicies("model_calls"),
  ],
);
