import type { z } from "zod";

import { type ConnectorError, err, ok, type Result } from "@repo/core";

/** `fetch`, injectable: contract tests replay recorded fixtures through it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VendorRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body. Values are serialized by `JSON.stringify`: customer text stays data. */
  readonly json?: unknown;
  /** A form body (`application/x-www-form-urlencoded`), encoded by `URLSearchParams`. */
  readonly form?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Longest wait a vendor's Retry-After may ask for before we treat it as a plain retry. */
const MAX_RETRY_AFTER_SECONDS = 6 * 3600;

/** Seconds from a Retry-After header (seconds or an HTTP date), capped. */
export function retryAfterSeconds(headers: Headers, now: number): number | null {
  const value = headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((date - now) / 1000)));
}

/** A `ConnectorError`. The message is shown in the admin panel: no secrets, no payloads. */
export function connectorError(
  code: ConnectorError["code"],
  message: string,
  options: { readonly retryable?: boolean; readonly retryAfterSeconds?: number | null } = {},
): ConnectorError {
  const retryable =
    options.retryable ?? (code === "rate_limited" || code === "unavailable" || code === "unknown");
  return {
    code,
    message: message.slice(0, 500),
    retryable,
    retryAfterSeconds: options.retryAfterSeconds ?? null,
  };
}

/**
 * A vendor's error text with what may be the customer's data or a credential taken out, for
 * the admin panel and the delivery log: vendors echo the values they refused ("Email address
 * pat@example.com is invalid", `"firstName":"..."`). Email addresses, quoted values, phone-like
 * digit runs and long token-like strings are replaced; a record id after "ID:" is kept.
 */
export function redactVendorText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/"[^"]*"|“[^”]*”|'[^'\s][^']*'/g, '"…"')
    .replace(/(?<!\bID:\s*)(?<![\d+(])(?:\+|\()?\d[\d\s().-]{6,}\d/gi, "[number]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .trim()
    .slice(0, 200);
}

/**
 * Pulls a short, safe explanation out of a vendor's error body: the message fields vendors
 * use, never the whole body (it may echo the customer's data back), redacted
 * (`redactVendorText`).
 */
export function vendorMessage(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "title", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return redactVendorText(value);
  }
  const error = record["error"];
  if (typeof error === "string") return redactVendorText(error);
  if (error !== null && typeof error === "object") return vendorMessage(error);
  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) return vendorMessage(errors[0]);
  return null;
}

/** Maps an HTTP status to the contract's error code. */
export function errorForStatus(
  vendor: string,
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ConnectorError {
  const detail = vendorMessage(body);
  const suffix = detail === null ? "" : `: ${detail}`;
  if (status === 401) {
    return connectorError(
      "auth_expired",
      `${vendor} refused the stored credentials (401). Connect it again${suffix}`,
      { retryable: false },
    );
  }
  if (status === 403) {
    return connectorError(
      "permission_denied",
      `${vendor} denied the request (403): check the app's permissions${suffix}`,
      { retryable: false },
    );
  }
  if (status === 404 || status === 410) {
    return connectorError("not_found", `${vendor} could not find the record (${status})${suffix}`, {
      retryable: false,
    });
  }
  if (status === 429) {
    return connectorError("rate_limited", `${vendor} is rate limiting requests (429)${suffix}`, {
      retryable: true,
      retryAfterSeconds: retryAfterSeconds(headers, now),
    });
  }
  if (status === 408 || status >= 500) {
    return connectorError("unavailable", `${vendor} is unavailable (${status})${suffix}`, {
      retryable: true,
      retryAfterSeconds: retryAfterSeconds(headers, now),
    });
  }
  return connectorError("validation", `${vendor} rejected the data (${status})${suffix}`, {
    retryable: false,
  });
}

export interface VendorResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

/**
 * One request to a vendor API. Never throws for an HTTP or network failure: it answers a
 * `ConnectorError`. 2xx answers are checked against `schema`; an answer of the wrong shape is
 * `unknown` (retryable: it is usually a vendor hiccup, and the retry limit bounds it).
 * Redirects are refused, so a credential is never carried to another host.
 */
export async function vendorJson<T>(
  fetchImpl: FetchLike,
  vendor: string,
  request: VendorRequest,
  schema: z.ZodType<T>,
  now: () => Date,
): Promise<Result<VendorResponse<T>, ConnectorError>> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams({ ...request.form }).toString();
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
    const name = error instanceof Error ? error.name : "network error";
    return err(
      connectorError("unavailable", `${vendor} could not be reached (${name}).`, {
        retryable: true,
      }),
    );
  }
  let parsed: unknown = null;
  const text = await response.text().catch(() => "");
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    return err(errorForStatus(vendor, response.status, parsed, response.headers, now().getTime()));
  }
  const checked = schema.safeParse(parsed ?? {});
  if (!checked.success) {
    return err(
      connectorError(
        "unknown",
        `${vendor} answered in an unexpected shape (${checked.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "body")
          .join(", ")}).`,
        { retryable: true },
      ),
    );
  }
  return ok({ status: response.status, data: checked.data, headers: response.headers });
}

/** Joins a base URL and a path whose dynamic parts are already encoded. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Encodes one path segment (an id that came from a vendor or from storage). */
export function segment(value: string): string {
  return encodeURIComponent(value);
}
