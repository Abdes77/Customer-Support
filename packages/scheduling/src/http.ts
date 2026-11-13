import type { z } from "zod";

import { ExternalServiceError, ValidationError } from "@repo/core";

/** `fetch`, injectable: tests run every provider against fakes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CalendarVendor =
  | "google_calendar"
  | "outlook_calendar"
  | "calendly"
  | "google_oauth"
  | "microsoft_oauth"
  | "calendly_oauth";

/**
 * A calendar vendor refused or failed a request. `authFailed` means the token was refused
 * (expired, revoked, missing scope): the connection has to be connected again. `notFound` is
 * set for 404 and 410 (an event someone already deleted). The message never holds a token.
 */
export class CalendarApiError extends ExternalServiceError {
  readonly vendorCode: string | null;
  readonly authFailed: boolean;
  readonly notFound: boolean;
  readonly conflict: boolean;
  constructor(
    vendor: CalendarVendor,
    message: string,
    options: {
      readonly status?: number;
      readonly vendorCode?: string | null;
      readonly retryAfterSeconds?: number;
      readonly authFailed?: boolean;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message, {
      provider: vendor,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: options.retryAfterSeconds }),
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
      details: { status: options.status ?? null, vendorCode: options.vendorCode ?? null },
    });
    this.vendorCode = options.vendorCode ?? null;
    this.authFailed = options.authFailed ?? false;
    this.notFound = options.status === 404 || options.status === 410;
    this.conflict = options.status === 409;
  }
}

/** Seconds from a Retry-After header (seconds or an HTTP date), capped at a day. */
function retryAfterSeconds(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(86_400, Math.max(1, Math.ceil(seconds)));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(86_400, Math.max(1, Math.ceil((date - now) / 1000)));
}

function errorCode(body: unknown): { code: string | null; message: string | null } {
  if (body === null || typeof body !== "object") return { code: null, message: null };
  const record = body as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "string") {
    const description = record["error_description"];
    return { code: error, message: typeof description === "string" ? description : null };
  }
  if (error !== null && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    const code =
      typeof nested["code"] === "string" || typeof nested["code"] === "number"
        ? String(nested["code"])
        : typeof nested["status"] === "string"
          ? nested["status"]
          : null;
    return { code, message: typeof nested["message"] === "string" ? nested["message"] : null };
  }
  // Calendly: { title, message }.
  return {
    code: typeof record["title"] === "string" ? record["title"] : null,
    message: typeof record["message"] === "string" ? record["message"] : null,
  };
}

export interface ApiRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly token?: string;
  readonly json?: unknown;
  /** A raw body (a form). */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const RATE_CODES = new Set(["rateLimitExceeded", "userRateLimitExceeded", "ApplicationThrottled"]);

/**
 * One request to a vendor's HTTP API. 2xx is success; 401 and 403 are an authentication
 * failure (not retried), except Google's rate-limit 403s; 408, 429 and 5xx are retried,
 * honouring Retry-After; other 4xx fail for good. Redirects are refused.
 */
export async function apiRequest(
  fetchImpl: FetchLike,
  vendor: CalendarVendor,
  request: ApiRequest,
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  if (request.token !== undefined) headers["authorization"] = `Bearer ${request.token}`;
  let body: string | undefined = request.body;
  if (request.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.json);
  }
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CalendarApiError(
      vendor,
      `The ${vendor} request failed: ${error instanceof Error ? error.name : "network error"}.`,
      { retryable: true },
    );
  }
  if (response.ok) return response;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const { code, message } = errorCode(parsed);
  const status = response.status;
  const rate = code !== null && RATE_CODES.has(code);
  const authFailed = status === 401 || (status === 403 && !rate) || code === "invalid_grant";
  const retryable = !authFailed && (status === 408 || status === 429 || status >= 500 || rate);
  const wait = retryAfterSeconds(response);
  throw new CalendarApiError(
    vendor,
    `The ${vendor} request was refused (${status}${code === null ? "" : ` ${code}`})${message === null ? "" : `: ${message.slice(0, 200)}`}`,
    {
      status,
      vendorCode: code,
      authFailed,
      retryable,
      ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    },
  );
}

/** `apiRequest` with a JSON answer checked against `schema`. */
export async function apiJson<T>(
  fetchImpl: FetchLike,
  vendor: CalendarVendor,
  request: ApiRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await apiRequest(fetchImpl, vendor, request);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CalendarApiError(vendor, `The ${vendor} answer was not JSON.`, { retryable: true });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(`The ${vendor} answer did not have the expected shape.`, {
      details: { paths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data;
}
