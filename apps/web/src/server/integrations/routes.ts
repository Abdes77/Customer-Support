import { z } from "zod";

import { AppError, type BusinessId, logger as rootLogger, type Logger } from "@repo/core";
import { type BusinessRef, type Directory, requireBusinessRole } from "@repo/db";
import {
  CRM_OAUTH_COOKIE,
  type IntegrationService,
  isCrmProvider,
  isOAuthProvider,
} from "@repo/integrations";

import type { SessionAccess } from "@/server/auth";
import { isSameOriginRequest, safeNextPath } from "@/server/auth/redirects";

/*
 * The CRM connect routes (C14), framework-free so tests drive them with plain `Request`s:
 * - `POST /api/oauth/crm/{hubspot|gohighlevel|jobber}`: starts the sign-in for a business
 *   (agency staff, same-origin JSON), answers the vendor's URL and sets the flow's cookie
 *   (state nonce and PKCE verifier);
 * - `GET /api/oauth/crm/{provider}/callback`: finishes it (the same person, the cookie of the
 *   browser that started it, the role checked again), then redirects to the page that started
 *   it with `?crm=connected` or an error word;
 * - `POST /api/integrations/crm/{provider}`: connects with a key or client credentials
 *   (HubSpot private app, GoHighLevel private integration, Housecall Pro, ServiceTitan); the
 *   key is tested before it is stored. Nothing answered holds a token or a key.
 */

const MAX_BODY_BYTES = 8 * 1024;
const COOKIE_PATH = "/api/oauth/crm";

export interface IntegrationRouteDeps {
  readonly getAccess: () => Promise<SessionAccess | null>;
  readonly getIntegrations: () => IntegrationService;
  readonly directory: Pick<Directory, "findBusiness">;
  /** `APP_URL`: the public origin, when the app runs behind a proxy. */
  readonly appUrl?: string;
  readonly logger?: Logger;
}

