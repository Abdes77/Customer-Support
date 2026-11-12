/**
 * @repo/integrations (owner: C14)
 *
 * The integration framework, the CRM connectors (HubSpot, GoHighLevel, Jobber, Housecall Pro,
 * ServiceTitan) and the generic signed outgoing webhook. Server only.
 *
 * - Jobs: `createIntegrationJobs(deps)` (lead events and booking changes → deliveries, the
 *   delivery attempts with backoff, the sweeper), registered in `apps/web/src/server/pipeline`.
 * - The admin panel's service: `createIntegrationService(deps)` (`getIntegrations()` in
 *   `apps/web/src/server/integrations`).
 * - Receivers: `verifyWebhookSignature` checks our `X-HSRB-Signature`.
 * docs/INTEGRATIONS.md has the setup per vendor; ARCHITECTURE §2 "As built (C14)" the design.
 */
export { type OAuthApp } from "./connectors/common";
export {
  type AnyConnector,
  type ConnectorApps,
  type ConnectorRegistry,
  createConnectorRegistry,
  NO_APPS,
} from "./connectors/registry";
export { createGoHighLevelConnector } from "./connectors/gohighlevel";
export { createHousecallProConnector } from "./connectors/housecall-pro";
export { createHubSpotConnector } from "./connectors/hubspot";
export { createJobberConnector } from "./connectors/jobber";
export { createServiceTitanConnector, type ServiceTitanApp } from "./connectors/servicetitan";
export { type FetchLike } from "./http";
export {
  applyFieldMapping,
  isMappingSource,
  MAPPING_SOURCES,
  type MappedFields,
  type MappingSource,
  toE164,
} from "./mapping";
export {
  createSafePoster,
  type PostTransport,
  type SafePoster,
  type SafePosterDeps,
  UnsafeTargetError,
} from "./net/safe-post";
export { isPublicAddress } from "./net/address";
export {
  CRM_OAUTH_COOKIE,
  type CrmOAuthProvider,
  type CrmOAuthState,
  isOAuthProvider,
  OAUTH_PROVIDERS,
} from "./oauth";
export { createWebhookConnector, WEBHOOK_USER_AGENT, webhookBody } from "./webhook/connector";
export {
  generateSigningSecret,
  SIGNATURE_HEADER,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhook/sign";
export { deliverOnce, type DeliveryOutcome, MAX_ATTEMPTS, RETRY_DELAYS_MS } from "./server/deliver";
export {
  CRM_PROVIDERS,
  type CrmProvider,
  INTEGRATION_ROUTES,
  type IntegrationDeps,
  isCrmProvider,
} from "./server/deps";
export { integrationConfigFromEnv } from "./server/env";
export { createIntegrationJobs, INTEGRATION_FUNCTION_IDS } from "./server/jobs";
export { loadLeadSyncPayload } from "./server/payload";
export { planDeliveries } from "./server/plan";
export {
  type ConnectionView,
  type ConnectorInfo,
  createIntegrationService,
  type DeliveryView,
  type IntegrationService,
  type OAuthStart,
  type TestResult,
  type Tenant,
  type WebhookTargetView,
} from "./server/service";
