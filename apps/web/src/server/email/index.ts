import type { EmailConnectionService } from "@repo/channel-email/server";

import { getServerPipeline } from "@/server/pipeline";

/**
 * Email for the app (C11): the business's inboxes (Gmail, Microsoft 365, IMAP/SMTP). The admin
 * panel (C16) calls these from server actions after `requireAccess()` and
 * `requireBusinessRole(access, business, ["agency_admin", "agency_member"])`: `availability`,
 * `list`, `syncNow`, `disconnect`, and `connectImap` (also behind `POST
 * /api/channels/email/imap`). Gmail and Microsoft 365 connect through `POST
 * /api/oauth/email/{google|microsoft}` and its callback. Nothing returned holds a token or a
 * password.
 */
export function getEmail(): EmailConnectionService {
  return getServerPipeline().email.connections;
}
