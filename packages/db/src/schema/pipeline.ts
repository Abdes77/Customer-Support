import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { type ConversationId, type TraceId, TURN_TRIGGERS } from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { conversationFk } from "./conversations";
import { businessPolicies } from "./policies";
import { TURN_STATUSES } from "./vocab";

/**
 * One reply turn of the message pipeline (C3): a run of the reply function that took the
 * conversation's turn lease. Turns that gave way to a newer message before taking the lease
 * leave no row.
 *
 * - `ordinal` numbers the turns of a conversation; it is handed out under the turn lease, so
 *   it is gap-free and ordered even when transactions overlap.
 * - `through_seq` is the highest inbound sequence the turn answers; the pending messages are
 *   the inbound ones above the conversation's watermark up to it.
 * - `run_id` is the job run that owns the turn, so a failure handler can find and release it.
 * - `actions` holds the engine's executed actions (`ExecutedAction[]` from @repo/core) and
 *   `reply_message_ids` the outbound messages the turn queued; `trace_id` links both to the
 *   model calls and sends of the turn.
 *
 * Written by the pipeline through the system scope; agency staff read it (inbox debugging,
 * first-response time), client users do not (actions carry the model's reasoning).
 */
export const conversationTurns = pgTable(
  "conversation_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>().notNull(),
    ordinal: integer("ordinal").notNull(),
    trigger: text("trigger", { enum: TURN_TRIGGERS }).notNull(),
    status: text("status", { enum: TURN_STATUSES }).notNull().default("running"),
    runId: text("run_id").notNull(),
    traceId: uuid("trace_id").$type<TraceId>().notNull(),
    throughSeq: integer("through_seq").notNull(),
    pendingCount: integer("pending_count").notNull().default(0),
    /** Why a guard stopped the turn, for example "takeover" or "opted_out". */
    skipReason: text("skip_reason"),
    /** `EngineTurnResult.outcome`, when the engine ran. */
    engineOutcome: text("engine_outcome"),
    promptVersion: text("prompt_version"),
    settingsVersion: text("settings_version"),
    actions: jsonb("actions").$type<unknown[]>().notNull().default([]),
    replyMessageIds: jsonb("reply_message_ids").$type<string[]>().notNull().default([]),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("conversation_turns", t),
    conversationFk("conversation_turns", t),
    uniqueIndex("conversation_turns_ordinal_key").on(t.conversationId, t.ordinal),
    index("conversation_turns_run_idx").on(t.runId),
    index("conversation_turns_business_started_idx").on(t.businessId, t.startedAt),
    index("conversation_turns_running_idx")
      .on(t.conversationId)
      .where(sql`${t.status} = 'running'`),
    check("conversation_turns_trigger_check", oneOf(t.trigger, TURN_TRIGGERS)),
    check("conversation_turns_status_check", oneOf(t.status, TURN_STATUSES)),
    check("conversation_turns_ordinal_check", sql`${t.ordinal} > 0`),
    ...businessPolicies("conversation_turns"),
  ],
);
