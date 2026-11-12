import { handleImportStatusRequest } from "@repo/knowledge";

import { importApiDeps } from "@/server/knowledge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The state of one import run: status, counters and the problems found. Authentication:
 * `Authorization: Bearer <API key>` with the scope `knowledge:read` or `knowledge:write`.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleImportStatusRequest(request, id, importApiDeps());
}
