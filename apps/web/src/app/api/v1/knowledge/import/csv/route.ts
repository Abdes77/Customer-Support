import { handleCsvImportRequest } from "@repo/knowledge";

import { importApiDeps } from "@/server/knowledge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Imports a CSV file of business knowledge: `text/csv` in the body, or a `multipart/form-data`
 * upload with a `file` field. Authentication: `Authorization: Bearer <API key>` with the
 * scope `knowledge:write`. Parameters are described in `packages/knowledge/src/import/http.ts`.
 */
export function POST(request: Request): Promise<Response> {
  return handleCsvImportRequest(request, importApiDeps());
}
