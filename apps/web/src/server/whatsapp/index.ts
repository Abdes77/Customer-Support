import type { ConnectionService } from "@repo/channel-whatsapp/server";

import { getServerPipeline } from "@/server/pipeline";

/**
 * WhatsApp for the app (C9): connected numbers, Embedded Signup and templates. Null when the
 * deployment has no Meta app. The admin panel (C16) calls these from server actions after
 * `requireAccess()` and `requireBusinessRole(access, business, ["agency_admin",
 * "agency_member"])`; they act in the business's system scope and never return a token.
 */
export function getWhatsApp(): ConnectionService | null {
  return getServerPipeline().whatsapp;
}
