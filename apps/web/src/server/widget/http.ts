import type { WidgetOutcome, WidgetRequestInfo, WidgetService } from "@repo/channel-widget/server";
import { logger, type WidgetError } from "@repo/core";
import { getEnv } from "@repo/core/env";
import { createMemoryRateLimiter, type MemoryRateLimiter } from "@repo/observability";

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

/** Which hop of the forwarding chain is the visitor (C17): deployment settings, not settings. */
export interface ClientIpOptions {
  /** A header the edge sets to the client address and overwrites (`CLIENT_IP_HEADER`). */
  readonly header?: string | null;
  /** Proxies that append to `x-forwarded-for` (`TRUSTED_PROXY_HOPS`, default 1: Vercel). */
  readonly trustedHops?: number;
}

function clientIpOptionsFromEnv(): ClientIpOptions {
  const env = getEnv();
  return { header: env.CLIENT_IP_HEADER ?? null, trustedHops: env.TRUSTED_PROXY_HOPS };
}

/**
 * The visitor's address, for the per-address limits only. Entries of `x-forwarded-for` are
 * appended hop by hop, so only the last `trustedHops` were written by proxies of this
 * deployment; anything to their left is whatever the client sent, and a script could pick a
 * fresh one per request. The client is therefore the entry `trustedHops` from the right
 * (1 on Vercel alone, which overwrites what the client sent; 2 behind a CDN that appends
 * too). When the edge sets a header of its own (`cf-connecting-ip`), `CLIENT_IP_HEADER`
 * names it and it wins. Too few entries for the hops configured means the request did not
 * come through the expected proxies: the nearest entry is used, never one further left.
 */
export function clientIp(
  request: Request,
  options: ClientIpOptions = clientIpOptionsFromEnv(),
): string | null {
  const nonEmpty = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? null : trimmed;
  };
  const fromEdge =
    options.header === undefined || options.header === null
      ? null
      : nonEmpty(request.headers.get(options.header)?.split(",")[0]);
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const hops = Math.max(1, options.trustedHops ?? 1);
  const forwarded = chain.length === 0 ? null : chain[Math.max(0, chain.length - hops)];
  const ip = fromEdge ?? nonEmpty(forwarded) ?? nonEmpty(request.headers.get("x-real-ip"));
  return ip === null ? null : ip.slice(0, 64);
}

export function requestInfo(request: Request): WidgetRequestInfo {
  return {
    origin: request.headers.get("origin"),
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  };
}

/**
 * Per-address limits checked before the database is reached (C17, the C8 review's note):
 * `config` and `session` are the two calls anyone can make with only a public key. Counted in
 * this process's memory, so on a serverless platform each instance counts on its own; the
 * per-address session limit in PostgreSQL (`limits.widget_sessions_per_ip_per_hour`) and a
 * platform firewall rule (HUMAN_TODO 21) are the deployment-wide limits.
 */
export const EDGE_LIMITS = {
  config: { limit: 60, windowMs: 60_000 },
  session: { limit: 20, windowMs: 60_000 },
} as const;

const edgeLimiters = {
  config: createMemoryRateLimiter(EDGE_LIMITS.config),
  session: createMemoryRateLimiter(EDGE_LIMITS.session),
};

const RATE_LIMITED: WidgetError = {
  error: "rate_limited",
  message: "Too many requests. Please try again shortly.",
};

/** A 429 when this address has made too many `kind` calls, else null. */
export function edgeLimit(
  request: Request,
  kind: keyof typeof EDGE_LIMITS,
  limiters: Record<keyof typeof EDGE_LIMITS, MemoryRateLimiter> = edgeLimiters,
): Response | null {
  const ip = clientIp(request);
  if (ip === null) return null;
  const hit = limiters[kind].hit(ip);
  if (hit.allowed) return null;
  return errorResponse(request, 429, { ...RATE_LIMITED, retryAfterSeconds: hit.retryAfterSeconds });
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
