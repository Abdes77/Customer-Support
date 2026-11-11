import type { NextRequest, NextResponse } from "next/server";

import { refreshSession } from "@/server/auth/refresh";

/**
 * Next.js 16 proxy (formerly middleware). It only keeps the session cookies fresh; it is
 * not an authorization layer. Every page, server action and route handler checks the user
 * itself, because a route outside the matcher below would otherwise be unprotected.
 */
export function proxy(request: NextRequest): Promise<NextResponse> {
  return refreshSession(request);
}

export const config = {
  // Everything except static files and the machine-to-machine endpoints, which carry no
  // user session: webhooks, the Inngest endpoint, health checks and the public widget API.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/inngest|api/health|api/widget|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)",
  ],
};
