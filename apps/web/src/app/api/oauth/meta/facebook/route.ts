import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getMetaPages } from "@/server/meta-pages";
import { createFacebookLoginHandler } from "@/server/meta-pages/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Up to four calls to Meta (code exchange, long-lived token, Pages, subscription).
export const maxDuration = 60;

/** Finishes Facebook Login for Business for a business (C10). See `createFacebookLoginHandler`. */
export function POST(request: Request): Promise<Response> {
  return createFacebookLoginHandler({
    getAccess,
    getMetaPages,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request);
}
