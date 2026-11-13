import { z } from "zod";

import { AgencyId, BusinessId, ChannelConnectionId, TraceId } from "../ids";

/**
 * Email events (owner: C11). Ids and classifications only, at-least-once delivery,
 * consumers must be idempotent.
 */

export const EMAIL_SYNC_REASONS = ["push", "poll", "connect", "renew", "lifecycle"] as const;

/**
 * An inbox may have new mail: a Gmail push, a Graph change notification, the IMAP poll or a
 * safety sync. Triggers `email-sync`, one run at a time per inbox; the run reads the inbox
 * from its stored cursor, so a notification that was missed or repeated changes nothing.
 */
export const EmailSyncRequestedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  connectionId: ChannelConnectionId,
  reason: z.enum(EMAIL_SYNC_REASONS),
});
export type EmailSyncRequestedEvent = z.infer<typeof EmailSyncRequestedEvent>;

export const EMAIL_EVENTS = {
  "email.sync_requested": EmailSyncRequestedEvent,
} as const;
