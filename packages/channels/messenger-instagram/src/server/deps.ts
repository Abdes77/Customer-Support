import type { GraphClient } from "@repo/channel-meta";
import type { Logger } from "@repo/core";
import type { Database } from "@repo/db";

/** What the server half of Messenger and Instagram needs. Built once in apps/web. */
export interface MetaPagesServerDeps {
  readonly db: Database;
  readonly graph: GraphClient;
  readonly logger: Logger;
  /** The Meta app (`META_APP_ID`, `META_APP_SECRET`); needed for Facebook Login only. */
  readonly app?: { readonly appId: string; readonly appSecret: string } | null;
  /** Configuration id of the Facebook Login for Business flow (`META_LOGIN_CONFIG_ID`). */
  readonly loginConfigId?: string | null;
  readonly clock?: () => Date;
}
