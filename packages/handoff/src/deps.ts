import type { Logger } from "@repo/core";
import type { BusinessContext, Database } from "@repo/db";
import type { AnyJobEvent, EventSender } from "@repo/jobs";

import type { AlertTransports } from "./transports/types";

/**
 * Messages the handoff package puts in a conversation: the opt-out confirmation and a
 * person's manual reply. Implemented by `@repo/pipeline` (`enqueueBotMessage`,
 * `enqueueHumanMessage`) and handed in by the composition roots, so they go out through the
 * pipeline's send function (order, takeover, opt-out, window rules) and never through a
 * channel adapter called from here.
 */
export interface OutboundMessages {
  enqueueBot(
    ctx: BusinessContext,
    input: {
      readonly conversationId: string;
      readonly text: string;
      readonly traceId: string;
      readonly purpose: string;
    },
  ): Promise<{ readonly messageId: string; readonly events: readonly AnyJobEvent[] } | null>;
  enqueueHuman(
    ctx: BusinessContext,
    input: {
      readonly conversationId: string;
      readonly text: string;
      readonly traceId: string;
      readonly userId: string;
    },
  ): Promise<{ readonly messageId: string; readonly events: readonly AnyJobEvent[] } | null>;
}

/** What the domain parts (action handlers, observers, guard, send gate) need. */
export interface HandoffDomainDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** The service's clock. Every time this package stores or compares comes from it. */
  readonly clock?: () => Date;
  /** Where events go (the chain's start, follow-up plans). Null in dry runs. */
  readonly events: EventSender | null;
  readonly outbound: OutboundMessages;
}

/** What the jobs, the admin service and the webhook handlers need besides. */
export interface HandoffDeps extends HandoffDomainDeps {
  /** The public origin: conversation links, acknowledgement links, Twilio callbacks. */
  readonly appUrl: string;
  readonly transports: AlertTransports;
}

export function clockOf(deps: { readonly clock?: () => Date }): () => Date {
  return deps.clock ?? (() => new Date());
}

/** Routes of the app this package builds URLs for (apps/web serves them). */
export const HANDOFF_ROUTES = {
  /** The conversation in the admin panel's inbox (sign-in required; C16 serves it). */
  conversation: (conversationId: string) => `/inbox/${conversationId}`,
  /** An emergency alert's acknowledgement page: the alert id and its secret. */
  acknowledge: (token: string) => `/api/handoff/ack/${token}`,
  /** Twilio: replies to alert text messages. */
  twilioSms: "/api/handoff/twilio/sms",
  /** Twilio: the keypress on an escalation call. */
  twilioVoice: "/api/handoff/twilio/voice",
  /** Twilio: delivery status of an alert text message or call. */
  twilioStatus: "/api/handoff/twilio/status",
} as const;

export function publicUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
}
