import type { z } from "zod";

import { ExternalServiceError, ValidationError } from "@repo/core";

/** `fetch`, injectable: tests run every provider against fakes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MailProviderName = "gmail" | "microsoft" | "google_oauth" | "microsoft_oauth";

/**
 * A provider refused or failed a request. `providerCode` is the provider's own error code
 * (Graph `ErrorItemNotFound`, Google `invalid_grant`); `authFailed` means the token was
 * refused (expired, revoked, missing scope), so the connection needs to be connected again.
 * The message never contains a token.
 */
export class MailProviderError extends ExternalServiceError {
  readonly providerCode: string | null;
  readonly authFailed: boolean;
  constructor(
    provider: MailProviderName,
    message: string,
    options: {
      readonly status?: number;
      readonly providerCode?: string | null;
      readonly retryAfterSeconds?: number;
      readonly authFailed?: boolean;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message, {
      provider,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: options.retryAfterSeconds }),
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
      details: {
        status: options.status ?? null,
        providerCode: options.providerCode ?? null,
      },
    });
    this.providerCode = options.providerCode ?? null;
    this.authFailed = options.authFailed ?? false;
  }
}

/** Seconds from a Retry-After header (seconds or an HTTP date), capped at a day. */
export function retryAfterSeconds(response: Response, now = Date.now()): number | undefined {
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
  return { code: null, message: null };
}

export interface ApiRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly token?: string;
  readonly json?: unknown;
  /** A raw body (Graph's base64 MIME, a form). */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One request to a mail provider's HTTP API. Statuses: 2xx is success; 401 and 403 are an
 * authentication failure (not retried); 408, 429 and 5xx are retried, honouring Retry-After;
 * other 4xx fail for good.
 */
export async function apiRequest(
  fetchImpl: FetchLike,
  provider: MailProviderName,
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
    throw new MailProviderError(
      provider,
      `The ${provider} request failed: ${error instanceof Error ? error.name : "network error"}.`,
      {
        retryable: true,
      },
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
  const authFailed =
    status === 401 ||
    (status === 403 && code !== "rateLimitExceeded" && code !== "userRateLimitExceeded") ||
    code === "invalid_grant";
  const retryable =
    !authFailed &&
    (status === 408 ||
      status === 429 ||
      status >= 500 ||
      code === "rateLimitExceeded" ||
      code === "userRateLimitExceeded");
  const wait = retryAfterSeconds(response);
  throw new MailProviderError(
    provider,
    `The ${provider} request was refused (${status}${code === null ? "" : ` ${code}`})${message === null ? "" : `: ${message.slice(0, 200)}`}`,
    {
      status,
      providerCode: code,
      authFailed,
      retryable,
      ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    },
  );
}

/** `apiRequest` with a JSON answer checked against `schema`. */
export async function apiJson<T>(
  fetchImpl: FetchLike,
  provider: MailProviderName,
  request: ApiRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await apiRequest(fetchImpl, provider, request);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MailProviderError(provider, `The ${provider} answer was not JSON.`, {
      retryable: true,
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(`The ${provider} answer did not have the expected shape.`, {
      details: { paths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data;
}

/** Bytes as base64url without padding (Gmail's `raw`). */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url (or base64) to bytes. */
export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
