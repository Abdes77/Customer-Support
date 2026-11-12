import type { SchedulingConnectionService } from "@repo/scheduling";

import { getServerPipeline } from "@/server/pipeline";

/**
 * Calendars and Calendly for the app (C12). The admin panel (C16) calls these from server
 * actions after `requireAccess()` and `requireBusinessRole(access, business, ["agency_admin",
 * "agency_member"])`: `availability`, `list`, `listCalendars`, `setCalendars`, `disconnect`.
 * Google Calendar, Outlook and Calendly connect through `POST /api/oauth/calendar/{google|
 * microsoft|calendly}` and its callback; Calendly also takes a personal access token through
 * `POST /api/integrations/calendly/token`. Nothing returned holds a token.
 */
export function getScheduling(): SchedulingConnectionService {
  return getServerPipeline().scheduling.connections;
}
