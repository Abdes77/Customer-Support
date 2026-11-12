import { z } from "zod";

import { ExternalServiceError, ValidationError } from "@repo/core";

import { classifyGraphError, type GraphErrorClass } from "./errors";

/**
 * A small client for Meta's Graph API, shared by WhatsApp (C9), Messenger and Instagram (C10).
 *
 * - The token travels in the `Authorization` header, never in a URL, and never appears in an
 *   error message or a log line.
 * - `fetch` is injected, so tests run against recorded fixtures and nothing here reads the
 *   environment: the caller passes the version (`META_GRAPH_API_VERSION`).
 * - Every failure is a `GraphApiError` carrying Meta's error code and how to react to it
 *   (`classifyGraphError`): retry after a while, the window is closed, the token is bad.
 */

export const DEFAULT_GRAPH_API_VERSION = "v27.0";
export const GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/**
 * Hosts Meta serves media from. A media URL comes from the Graph API or a signed webhook, but
 * it is still checked: the token goes with the request, and it must never reach another host.
 */
export const META_MEDIA_HOST_SUFFIXES = [
  "fbsbx.com",
  "facebook.com",
  "fbcdn.net",
  "whatsapp.net",
  "cdninstagram.com",
] as const;

export function assertMetaMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("The media address is not a URL.");
  }
  const host = url.hostname.toLowerCase();
  const allowed = META_MEDIA_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new ValidationError("The media address is not one of Meta's hosts.", {
      details: { host },
    });
  }
  return url;
}
/**
 * A media type as `type/subtype`, lowercased, without parameters; anything else (empty,
 * malformed, or a header full of junk) becomes `application/octet-stream`. The type is
 * stored with the file and decides how it is served later.
 */
export function cleanMimeType(raw: string | null | undefined): string {
  const value = raw?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value)
    ? value
    : "application/octet-stream";
}

/** Largest JSON answer we read (template lists are the biggest). */
const MAX_JSON_BYTES = 5 * 1024 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  /** Graph API version, for example "v27.0". */
  readonly version?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Tests point this at a fake; production uses graph.facebook.com. */
  readonly baseUrl?: string;
}

export type GraphQuery = Readonly<Record<string, string | number | boolean | undefined>>;

export interface GraphRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** Path below the version, starting with "/": "/123456/messages". */
  readonly path: string;
  readonly token?: string;
  readonly query?: GraphQuery;
  readonly json?: unknown;
  readonly form?: FormData;
}

const GraphErrorBody = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    error_data: z.object({ details: z.string().optional() }).passthrough().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

export class GraphApiError extends ExternalServiceError {
  /** Meta's error code, or null when no answer came back (network, timeout). */
  readonly graphCode: number | null;
  /** `error_subcode`, which Messenger and Instagram still send (null otherwise). */
  readonly subcode: number | null;
  readonly httpStatus: number | null;
  readonly fbtraceId: string | null;
  readonly classification: GraphErrorClass;

  constructor(
    message: string,
    options: {
      readonly graphCode: number | null;
      readonly httpStatus: number | null;
      readonly subcode?: number | null;
      readonly fbtraceId?: string | null;
      readonly usageHeader?: string | null;
      readonly cause?: unknown;
    },
  ) {
    const classification = classifyGraphError({
      code: options.graphCode,
      httpStatus: options.httpStatus,
      usageHeader: options.usageHeader ?? null,
      subcode: options.subcode ?? null,
    });
    super(message, {
      provider: "meta",
      retryable: classification.retryable,
      ...(options.httpStatus === null ? {} : { status: options.httpStatus }),
      ...(classification.retryAfterSeconds === null
        ? {}
        : { retryAfterSeconds: classification.retryAfterSeconds }),
      details: {
        graphCode: options.graphCode,
        httpStatus: options.httpStatus,
        ...(options.subcode == null ? {} : { subcode: options.subcode }),
      },
      cause: options.cause,
    });
    this.graphCode = options.graphCode;
    this.subcode = options.subcode ?? null;
    this.httpStatus = options.httpStatus;
    this.fbtraceId = options.fbtraceId ?? null;
    this.classification = classification;
  }

  /** A short stable code for storage and the admin panel: "meta_131047", "meta_network". */
  get slug(): string {
    return this.graphCode === null ? "meta_network" : `meta_${this.graphCode}`;
  }
}