function json(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function errorStatus(error: AppError): number {
  if (error.code === "validation_failed") return 400;
  if (error.code === "conflict") return 409;
  if (error.code === "config_missing") return 503;
  if (error.code === "not_found") return 404;
  if (error.code === "external_service_failed" || error.code === "rate_limited") return 502;
  return 500;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function staffFor(
  deps: IntegrationRouteDeps,
  session: SessionAccess,
  businessId: string,
): Promise<BusinessRef | Response> {
  const business = await deps.directory.findBusiness(businessId as BusinessId);
  if (business === null) return json(404, { error: "not_found" });
  try {
    requireBusinessRole(session.access, business, ["agency_admin", "agency_member"]);
  } catch {
    return json(403, { error: "forbidden" });
  }
  return business;
}

async function jsonBody<T>(
  request: Request,
  deps: IntegrationRouteDeps,
  schema: z.ZodType<T>,
): Promise<{ session: SessionAccess; body: T } | Response> {
  if (!isSameOriginRequest(request, deps.appUrl)) return json(403, { error: "cross_origin" });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json(415, { error: "json_required" });
  }
  const session = await deps.getAccess();
  if (session === null) return json(401, { error: "unauthorized" });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  try {
    return { session, body: schema.parse(JSON.parse(raw)) };
  } catch {
    return json(400, { error: "bad_request" });
  }
}

const StartBody = z.object({
  businessId: z.uuid(),
  /** Where the browser goes when the connection is done: a path on this site. */
  returnTo: z.string().max(512).optional(),
});

/** `POST /api/oauth/crm/{hubspot|gohighlevel|jobber}`. */
export function createCrmOAuthStartHandler(deps: IntegrationRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "crm-oauth-start" });
  return async (request: Request, provider: string): Promise<Response> => {
    if (!isOAuthProvider(provider)) return json(404, { error: "not_found" });
    const parsed = await jsonBody(request, deps, StartBody);
    if (parsed instanceof Response) return parsed;
    const business = await staffFor(deps, parsed.session, parsed.body.businessId);
    if (business instanceof Response) return business;
    try {
      const started = deps
        .getIntegrations()
        .startOAuth(
          { agencyId: business.agencyId, businessId: business.businessId },
          parsed.session.user.id,
          provider,
          { returnTo: safeNextPath(parsed.body.returnTo) },
        );
      const secure =
        new URL(request.url).protocol === "https:" || (deps.appUrl ?? "").startsWith("https:");
      return json(
        200,
        { authorizationUrl: started.authorizationUrl },
        {
          "set-cookie": `${started.cookie.name}=${started.cookie.value}; Path=${COOKIE_PATH}; Max-Age=${started.cookie.maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
        },
      );
    } catch (error) {
      if (error instanceof AppError) {
        return json(errorStatus(error), { error: error.code, message: error.message });
      }
      log.error("crm.oauth_start_failed", { error });
      return json(500, { error: "internal" });
    }
  };
}

function redirect(location: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    `${CRM_OAUTH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 303, headers });
}

function withResult(path: string, result: string): string {
  const url = new URL(path, "https://app.invalid");
  url.searchParams.set("crm", result);
  return `${url.pathname}${url.search}`;
}

/** `GET /api/oauth/crm/{hubspot|gohighlevel|jobber}/callback`. */
export function createCrmOAuthCallbackHandler(deps: IntegrationRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "crm-oauth-callback" });
  return async (request: Request, provider: string): Promise<Response> => {
    if (!isOAuthProvider(provider)) return json(404, { error: "not_found" });
    const url = new URL(request.url);
    const service = deps.getIntegrations();
    let payload: ReturnType<IntegrationService["readState"]>;
    try {
      payload = service.readState(
        url.searchParams.get("state") ?? "",
        readCookie(request, CRM_OAUTH_COOKIE),
      );
    } catch {
      return redirect(withResult("/", "invalid_state"));
    }
    const back = safeNextPath(payload.r);
    if (payload.p !== provider) return redirect(withResult(back, "invalid_state"));
    const code = url.searchParams.get("code");
    if (
      url.searchParams.get("error") !== null ||
      code === null ||
      code.length === 0 ||
      code.length > 4000
    ) {
      return redirect(withResult(back, "cancelled"));
    }
    const session = await deps.getAccess();
    // The person who started the flow, still agency staff of that business.
    if (session?.user.id !== payload.u) return redirect(withResult(back, "signed_out"));
    const business = await staffFor(deps, session, payload.b);
    if (business instanceof Response || business.agencyId !== payload.a) {
      return redirect(withResult(back, "forbidden"));
    }
    try {
      await service.completeOAuth(payload, code);
      return redirect(withResult(back, "connected"));
    } catch (error) {
      if (error instanceof AppError && errorStatus(error) !== 500) {
        log.warn("crm.oauth_refused", { code: error.code, businessId: payload.b, provider });
      } else {
        log.error("crm.oauth_failed", { error, provider });
      }
      return redirect(withResult(back, "failed"));
    }
  };
}

const KeyBody = z.object({
  businessId: z.uuid(),
  fields: z
    .record(z.string().max(60), z.string().max(4000))
    .refine((v) => Object.keys(v).length <= 10),
  config: z
    .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.null()]))
    .optional(),
});

/** `POST /api/integrations/crm/{provider}`: answers the connection (never the key). */
export function createCrmKeyConnectHandler(deps: IntegrationRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "crm-key-connect" });
  return async (request: Request, provider: string): Promise<Response> => {
    if (!isCrmProvider(provider)) return json(404, { error: "not_found" });
    const parsed = await jsonBody(request, deps, KeyBody);
    if (parsed instanceof Response) return parsed;
    const business = await staffFor(deps, parsed.session, parsed.body.businessId);
    if (business instanceof Response) return business;
    try {
      const connection = await deps
        .getIntegrations()
        .connectWithKey(
          { agencyId: business.agencyId, businessId: business.businessId },
          parsed.session.user.id,
          provider,
          {
            fields: parsed.body.fields,
            ...(parsed.body.config === undefined ? {} : { config: parsed.body.config }),
          },
        );
      return json(200, { connection: { ...connection } });
    } catch (error) {
      if (error instanceof AppError) {
        const status = errorStatus(error);
        if (status === 500) log.error("crm.key_connect_failed", { error, provider });
        return json(status, { error: error.code, message: error.message });
      }
      log.error("crm.key_connect_failed", { error, provider });
      return json(500, { error: "internal" });
    }
  };
}
