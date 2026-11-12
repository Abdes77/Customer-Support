/**
 * How alerts reach people (C13's own small interface, ARCHITECTURE §7: "alert channels get
 * their own small interfaces, defined by their owners"). Each transport sends one message and
 * answers with a result; it never throws for a vendor's refusal. A missing transport (no
 * credentials on this deployment) is `null`, and an alert for it is recorded as failed with
 * `not_configured` so the chain moves on.
 */

export type TransportResult =
  | {
      readonly ok: true;
      /** The vendor's id (Twilio's SID, the SMTP message id, Meta's message id). */
      readonly providerId: string | null;
    }
  | {
      readonly ok: false;
      /** Worth trying again soon (a timeout, a 5xx, a rate limit). */
      readonly retryable: boolean;
      /** Short machine-readable reason, safe to store and show ("http_401", "21211"). */
      readonly code: string;
      /** A short description without secrets or message content. */
      readonly message: string;
    };

export interface SmsTransport {
  send(input: {
    /** E.164. */
    readonly to: string;
    readonly body: string;
    /** Where the vendor reports delivery, or null. */
    readonly statusCallbackUrl: string | null;
  }): Promise<TransportResult>;
}

export interface VoiceTransport {
  call(input: {
    readonly to: string;
    /** The TwiML document the call plays (built by code, escaped). */
    readonly twiml: string;
    readonly statusCallbackUrl: string | null;
  }): Promise<TransportResult>;
}

export interface EmailTransport {
  send(input: {
    readonly to: string;
    readonly subject: string;
    /** Plain text only: alerts carry no HTML. */
    readonly text: string;
  }): Promise<TransportResult>;
}

export interface WhatsAppTransport {
  send(input: {
    /** E.164. */
    readonly to: string;
    /** One line: the parameter of the approved alert template. */
    readonly text: string;
  }): Promise<TransportResult>;
}

export interface AlertTransports {
  readonly sms: SmsTransport | null;
  readonly voice: VoiceTransport | null;
  readonly email: EmailTransport | null;
  readonly whatsapp: WhatsAppTransport | null;
}

export const NO_TRANSPORTS: AlertTransports = {
  sms: null,
  voice: null,
  email: null,
  whatsapp: null,
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A fetch that gives up after `ms`, so a hung vendor never holds a job step (or a lock). */
export function withTimeout(fetchFn: FetchLike, ms: number): FetchLike {
  return (input, init) => fetchFn(input, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Turns a thrown network error into a retryable result. */
export function networkFailure(error: unknown): TransportResult {
  const name = error instanceof Error ? error.name : "Error";
  return {
    ok: false,
    retryable: true,
    code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
    message: "The provider could not be reached.",
  };
}
