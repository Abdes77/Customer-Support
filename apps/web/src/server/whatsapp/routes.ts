import { z } from "zod";

import { GraphApiError } from "@repo/channel-meta";
import { type ConnectionService, TokenConnectInput } from "@repo/channel-whatsapp/server";
import {
  type AgencyId,
  AppError,
  type BusinessId,
  logger as rootLogger,
  type Logger,
  type UserId,
} from "@repo/core";
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
 * What both connect routes do around their own call: same-origin JSON only (so another site
 * cannot post on a staff member's behalf), a signed-in person, a size cap, the body's shape,
 * and agency staff of the business. Then `connect` runs, and Meta's and the service's
 * refusals become answers the page can show. The answer is the connection as the admin panel
 * shows it, never a token.
 */
function createConnectHandler<TBody extends { readonly businessId: string }>(
  deps: EmbeddedSignupRouteDeps,
  options: {
    readonly component: string;
    readonly event: string;
    readonly body: z.ZodType<TBody>;
    readonly connect: (
      whatsapp: ConnectionService,
      tenant: { readonly agencyId: AgencyId; readonly businessId: BusinessId },
      userId: UserId,
      body: TBody,
    ) => Promise<unknown>;
  },
) {
  const log = (deps.logger ?? rootLogger).child({ component: options.component });
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
    let parsed: TBody;
    try {
      parsed = options.body.parse(JSON.parse(raw));
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
      const connection = await options.connect(
        whatsapp,
        { agencyId: business.agencyId, businessId: business.businessId },
        session.user.id,
        parsed,
      );
      return json(200, { connection });
    } catch (error) {
      if (error instanceof GraphApiError) {
        log.warn(`${options.event}_failed`, {
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
        if (status === 500) log.error(`${options.event}_error`, { error });
        return json(status, { error: error.code, message: error.message });
      }
      log.error(`${options.event}_error`, { error });
      return json(500, { error: "internal" });
    }
  };
}

/**
 * `POST /api/oauth/meta/whatsapp`: the last step of Embedded Signup. The admin panel's
 * connection page (C16) posts what Meta's popup returned (the code, the WhatsApp Business
 * Account id and the phone number id) with the business it is connecting. Only agency staff
 * may connect a number.
 */
export function createEmbeddedSignupHandler(deps: EmbeddedSignupRouteDeps) {
  return createConnectHandler(deps, {
    component: "whatsapp-signup-route",
    event: "whatsapp.signup",
    body: Body,
    connect: (whatsapp, tenant, userId, body) =>
      whatsapp.completeEmbeddedSignup(tenant, userId, {
        code: body.code,
        businessAccountId: body.businessAccountId,
        phoneNumberId: body.phoneNumberId,
        businessPortfolioId: body.businessPortfolioId ?? null,
      }),
  });
}

// The same rules as the service applies, so a malformed token is a "bad request" here and
// never reaches Meta or an error message.
const TokenBody = TokenConnectInput.extend({ businessId: z.uuid() });

/**
 * `POST /api/channels/whatsapp/token`: connects a number with an access token the agency
 * holds (a system user token of its own Meta app), typed into the connection page's form. The
 * token is checked against Meta, stored encrypted and never sent back or logged.
 */
export function createTokenConnectHandler(deps: EmbeddedSignupRouteDeps) {
  return createConnectHandler(deps, {
    component: "whatsapp-token-route",
    event: "whatsapp.token_connect",
    body: TokenBody,
    connect: (whatsapp, tenant, userId, body) =>
      whatsapp.connectWithToken(tenant, userId, {
        businessAccountId: body.businessAccountId,
        phoneNumberId: body.phoneNumberId,
        accessToken: body.accessToken,
        pin: body.pin ?? null,
      }),
  });
}
