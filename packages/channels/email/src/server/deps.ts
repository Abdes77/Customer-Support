import type { Logger, ParsedWebhook } from "@repo/core";
import type { BusinessTenant, Database } from "@repo/db";
import type { TenantStorage } from "@repo/db/storage";
import type { EventSender } from "@repo/jobs";

import type { MailNetworkPolicy } from "../net/resolve";
import type { GmailClient } from "../providers/gmail";
import type { FetchLike } from "../providers/http";
import type { GraphMailClient } from "../providers/microsoft";
import type { MicrosoftOAuthApp, OAuthApp } from "../providers/oauth";
import type { JsonWebKeySet } from "./oidc";

/** Gmail: the Google OAuth client and the Pub/Sub topic and push identity. */
export interface GoogleSetup {
  readonly app: OAuthApp;
  /** `GOOGLE_PUBSUB_TOPIC`; without it Gmail inboxes are polled instead of pushed. */
  readonly pubsubTopic: string | null;
  /** `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT`: the only identity a push may come from. */
  readonly pushServiceAccount: string | null;
  /** The audience of the push token: the push endpoint's URL unless configured. */
  readonly pushAudience: string;
}

/** Microsoft 365: the Entra app and the secret change notifications are checked with. */
export interface MicrosoftSetup {
  readonly app: MicrosoftOAuthApp;
  /** `MICROSOFT_GRAPH_CLIENT_STATE`; without it there are no subscriptions (polling only). */
  readonly clientStateSecret: string | null;
}

/** What the email server half needs. Built once in apps/web. */
export interface EmailServerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly gmail: GmailClient;
  readonly graph: GraphMailClient;
  /** For the OAuth token endpoints (Google, Microsoft). */
  readonly fetch: FetchLike;
  readonly google: GoogleSetup | null;
  readonly microsoft: MicrosoftSetup | null;
  /** The public origin (`APP_URL`): OAuth redirect URIs and notification URLs. */
  readonly appUrl: string;
  /** Key that signs the OAuth `state` (derived from the credentials key by apps/web). */
  readonly oauthStateKey: Uint8Array | null;
  /** The pipeline's `ingest` (ARCHITECTURE §2, steps 4 to 6). */
  readonly ingest: (parsed: ParsedWebhook) => Promise<unknown>;
  readonly events: EventSender;
  readonly storage: (tenant: BusinessTenant) => TenantStorage;
  /** Mail server address rules; tests widen them to reach a local mail server. */
  readonly mailPolicy?: MailNetworkPolicy;
  /** Google's signing keys for Pub/Sub push tokens; tests inject their own. */
  readonly googleKeys?: () => Promise<JsonWebKeySet>;
  readonly clock?: () => Date;
}

export const ROUTES = {
  gmailPush: "/api/webhooks/email/gmail",
  graphNotifications: "/api/webhooks/email/microsoft",
  googleCallback: "/api/oauth/email/google/callback",
  microsoftCallback: "/api/oauth/email/microsoft/callback",
} as const;

/** `APP_URL` + path, without a double slash. */
export function publicUrl(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path}`;
}
