import { z } from "zod";

import { GraphApiError } from "@repo/channel-meta";
import type { ConnectionService } from "@repo/channel-whatsapp/server";
import { AppError, type BusinessId, logger as rootLogger, type Logger } from "@repo/core";
import { type Directory, requireBusinessRole } from "@repo/db";

import type { SessionAccess } from "@/server/auth";
import { isSameOriginRequest } from "@/server/auth/redirects";

const MAX_BODY_BYTES = 8 * 1024;

const Body = z.object({
  businessId: z.uuid(),
  code: z.string().min(1).max(2000),
  businessAccountId: z.string().regex(/^\d{1,30}$/),
  phoneNumberId: z.string().regex(/^\d{1,30}$/),
  businessPortfolioId: z
    .string()
    .regex(/^\d{1,30}$/)
    .nullable()
    .optional(),
});

export interface EmbeddedSignupRouteDeps {
  readonly getAccess: () => Promise<SessionAccess | null>;
  readonly getWhatsApp: () => ConnectionService | null;
  readonly directory: Pick<Directory, "findBusiness">;
  /** `APP_URL`: the public origin, when the app runs behind a proxy. */
  readonly appUrl?: string;
  readonly logger?: Logger;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * `POST /api/oauth/meta/whatsapp`: the last step of Embedded Signup. The admin panel's
 * connection page (C16) posts what Meta's popup returned (the code, the WhatsApp Business
 * Account id and the phone number id) with the business it is connecting. Only agency staff
 * may connect a number. Same-origin JSON only, so another site cannot post it on a staff
 * member's behalf. The answer is the connection as the admin panel shows it, never a token.
 */
export function createEmbeddedSignupHandler(deps: EmbeddedSignupRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "whatsapp-signup-route" });
  return async (request: Request): Promise<Response> => {
    const whatsapp = deps.getWhatsApp();
    if (whatsapp === null) return json(503, { error: "whatsapp_not_configured" });

    // `Origin` and `Sec-Fetch-Site`, as for the sign-in forms; JSON only, so a plain HTML
    // form on another site cannot post it either.
    if (!isSameOriginRequest(request, deps.appUrl)) {
      return json(403, { error: "cross_origin" });
    }
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json(415, { error: "json_required" });
    }
    const session = await deps.getAccess();
    if (session === null) return json(401, { error: "unauthorized" });

    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    let parsed: z.infer<typeof Body>;
    try {
      parsed = Body.parse(JSON.parse(raw));
    } catch {
      return json(400, { error: "bad_request" });
    }

    const business = await deps.directory.findBusiness(parsed.businessId as BusinessId);
    if (business === null) return json(404, { error: "not_found" });
    try {
      requireBusinessRole(session.access, business, ["agency_admin", "agency_member"]);
    } catch {
      return json(403, { error: "forbidden" });
    }

    try {
      const connection = await whatsapp.completeEmbeddedSignup(
        { agencyId: business.agencyId, businessId: business.businessId },
        session.user.id,
        {
          code: parsed.code,
          businessAccountId: parsed.businessAccountId,
          phoneNumberId: parsed.phoneNumberId,
          businessPortfolioId: parsed.businessPortfolioId ?? null,
        },
      );
      return json(200, { connection });
    } catch (error) {
      if (error instanceof GraphApiError) {
        log.warn("whatsapp.signup_failed", {
          businessId: business.businessId,
          graphCode: error.graphCode,
          fbtraceId: error.fbtraceId,
        });
        return json(502, { error: "meta_refused", message: error.message });
      }
      if (error instanceof AppError) {
        const status =
          error.code === "validation_failed"
            ? 400
            : error.code === "conflict"
              ? 409
              : error.code === "config_missing"
                ? 503
                : 500;
        if (status === 500) log.error("whatsapp.signup_error", { error });
        return json(status, { error: error.code, message: error.message });
      }
      log.error("whatsapp.signup_error", { error });
      return json(500, { error: "internal" });
    }
  };
}
