import type { Logger } from "@repo/core";
import type { BusinessContext, Database } from "@repo/db";
import type { AnyJobEvent, EventSender } from "@repo/jobs";

import type { CalendarClient } from "../calendars/types";
import type { CalendlyClient } from "../calendly/client";
import type { FetchLike } from "../http";
import type { MicrosoftOAuthApp, OAuthApp } from "../oauth";

/**
 * A code-written message to the customer (a reminder), stored in the conversation and sent
 * by the pipeline's send function like any bot reply, so window rules, takeovers, opt-outs
 * and quiet sending stay the pipeline's. Implemented by `@repo/pipeline` (`enqueueBotMessage`)
 * and handed in by the composition root; scheduling never calls a channel itself.
 */
export interface OutboundMessages {
  enqueue(
    ctx: BusinessContext,
    input: {
      readonly conversationId: string;
      readonly text: string;
      readonly traceId: string;
      /** Why the message exists, kept on the message ("reminder"). */
      readonly purpose: string;
    },
  ): Promise<{ readonly messageId: string; readonly events: readonly AnyJobEvent[] } | null>;
}

export interface SchedulingDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** For the vendors' APIs and OAuth endpoints. Tests inject fakes. */
  readonly fetch: FetchLike;
  readonly clock?: () => Date;
  /** The Google OAuth app (shared with Gmail, C11), or null when not configured. */
  readonly google: OAuthApp | null;
  /** The Microsoft Entra app (shared with Outlook mail), or null. */
  readonly microsoft: MicrosoftOAuthApp | null;
  /** The Calendly OAuth app and its webhook signing key; a personal token works without. */
  readonly calendly: { readonly app: OAuthApp | null; readonly webhookSigningKey: string | null };
  /** The public origin, for OAuth redirect URIs, webhook URLs and conversation links. */
  readonly appUrl: string;
  /** Signs the OAuth `state`; null when the credentials key is missing. */
  readonly oauthStateKey: Uint8Array | null;
  /** Where booking events go (reminders). Null in dry runs and tests that do not need them. */
  readonly events: EventSender | null;
  /** Overrides of the provider clients, for tests. Default: built on `fetch`. */
  readonly clients?: {
    readonly google?: CalendarClient;
    readonly microsoft?: CalendarClient;
    readonly calendly?: CalendlyClient;
  };
}

export function clockOf(deps: Pick<SchedulingDeps, "clock">): () => Date {
  return deps.clock ?? (() => new Date());
}

/** Routes of the app that the package builds URLs for. */
export const SCHEDULING_ROUTES = {
  oauthCallback: (segment: "google" | "microsoft" | "calendly") =>
    `/api/oauth/calendar/${segment}/callback`,
  calendlyWebhook: (key: string) => `/api/webhooks/calendly/${key}`,
  /** The conversation in the admin panel's inbox (C16 serves it). */
  conversation: (conversationId: string) => `/inbox/${conversationId}`,
} as const;

export function publicUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
}
