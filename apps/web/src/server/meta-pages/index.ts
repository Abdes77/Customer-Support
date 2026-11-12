import type { MetaPagesService } from "@repo/channel-messenger-instagram/server";

import { getServerPipeline } from "@/server/pipeline";

/**
 * Messenger and Instagram for the app (C10): connected Pages and Instagram accounts and
 * Facebook Login for Business. Null when the deployment has no Meta app. The admin panel
 * (C16) calls these from server actions after `requireAccess()` and
 * `requireBusinessRole(access, business, ["agency_admin", "agency_member"])`; they act in the
 * business's system scope and never return a token.
 */
export function getMetaPages(): MetaPagesService | null {
  return getServerPipeline().metaPages;
}