export interface GraphClient {
  readonly version: string;
  /** Calls the API and returns the JSON answer, checked against `schema` when given. */
  request<T = unknown>(request: GraphRequest, schema?: z.ZodType<T>): Promise<T>;
  /**
   * Downloads bytes from a URL the API handed out (media), with the token in the header, or
   * without one (`null`) for the signed CDN links of Messenger and Instagram attachments.
   * Only Meta's hosts are fetched (`assertMetaMediaUrl`), on every redirect too.
   */
  download(
    url: string,
    token: string | null,
    options: { readonly maxBytes: number },
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
}

function buildUrl(base: string, version: string, path: string, query?: GraphQuery): string {
  if (!path.startsWith("/") || path.includes("..") || /[?#\s]/.test(path)) {
    throw new ValidationError("Invalid Graph API path.");
  }
  const url = new URL(`${base}/${version}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidationError("The file is too large.", { details: { bytes: declared } });
  }
  if (response.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += value.byteLength;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new ValidationError("The file is too large.", { details: { bytes: total } });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function errorFrom(response: Response): Promise<GraphApiError> {
  let parsed: z.infer<typeof GraphErrorBody> | null;
  try {
    const text = new TextDecoder().decode(await readLimited(response, 64 * 1024));
    const result = GraphErrorBody.safeParse(JSON.parse(text));
    parsed = result.success ? result.data : null;
  } catch {
    parsed = null;
  }
  const code = parsed?.error.code ?? null;
  // Meta's own text names the problem ("(#131047) Re-engagement message"); it never holds the
  // token. `details` is the most useful part, per the error-code docs.
  const details = parsed?.error.error_data?.details;
  const title = parsed?.error.message ?? `HTTP ${response.status}`;
  const message = details !== undefined && details.length > 0 ? `${title}: ${details}` : title;
  return new GraphApiError(message.slice(0, 500), {
    graphCode: code,
    httpStatus: response.status,
    subcode: parsed?.error.error_subcode ?? null,
    fbtraceId: parsed?.error.fbtrace_id ?? null,
    usageHeader:
      response.headers.get("x-business-use-case-usage") ?? response.headers.get("x-app-usage"),
  });
}

export function createGraphClient(options: GraphClientOptions = {}): GraphClient {
  const version = options.version ?? DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new ValidationError("The Graph API version must look like v27.0.");
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.baseUrl ?? GRAPH_BASE_URL;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new GraphApiError("Meta could not be reached.", {
        graphCode: null,
        httpStatus: null,
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    version,

    async request<T>(request: GraphRequest, schema?: z.ZodType<T>): Promise<T> {
      const headers: Record<string, string> = { accept: "application/json" };
      if (request.token !== undefined) headers["authorization"] = `Bearer ${request.token}`;
      let body: string | FormData | undefined;
      if (request.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.json);
      } else if (request.form !== undefined) {
        body = request.form;
      }
      const response = await send(buildUrl(base, version, request.path, request.query), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
      });
      if (!response.ok) throw await errorFrom(response);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(await readLimited(response, MAX_JSON_BYTES)));
      } catch {
        throw new GraphApiError("Meta answered with something that is not JSON.", {
          graphCode: null,
          httpStatus: response.status,
        });
      }
      if (schema === undefined) return json as T;
      const checked = schema.safeParse(json);
      if (!checked.success) {
        // Meta accepted the request (2xx): not retryable, or a send that went out would be
        // sent again on every retry.
        throw new GraphApiError("Meta's answer did not have the expected shape.", {
          graphCode: null,
          httpStatus: response.status,
          cause: checked.error.issues.map((issue) => issue.path.join(".")).join(", "),
        });
      }
      return checked.data;
    },

    async download(url, token, { maxBytes }) {
      // Redirects are followed by hand so that every hop is checked against Meta's hosts
      // before the token is sent there.
      let target = assertMetaMediaUrl(url);
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        response = await send(target.toString(), {
          method: "GET",
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
          redirect: "manual",
        });
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || location === null) break;
        await response.body?.cancel().catch(() => undefined);
        target = assertMetaMediaUrl(new URL(location, target).toString());
        response = null;
      }
      if (response === null) {
        throw new GraphApiError("Too many redirects downloading a file.", {
          graphCode: null,
          httpStatus: 508,
        });
      }
      if (!response.ok) throw await errorFrom(response);
      const bytes = await readLimited(response, maxBytes);
      return { bytes, mimeType: cleanMimeType(response.headers.get("content-type")) };
    },
  };
}
