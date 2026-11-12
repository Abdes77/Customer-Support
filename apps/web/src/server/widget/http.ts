import type { WidgetOutcome, WidgetRequestInfo, WidgetService } from "@repo/channel-widget/server";
import { logger, type WidgetError } from "@repo/core";

import { getServerPipeline } from "@/server/pipeline";

/*
 * HTTP plumbing shared by the `/api/widget/v1` routes: CORS, the request facts the service
 * needs, capped body reading and turning a service outcome into a response. No widget logic
 * lives here (that is `@repo/channel-widget/server`).
 *
 * CORS: a preflight is answered for any origin (it carries no key or token, so there is
 * nothing to check yet); the real request is then checked against the business's allowed
 * sites, and a refused origin gets a 403 without CORS headers, which the browser does not let
 * the page read. Cookies are never used, so `Access-Control-Allow-Credentials` is never sent.
 */

export const MAX_JSON_BYTES = 16 * 1024;
/** The largest photo any business may allow (`channels.widget.max_upload_mb` ≤ 25) and the form around it. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 + 64 * 1024;

/**
 * The visitor's address, for the per-address session limit only. The last `x-forwarded-for`
 * entry is the one the nearest proxy added; earlier ones are whatever the client sent, so a
 * script could pick a fresh one per request. On Vercel the header holds only the address
 * Vercel saw (it overwrites what the client sent). Behind further proxies (a CDN in front of
 * the app) this is the CDN's address: C17 decides which hop to trust there.
 */
export function clientIp(request: Request): string | null {
  const nonEmpty = (value: string | undefined) =>
    value === undefined || value === "" ? null : value;
  const ip =
    nonEmpty(request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()) ??
    nonEmpty(request.headers.get("x-real-ip")?.trim());
  return ip === null ? null : ip.slice(0, 64);
}

export function requestInfo(request: Request): WidgetRequestInfo {
  return {
    origin: request.headers.get("origin"),
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null || origin === "null") return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** The answer to a CORS preflight. */
export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export function errorResponse(
  request: Request,
  status: number,
  body: WidgetError,
  extra: Record<string, string> = {},
): Response {
  const cors =
    body.error === "origin_not_allowed"
      ? { vary: "Origin" }
      : corsHeaders(request.headers.get("origin"));
  return Response.json(body, {
    status,
    headers: {
      ...cors,
      "cache-control": "no-store",
      ...(body.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(body.retryAfterSeconds) }),
      ...extra,
    },
  });
}

export function outcomeResponse<T>(
  request: Request,
  outcome: WidgetOutcome<T>,
  cacheControl = "no-store",
): Response {
  if (!outcome.ok) return errorResponse(request, outcome.status, outcome.body);
  return Response.json(outcome.value, {
    status: 200,
    headers: { ...corsHeaders(request.headers.get("origin")), "cache-control": cacheControl },
  });
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]{1,2000})$/.exec(header.trim());
  return match?.[1] ?? null;
}

/** The body, or null when it is larger than `maxBytes` (read no further than that). */
export async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  const body = await readCapped(request, MAX_JSON_BYTES);
  if (body === null) return { ok: false, status: 413 };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

const UNAVAILABLE: WidgetError = {
  error: "unavailable",
  message: "The chat is unavailable right now. Please try again shortly.",
};

/**
 * Runs a widget route: finds the service (503 when the deployment has none), and turns an
 * unexpected error into a 503 the script can show, logged without the request body.
 */
export async function withWidget(
  request: Request,
  route: string,
  handler: (widget: WidgetService) => Promise<Response>,
  getWidget: () => WidgetService | null = () => getServerPipeline().widget,
): Promise<Response> {
  let widget: WidgetService | null;
  try {
    widget = getWidget();
  } catch (error) {
    logger.error("widget.unavailable", { route, error });
    return errorResponse(request, 503, UNAVAILABLE);
  }
  if (widget === null) return errorResponse(request, 503, UNAVAILABLE);
  try {
    return await handler(widget);
  } catch (error) {
    logger.error("widget.request_failed", { route, error });
    return errorResponse(request, 503, UNAVAILABLE);
  }
}

export const tooLarge: WidgetError = { error: "too_large", message: "The request is too large." };
export const invalid: WidgetError = {
  error: "invalid_request",
  message: "The request is not valid.",
};
