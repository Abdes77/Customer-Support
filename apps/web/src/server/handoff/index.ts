import type { HandoffService } from "@repo/handoff";

import { getServerPipeline } from "@/server/pipeline";

/**
 * Takeover, emergencies, alerts and follow-ups for the app (C13). The admin panel (C15, C16)
 * calls these from server actions after `requireAccess()` and `requireBusinessRole(access,
 * business, [...])` for the business:
 * - `takeoverState`, `takeOver`, `release`, `sendManualReply` (the inbox's takeover, manual
 *   reply and "give back to the bot");
 * - `setOptOut` (a contact asked by phone to stop, or to start again);
 * - `listEscalations`, `acknowledgeEscalation` (the emergency list and its button);
 * - `listFollowUps`, `cancelFollowUps`;
 * - `sendTestAlert` (the alert contacts page; the contacts themselves are the settings
 *   `alerts.recipients`, `alerts.agency_recipients`, `emergency.escalation_chain` and
 *   `emergency.fallback_contacts`, edited on the settings screen).
 * Nothing returned holds a secret.
 */
export function getHandoff(): HandoffService {
  return getServerPipeline().handoff.service;
}
