import { z } from "zod";

import { AppError, type BusinessId, logger as rootLogger, type Logger } from "@repo/core";
import { type BusinessRef, type Directory, requireBusinessRole } from "@repo/db";
import {
  CALENDAR_OAUTH_COOKIE,
  type CalendarOAuthProvider,
  type CalendlyWebhookRequest,
  type CalendlyWebhookResponse,
  type SchedulingConnectionService,
} from "@repo/scheduling";

import type { SessionAccess } from "@/server/auth";
import { isSameOriginRequest, safeNextPath } from "@/server/auth/redirects";

/*
 * The scheduling routes (C12), framework-free so tests drive them with plain `Request`s:
 * - `POST /api/oauth/calendar/{google|microsoft|calendly}`: starts connecting a calendar for a
 *   business (agency staff, same-origin JSON), answers the provider's URL and sets the flow's
 *   cookie (state nonce and PKCE verifier);
 * - `GET /api/oauth/calendar/{google|microsoft|calendly}/callback`: finishes it (the same
 *   person, the cookie of the browser that started it, the role checked again), then
 *   redirects to the page that started it with `?calendar=connected` or an error word;
 * - `POST /api/integrations/calendly/token`: connects Calendly with a personal access token;
 * - `POST /api/webhooks/calendly/{key}`: Calendly's deliveries (checked by the package).
 * Nothing answered holds a token.
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const COOKIE_PATH = "/api/oauth/calendar";

export interface SchedulingRouteDeps {
  readonly getAccess: () => Promise<SessionAccess | null>;
  readonly getScheduling: () => SchedulingConnectionService;
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

export function providerOf(segment: string): CalendarOAuthProvider | null {
  if (segment === "google") return "google_calendar";
  if (segment === "microsoft") return "outlook_calendar";
  if (segment === "calendly") return "calendly";
  return null;
}

async function staffFor(
  deps: SchedulingRouteDeps,
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

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Reads a same-origin JSON body for a signed-in person, or the response that refuses it. */
async function jsonBody<T>(
  request: Request,
  deps: SchedulingRouteDeps,
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

/** `POST /api/oauth/calendar/{google|microsoft|calendly}`. */
export function createCalendarOAuthStartHandler(deps: SchedulingRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "calendar-oauth-start" });
  return async (request: Request, segment: string): Promise<Response> => {
    const provider = providerOf(segment);
    if (provider === null) return json(404, { error: "not_found" });
    const parsed = await jsonBody(request, deps, StartBody);
    if (parsed instanceof Response) return parsed;
    const business = await staffFor(deps, parsed.session, parsed.body.businessId);
    if (business instanceof Response) return business;
    try {
      const started = deps
        .getScheduling()
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
      log.error("calendar.oauth_start_failed", { error });
      return json(500, { error: "internal" });
    }
  };
}

function redirect(location: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    `${CALENDAR_OAUTH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 303, headers });
}

function withResult(path: string, result: string): string {
  const url = new URL(path, "https://app.invalid");
  url.searchParams.set("calendar", result);
  return `${url.pathname}${url.search}`;
}

/** `GET /api/oauth/calendar/{google|microsoft|calendly}/callback`. */
export function createCalendarOAuthCallbackHandler(deps: SchedulingRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "calendar-oauth-callback" });
  return async (request: Request, segment: string): Promise<Response> => {
    const provider = providerOf(segment);
    if (provider === null) return json(404, { error: "not_found" });
    const url = new URL(request.url);
    const service = deps.getScheduling();
    let payload: ReturnType<SchedulingConnectionService["readState"]>;
    try {
      payload = service.readState(
        url.searchParams.get("state") ?? "",
        readCookie(request, CALENDAR_OAUTH_COOKIE),
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
      if (error instanceof AppError) {
        const status = errorStatus(error);
        if (status === 500) log.error("calendar.oauth_failed", { error });
        else log.warn("calendar.oauth_refused", { code: error.code, businessId: payload.b });
        return redirect(withResult(back, "failed"));
      }
      log.error("calendar.oauth_failed", { error });
      return redirect(withResult(back, "failed"));
    }
  };
}

const TokenBody = z.object({ businessId: z.uuid(), token: z.string().min(1).max(4000) });

/** `POST /api/integrations/calendly/token`: answers the connection (never the token). */
export function createCalendlyTokenHandler(deps: SchedulingRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "calendly-token" });
  return async (request: Request): Promise<Response> => {
    const parsed = await jsonBody(request, deps, TokenBody);
    if (parsed instanceof Response) return parsed;
    const business = await staffFor(deps, parsed.session, parsed.body.businessId);
    if (business instanceof Response) return business;
    try {
      const connection = await deps
        .getScheduling()
        .connectCalendlyToken(
          { agencyId: business.agencyId, businessId: business.businessId },
          parsed.session.user.id,
          parsed.body.token,
        );
      return json(200, { connection: { ...connection } });
    } catch (error) {
      if (error instanceof AppError) {
        const status = errorStatus(error);
        if (status === 500) log.error("calendly.token_failed", { error });
        return json(status, { error: error.code, message: error.message });
      }
      log.error("calendly.token_failed", { error });
      return json(500, { error: "internal" });
    }
  };
}

/** `POST /api/webhooks/calendly/{key}`: the raw body goes to the package's check. */
export async function handleCalendlyWebhook(
  request: Request,
  key: string,
  handler: (input: CalendlyWebhookRequest) => Promise<CalendlyWebhookResponse>,
  log: Logger = rootLogger,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES)
    return new Response(null, { status: 413 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES)
    return new Response(null, { status: 413 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  try {
    const result = await handler({ key, headers, rawBody });
    return new Response(null, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Storing failed: Calendly retries.
    log.error("calendly.webhook_failed", { error });
    return new Response(null, { status: 500 });
  }
}
