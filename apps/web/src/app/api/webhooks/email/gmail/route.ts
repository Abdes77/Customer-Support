import { getServerPipeline } from "@/server/pipeline";
import { handleNotification } from "@/server/email/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Gmail push notifications through Cloud Pub/Sub (C11). The OIDC token of the push is
 * verified; the mailbox it names gets a sync. See `createGmailPushHandler`.
 */
export function POST(request: Request): Promise<Response> {
  return handleNotification(request, getServerPipeline().email.gmailPush);
}
