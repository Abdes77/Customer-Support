import type { ConversationId, MessageId, TraceId } from "@repo/core";
import { alerts, type BusinessContext, deadLetters } from "@repo/db";

/** A job that gave up for good (ARCHITECTURE §4): one row the admin panel and C17 can see. */
export interface DeadLetterEntry {
  readonly source: string;
  readonly eventName: string | null;
  readonly eventId: string | null;
  readonly traceId: TraceId | null;
  readonly conversationId: ConversationId | null;
  readonly messageId: MessageId | null;
  readonly errorCode: string | null;
  readonly errorMessage: string;
  readonly retryable: boolean | null;
  readonly attempts: number;
  /** Ids and classifications only, like the job payload. */
  readonly payload: Record<string, unknown>;
}

export async function recordDeadLetter(
  ctx: BusinessContext,
  entry: DeadLetterEntry,
): Promise<void> {
  await ctx.tx.insert(deadLetters).values({
    ...ctx.tenant,
    source: entry.source,
    eventName: entry.eventName,
    eventId: entry.eventId,
    traceId: entry.traceId,
    conversationId: entry.conversationId,
    messageId: entry.messageId,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage.slice(0, 2000),
    retryable: entry.retryable,
    attempts: entry.attempts,
    payload: entry.payload,
  });
}

/**
 * An in-app alert for the agency (shown in the admin panel; C13 adds delivery by email, SMS
 * and WhatsApp, C17 alerting on stuck work). Deduplicated by `dedupeKey`.
 */
export async function raiseInAppAlert(
  ctx: BusinessContext,
  alert: {
    readonly kind: string;
    readonly severity: "info" | "warning" | "critical";
    readonly conversationId: ConversationId | null;
    readonly subject: string;
    readonly dedupeKey: string;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: alert.conversationId,
      kind: alert.kind,
      severity: alert.severity,
      channel: "in_app",
      recipient: "agency",
      subject: alert.subject,
      payload: alert.payload,
      dedupeKey: alert.dedupeKey,
    })
    .onConflictDoNothing();
}
