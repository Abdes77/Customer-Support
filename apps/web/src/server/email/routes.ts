import { z } from "zod";

import { MailHostError } from "@repo/channel-email";
import {
  type EmailConnectionService,
  ImapConnectInput,
  OAUTH_COOKIE,
  type PushRequest,
  type PushResponse,
} from "@repo/channel-email/server";
import { AppError, type BusinessId, logger as rootLogger, type Logger } from "@repo/core";
import { type BusinessRef, type Directory, requireBusinessRole } from "@repo/db";

import type { SessionAccess } from "@/server/auth";
import { isSameOriginRequest, safeNextPath } from "@/server/auth/redirects";

/*
 * The email routes (C11), framework-free so tests drive them with plain `Request`s:
 * - `POST /api/webhooks/email/gmail` and `POST /api/webhooks/email/microsoft`: provider
 *   notifications (checked by the package's handlers);
 * - `POST /api/oauth/email/{google|microsoft}`: starts OAuth for a business (agency staff,
 *   same-origin JSON), answers the provider's URL and sets the flow's cookie;
 * - `GET /api/oauth/email/{google|microsoft}/callback`: finishes it (the same person, the
 *   cookie of the browser that started it, the role checked again), then redirects;
 * - `POST /api/channels/email/imap`: connects an IMAP/SMTP inbox (agency staff, same-origin).
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_NOTIFICATION_BYTES = 1024 * 1024;
const COOKIE_PATH = "/api/oauth/email";

export interface EmailRouteDeps {
  readonly getAccess: () => Promise<SessionAccess | null>;
  readonly getEmail: () => EmailConnectionService;
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

/** Turns a provider notification route into a `Response` (body size checked first). */
export async function handleNotification(
  request: Request,
  handler: (request: PushRequest) => Promise<PushResponse>,
  log: Logger = rootLogger,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_NOTIFICATION_BYTES)
    return new Response(null, { status: 413 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_NOTIFICATION_BYTES)
    return new Response(null, { status: 413 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  try {
    const result = await handler({
      headers,
      query: Object.fromEntries(new URL(request.url).searchParams),
      rawBody,
    });
    return new Response(result.body ?? null, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(result.contentType === undefined ? {} : { "content-type": result.contentType }),
      },
    });
  } catch (error) {
    // Storing or emitting failed: the provider retries.
    log.error("email.notification_failed", { error });
    return new Response(null, { status: 500 });
  }
}

const StartBody = z.object({
  businessId: z.uuid(),
  /** Where the browser goes when the connection is done: a path on this site. */
  returnTo: z.string().max(512).optional(),
  loginHint: z.email().max(320).optional(),
});

type Provider = "gmail" | "microsoft";

export function providerOf(segment: string): Provider | null {
  return segment === "google" ? "gmail" : segment === "microsoft" ? "microsoft" : null;
}

async function staffFor(
  deps: EmailRouteDeps,
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

function cookieHeader(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** `POST /api/oauth/email/{google|microsoft}`. */
export function createOAuthStartHandler(deps: EmailRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "email-oauth-start" });
  return async (request: Request, segment: string): Promise<Response> => {
    const provider = providerOf(segment);
    if (provider === null) return json(404, { error: "not_found" });
    if (!isSameOriginRequest(request, deps.appUrl)) return json(403, { error: "cross_origin" });
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json(415, { error: "json_required" });
    }
    const session = await deps.getAccess();
    if (session === null) return json(401, { error: "unauthorized" });
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    let body: z.infer<typeof StartBody>;
    try {
      body = StartBody.parse(JSON.parse(raw));
    } catch {
      return json(400, { error: "bad_request" });
    }
    const business = await staffFor(deps, session, body.businessId);
    if (business instanceof Response) return business;
    try {
      const started = deps
        .getEmail()
        .startOAuth(
          { agencyId: business.agencyId, businessId: business.businessId },
          session.user.id,
          provider,
          { returnTo: safeNextPath(body.returnTo), loginHint: body.loginHint ?? null },
        );
      const secure =
        new URL(request.url).protocol === "https:" || (deps.appUrl ?? "").startsWith("https:");
      return json(
        200,
        { authorizationUrl: started.authorizationUrl },
        {
          "set-cookie": cookieHeader(
            started.cookie.name,
            started.cookie.value,
            started.cookie.maxAgeSeconds,
            secure,
          ),
        },
      );
    } catch (error) {
      if (error instanceof AppError)
        return json(errorStatus(error), { error: error.code, message: error.message });
      log.error("email.oauth_start_failed", { error });
      return json(500, { error: "internal" });
    }
  };
}

