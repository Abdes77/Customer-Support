import type { GraphClient } from "@repo/channel-meta";
import type { Logger } from "@repo/core";
import type { Database } from "@repo/db";

/** What the server half of the WhatsApp channel needs. Built once in apps/web. */
export interface WhatsAppServerDeps {
  readonly db: Database;
  readonly graph: GraphClient;
  readonly logger: Logger;
  /** The Meta app (`META_APP_ID`, `META_APP_SECRET`); needed for Embedded Signup only. */
  readonly app?: { readonly appId: string; readonly appSecret: string } | null;
  /** Configuration id of the Embedded Signup flow (`META_WHATSAPP_SIGNUP_CONFIG_ID`). */
  readonly signupConfigId?: string | null;
  readonly clock?: () => Date;
}
