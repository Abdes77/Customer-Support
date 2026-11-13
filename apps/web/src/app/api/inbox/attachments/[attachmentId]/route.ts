import { getTenantStorage } from "@repo/db/storage";

import { serveAttachment } from "@/server/attachments";
import { getAccess } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A customer's file from a conversation, for people who may read it (C16). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { attachmentId } = await params;
  return serveAttachment({ getAccess, storage: getTenantStorage }, attachmentId);
}