function redirect(location: string, clearCookie: boolean): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (clearCookie)
    headers.append(
      "set-cookie",
      `${OAUTH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  return new Response(null, { status: 303, headers });
}

function withResult(path: string, result: string): string {
  const url = new URL(path, "https://app.invalid");
  url.searchParams.set("email", result);
  return `${url.pathname}${url.search}`;
}

/**
 * `GET /api/oauth/email/{google|microsoft}/callback`: the provider sends the browser back
 * with `code` and `state` (or `error`). Redirects to the page that started the flow with
 * `?email=connected` or `?email=<error>`; never shows a token.
 */
export function createOAuthCallbackHandler(deps: EmailRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "email-oauth-callback" });
  return async (request: Request, segment: string): Promise<Response> => {
    const provider = providerOf(segment);
    if (provider === null) return json(404, { error: "not_found" });
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const service = deps.getEmail();
    let payload: ReturnType<EmailConnectionService["readState"]>;
    try {
      payload = service.readState(state, readCookie(request, OAUTH_COOKIE));
    } catch {
      return redirect(withResult("/", "invalid_state"), true);
    }
    const back = safeNextPath(payload.r);
    if (payload.p !== provider) return redirect(withResult(back, "invalid_state"), true);
    if (
      url.searchParams.get("error") !== null ||
      code === null ||
      code.length === 0 ||
      code.length > 4000
    ) {
      return redirect(withResult(back, "cancelled"), true);
    }
    const session = await deps.getAccess();
    // The person who started the flow, still agency staff of that business.
    if (session?.user.id !== payload.u) return redirect(withResult(back, "signed_out"), true);
    const business = await staffFor(deps, session, payload.b);
    if (business instanceof Response || business.agencyId !== payload.a) {
      return redirect(withResult(back, "forbidden"), true);
    }
    try {
      await service.completeOAuth(payload, code);
      return redirect(withResult(back, "connected"), true);
    } catch (error) {
      if (error instanceof AppError) {
        const status = errorStatus(error);
        if (status === 500) log.error("email.oauth_failed", { error });
        else log.warn("email.oauth_refused", { code: error.code, businessId: payload.b });
        return redirect(withResult(back, error.code === "conflict" ? "in_use" : "failed"), true);
      }
      log.error("email.oauth_failed", { error });
      return redirect(withResult(back, "failed"), true);
    }
  };
}

const ImapBody = z.object({ businessId: z.uuid() }).passthrough();

/** `POST /api/channels/email/imap`: connects an IMAP/SMTP inbox; answers the view (no password). */
export function createImapConnectHandler(deps: EmailRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "email-imap-connect" });
  return async (request: Request): Promise<Response> => {
    if (!isSameOriginRequest(request, deps.appUrl)) return json(403, { error: "cross_origin" });
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json(415, { error: "json_required" });
    }
    const session = await deps.getAccess();
    if (session === null) return json(401, { error: "unauthorized" });
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    let body: z.infer<typeof ImapBody>;
    let input: z.infer<typeof ImapConnectInput>;
    try {
      body = ImapBody.parse(JSON.parse(raw));
      input = ImapConnectInput.parse(body);
    } catch {
      return json(400, { error: "bad_request" });
    }
    const business = await staffFor(deps, session, body.businessId);
    if (business instanceof Response) return business;
    try {
      const connection = await deps
        .getEmail()
        .connectImap(
          { agencyId: business.agencyId, businessId: business.businessId },
          session.user.id,
          input,
        );
      return json(200, { connection: { ...connection } });
    } catch (error) {
      if (error instanceof MailHostError)
        return json(400, {
          error: "mail_host_refused",
          reason: error.reason,
          message: error.message,
        });
      if (error instanceof AppError) {
        const status = errorStatus(error);
        if (status === 500) log.error("email.imap_connect_failed", { error });
        return json(status, { error: error.code, message: error.message });
      }
      log.error("email.imap_connect_failed", { error });
      return json(500, { error: "internal" });
    }
  };
}
