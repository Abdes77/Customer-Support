import type { IntegrationService } from "@repo/integrations";

import { getServerPipeline } from "@/server/pipeline";

/**
 * CRMs and outgoing webhooks for the app (C14). The admin panel (C16) calls these from server
 * actions after `requireAccess()` and `requireBusinessRole(access, business, ["agency_admin",
 * "agency_member"])`: `catalogue`, `mappingSources`, `list`, `updateConfig`, `test`,
 * `disconnect`, `deliveries`, `retry`, `previewMapping`, `webhookTargets`, `testWebhook`,
 * `checkWebhookUrl`. The signing secrets (`revealWebhookSecret`, `rotateWebhookSecret` and
 * their agency versions) take the person's `UserAccess` and refuse anyone but an
 * `agency_admin` of the agency themselves. HubSpot, GoHighLevel and Jobber connect
 * through `POST /api/oauth/crm/{provider}` and its callback; keys and client credentials
 * through `POST /api/integrations/crm/{provider}`. Nothing returned holds a token or a key.
 */
export function getIntegrations(): IntegrationService {
  return getServerPipeline().integrations;
}
