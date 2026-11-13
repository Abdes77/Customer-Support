/**
 * How to react to a Graph API error, from its code (the field Meta says to build error
 * handling on; titles are being deprecated and `error_subcode` is gone since v16).
 *
 * Sources: the WhatsApp Cloud API error-code table and the throughput page
 * (developers.facebook.com/documentation/business-messaging/whatsapp, read 2026-11-12), and
 * the Graph API's general codes, which Messenger and Instagram share; Messenger's subcodes from
 * developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes
 * (read 2026-11-12, C10).
 */

export interface GraphErrorClass {
  /** A later attempt may succeed (rate limits, temporary outages, unknown server errors). */
  readonly retryable: boolean;
  /** How long to wait before that attempt, when the error says or implies it. */
  readonly retryAfterSeconds: number | null;
  /** The customer-service window has closed: only a template may go out (WhatsApp 131047). */
  readonly windowClosed: boolean;
  /** The token is expired, revoked or lacks permission: the connection needs attention. */
  readonly authFailed: boolean;
  /** A rate limit of the app, the account, the number or the recipient was hit. */
  readonly rateLimited: boolean;
  /**
   * Messenger and Instagram: another app (or Meta's own assistant) controls the conversation
   * under the Conversation Routing (handover) protocol, so ours may not send.
   */
  readonly threadControlled: boolean;
  /** The person cannot be messaged (blocked the Page, deactivated, unavailable). */
  readonly recipientUnavailable: boolean;
}

/** Codes that fail because of the token or the app's permissions. */
const AUTH_CODES = new Set([0, 3, 10, 102, 190, 200, 131005]);

/** Rate limits, with the wait we use when the response gives none. */
const RATE_LIMITS = new Map<number, number>([
  [4, 300], // app call rate limit
  [17, 300], // user call rate limit
  [32, 300], // page call rate limit
  [613, 300], // calls within one hour exceeded
  [80007, 300], // WhatsApp Business Account rate limit
  [130429, 5], // throughput of the number (80 or 1,000 messages a second)
  [131056, 30], // too many messages to the same recipient in a short time
]);

/** Temporary failures that a plain retry with backoff may fix. */
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 131057, 133004]);

const WAIT_AFTER_TRANSIENT: Partial<Record<number, number>> = { 131057: 60 };

/** `estimated_time_to_regain_access` (minutes) from a Business Use Case usage header. */
export function regainAccessSeconds(usageHeader: string | null | undefined): number | null {
  if (usageHeader === null || usageHeader === undefined || usageHeader.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(usageHeader);
    if (parsed === null || typeof parsed !== "object") return null;
    let minutes = 0;
    for (const entries of Object.values(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const value =
          entry !== null && typeof entry === "object"
            ? (entry as Record<string, unknown>)["estimated_time_to_regain_access"]
            : undefined;
        if (typeof value === "number" && Number.isFinite(value)) {
          minutes = Math.max(minutes, value);
        }
      }
    }
    return minutes > 0 ? Math.min(minutes * 60, 24 * 3600) : null;
  } catch {
    return null;
  }
}

/*
 * Messenger and Instagram (the Messenger Platform error-code table, read 2026-11-12) answer
 * several situations with code 10 or 100 and tell them apart by `error_subcode`, which their
 * API still sends. These come before the code-only rules, because 10 alone is a permission
 * error.
 */
const WINDOW_CLOSED_SUBCODES = new Set([2534022, 2018278]);
const THREAD_CONTROL_SUBCODES = new Set([2018300, 2534037]);
const RECIPIENT_UNAVAILABLE_SUBCODES = new Set([1545041, 2018108]);

export function classifyGraphError(input: {
  readonly code: number | null;
  readonly httpStatus: number | null;
  readonly usageHeader?: string | null;
  /** `error_subcode`, which Messenger and Instagram still send. */
  readonly subcode?: number | null;
}): GraphErrorClass {
  const { code, httpStatus } = input;
  const subcode = input.subcode ?? null;
  const base = {
    retryable: false,
    retryAfterSeconds: null,
    windowClosed: false,
    authFailed: false,
    rateLimited: false,
    threadControlled: false,
    recipientUnavailable: false,
  };
  if (code === 131047) return { ...base, windowClosed: true };
  if (subcode !== null) {
    if (code === 10 && WINDOW_CLOSED_SUBCODES.has(subcode)) return { ...base, windowClosed: true };
    if (THREAD_CONTROL_SUBCODES.has(subcode) && (code === 10 || code === 100)) {
      return { ...base, threadControlled: true };
    }
    if (
      RECIPIENT_UNAVAILABLE_SUBCODES.has(subcode) &&
      (code === 10 || code === 200 || code === 551)
    ) {
      return { ...base, recipientUnavailable: true };
    }
    // 613/2534040: Instagram's rate limit; falls through to the code rule below.
  }
  if (code === 551) return { ...base, recipientUnavailable: true };
  if (code !== null && AUTH_CODES.has(code)) return { ...base, authFailed: true };
  if (code !== null && RATE_LIMITS.has(code)) {
    return {
      ...base,
      retryable: true,
      rateLimited: true,
      retryAfterSeconds: regainAccessSeconds(input.usageHeader) ?? RATE_LIMITS.get(code)!,
    };
  }
  if (code !== null && TRANSIENT_CODES.has(code)) {
    return { ...base, retryable: true, retryAfterSeconds: WAIT_AFTER_TRANSIENT[code] ?? null };
  }
  if (httpStatus === 429) {
    return {
      ...base,
      retryable: true,
      rateLimited: true,
      retryAfterSeconds: regainAccessSeconds(input.usageHeader) ?? 60,
    };
  }
  if (httpStatus === null || httpStatus === 408 || httpStatus >= 500) {
    // No answer at all (network, timeout) or a server error without a known code.
    return { ...base, retryable: true };
  }
  return base;
}
