import { getServerPipeline } from "@/server/pipeline";
import { handleNotification } from "@/server/email/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Graph wants an answer within 3 seconds (10 for the validation handshake).
export const maxDuration = 10;

/**
 * Microsoft Graph change and lifecycle notifications, and the validation handshake (C11).
 * See `createGraphNotificationHandler`.
 */
export function POST(request: Request): Promise<Response> {
  return handleNotification(request, getServerPipeline().email.graphNotifications);
}
