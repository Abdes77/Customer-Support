import type { IntegrationId, Logger } from "@repo/core";
import type { Database } from "@repo/db";
import type { EventSender } from "@repo/jobs";

import type { ConnectorApps, ConnectorRegistry } from "../connectors/registry";
import type { FetchLike } from "../http";
import type { SafePoster } from "../net/safe-post";

export interface IntegrationDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Where `integrations.delivery_requested` goes. Null in tests that drive deliveries directly. */
  readonly events: EventSender | null;
  readonly clock?: () => Date;
  /** The public origin, for OAuth redirect URIs and conversation links. */
  readonly appUrl: string;
  /** For the CRMs' APIs and OAuth endpoints. Tests inject fakes. */
  readonly fetch: FetchLike;
  /** The guarded poster every outgoing webhook goes through. */
  readonly poster: SafePoster;
  /** The deployment's vendor apps (OAuth apps, the ServiceTitan app key). */
  readonly apps: ConnectorApps;
  /** Signs the OAuth `state`; null when the credentials key is missing. */
  readonly oauthStateKey: Uint8Array | null;
  /** Replaces connectors, for tests. Default: built from `apps`. */
  readonly connectors?: Partial<ConnectorRegistry>;
}

export function clockOf(deps: Pick<IntegrationDeps, "clock">): () => Date {
  return deps.clock ?? (() => new Date());
}

/** The CRMs (every connector but the webhook). */
export const CRM_PROVIDERS = [
  "hubspot",
  "gohighlevel",
  "jobber",
  "housecall_pro",
  "servicetitan",
] as const satisfies readonly IntegrationId[];
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export function isCrmProvider(value: string): value is CrmProvider {
  return (CRM_PROVIDERS as readonly string[]).includes(value);
}

/** Routes of the app that the package builds URLs for. */
export const INTEGRATION_ROUTES = {
  oauthCallback: (provider: CrmProvider) => `/api/oauth/crm/${provider}/callback`,
  /** The conversation in the admin panel's inbox (C16 serves it). */
  conversation: (conversationId: string) => `/inbox/${conversationId}`,
} as const;

export function publicUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
}
