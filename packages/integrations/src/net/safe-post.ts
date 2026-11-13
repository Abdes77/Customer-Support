import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

import { AppError } from "@repo/core";

import { isIpLiteral, isPublicAddress } from "./address";

/*
 * The only way an outgoing webhook leaves this server. The address was typed by a user, so it
 * must never make the server talk to something on its own network (server-side request
 * forgery). The same rules as the crawler's guarded fetcher (`createSafeFetcher` in
 * `@repo/knowledge`), for a POST:
 *
 * - `https:` only; no user name or password in the URL; the default port only.
 * - Host names that only exist on private networks (`localhost`, `*.local`, `*.internal`,
 *   single-label names) are refused before any lookup.
 * - The name is resolved once; every address must be public, and the connection is made to
 *   exactly the checked address (the socket never resolves the name again).
 * - Redirects are not followed: a 3xx is a failed delivery.
 * - The whole exchange has a time limit; the answer's body is read up to a small limit and
 *   thrown away (only the status is kept).
 *
 * Nothing is sent but the signed body and its headers: no cookies, no credentials.
 */

export type UnsafeTargetReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "host"
  | "dns"
  | "address"
  | "timeout"
  | "network";

/** The address was refused, or could not be reached. `reason` is safe to show. */
export class UnsafeTargetError extends AppError {
  readonly reason: UnsafeTargetReason;
  constructor(reason: UnsafeTargetReason, message: string, retryable = false) {
    super("validation_failed", message, { retryable, details: { reason } });
    this.reason = reason;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PostTransportRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface PostTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** One POST to a fixed address. Replaced in tests that need no sockets. */
export type PostTransport = (request: PostTransportRequest) => Promise<PostTransportResponse>;

export interface SafePosterDeps {
  /** DNS. Default: the system resolver, every address of the name. */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /** Which addresses may be connected to. Default `isPublicAddress`; tests widen it. */
  readonly isAllowedAddress?: (address: string) => boolean;
  /** Ports besides 443. Default none; tests pass their receiver's port. */
  readonly extraPorts?: readonly number[];
  /** Allow `http:` (tests with a local receiver only; product code never sets it). */
  readonly allowHttp?: boolean;
  readonly transport?: PostTransport;
}

export interface SafePoster {
  /** Checks an address without sending anything (the settings form's check). */
  check(url: string): Promise<{ readonly url: URL; readonly address: ResolvedAddress }>;
  post(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs?: number;
  }): Promise<PostTransportResponse>;
  /**
   * The poster as a `fetch` for the webhook connector: POST only, the status and headers of
   * the answer, an empty body. Throws `UnsafeTargetError` for a refused address.
   */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".home",
  ".home.arpa",
  ".localdomain",
];
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

const timedOut = () =>
  new UnsafeTargetError("timeout", "The webhook address took too long to answer.", true);

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(timedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The default transport: `node:http(s)` with the socket's DNS lookup pinned to one address. */
const nodeTransport: PostTransport = ({ url, address, headers, body, signal }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body) },
      agent: false,
      signal,
      lookup: (_hostname, lookupOptions, callback) => {
        const all = typeof lookupOptions === "object" && lookupOptions.all === true;
        if (all) {
          (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, [address]);
        } else {
          (callback as (error: null, address: string, family: number) => void)(
            null,
            address.address,
            address.family,
          );
        }
      },
      ...(secure && !isIpLiteral(host) ? { servername: host } : {}),
    };
    const request = (secure ? https : http).request(options, (response) => {
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        // The answer is not used: stop reading a receiver that sends too much.
        if (size > MAX_RESPONSE_BYTES) response.destroy();
      });
      const done = () => resolve({ status: response.statusCode ?? 0, headers: flat });
      response.on("end", done);
      response.on("close", done);
      response.on("error", () => done());
    });
    request.on("error", (error) => reject(error));
    request.end(body);
  });

export function createSafePoster(deps: SafePosterDeps = {}): SafePoster {
  const resolve = deps.resolve ?? systemResolve;
  const isAllowed = deps.isAllowedAddress ?? isPublicAddress;
  const transport = deps.transport ?? nodeTransport;
  const extraPorts = new Set(deps.extraPorts ?? []);

  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UnsafeTargetError("invalid_url", "That is not a web address.");
    }
    if (url.protocol !== "https:" && !(deps.allowHttp === true && url.protocol === "http:")) {
      throw new UnsafeTargetError("scheme", "Webhook addresses must start with https://.");
    }
    url.hash = "";
    if (url.username.length > 0 || url.password.length > 0) {
      throw new UnsafeTargetError(
        "credentials",
        "A webhook address must not contain a user name or password.",
      );
    }
    if (url.port.length > 0 && !extraPorts.has(Number(url.port))) {
      throw new UnsafeTargetError("port", "Webhook addresses must use the standard HTTPS port.");
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.length === 0) throw new UnsafeTargetError("host", "The address has no host name.");
    if (isIpLiteral(host)) {
      if (!isAllowed(host.replace(/^\[(.*)\]$/, "$1"))) {
        throw new UnsafeTargetError("address", "That address is not on the public internet.");
      }
      return url;
    }
    if (
      !host.includes(".") ||
      host === "localhost" ||
      PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ) {
      throw new UnsafeTargetError("host", "That host name is not on the public internet.");
    }
    return url;
  }

  async function checkAddress(url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIpLiteral(host)) return { address: host, family: host.includes(":") ? 6 : 4 };
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await untilAborted(resolve(host), signal);
    } catch (error) {
      if (error instanceof UnsafeTargetError) throw error;
      throw new UnsafeTargetError("dns", "The webhook's host name could not be found.", true);
    }
    if (addresses.length === 0) {
      throw new UnsafeTargetError("dns", "The webhook's host name could not be found.", true);
    }
    if (!addresses.every((entry) => isAllowed(entry.address))) {
      throw new UnsafeTargetError(
        "address",
        "The webhook's host name points at an address that is not public.",
      );
    }
    const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    if (chosen === undefined) {
      throw new UnsafeTargetError("dns", "The webhook's host name could not be found.", true);
    }
    return chosen;
  }

  async function post(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs?: number;
  }): Promise<PostTransportResponse> {
    const signal = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const url = checkUrl(input.url);
    const address = await checkAddress(url, signal);
    try {
      return await transport({ url, address, headers: input.headers, body: input.body, signal });
    } catch (error) {
      if (error instanceof UnsafeTargetError) throw error;
      if (signal.aborted) throw timedOut();
      throw new UnsafeTargetError("network", "The webhook address could not be reached.", true);
    }
  }

  return {
    async check(raw) {
      const url = checkUrl(raw);
      const address = await checkAddress(url, AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
      return { url, address };
    },
    post,
    fetch: async (input, init) => {
      if ((init?.method ?? "GET").toUpperCase() !== "POST") {
        throw new UnsafeTargetError("network", "Only POST requests are sent to webhooks.");
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = typeof init?.body === "string" ? init.body : "";
      const answer = await post({ url: input, headers, body });
      return new Response(null, {
        status: answer.status < 200 || answer.status > 599 ? 502 : answer.status,
        headers:
          answer.headers["retry-after"] === undefined
            ? {}
            : { "retry-after": answer.headers["retry-after"] },
      });
    },
  };
}
