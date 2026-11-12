import { handleImportRequest } from "@repo/knowledge";

import { importApiDeps } from "@/server/knowledge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One transaction for at most a few thousand facts.
export const maxDuration = 60;

/**
 * Imports business knowledge as JSON records. Authentication: `Authorization: Bearer <API
 * key>` with the scope `knowledge:write`. The request, its limits and its answers are
 * described in `packages/knowledge/src/import/http.ts`.
 */
export function POST(request: Request): Promise<Response> {
  return handleImportRequest(request, importApiDeps());
}
