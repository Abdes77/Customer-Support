import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { AppError } from "@repo/core";

import { isIpLiteral, isPublicAddress } from "./address";

/**
 * The fetcher for URLs that come from users: a business's website address and every link on
 * it. Such a URL must never make this server talk to something on its own network (the
 * database, a cloud metadata service, an admin port), which is what server-side request
 * forgery is. The rules, each with a test in `safe-fetch.test.ts`:
 *
 * - `http:` and `https:` only; no user name or password in the URL; default ports only.
 * - Host names that only exist on private networks (`localhost`, `*.local`, `*.internal`,
 *   single-label names) are refused before any lookup.
 * - The name is resolved once. If any of its addresses is not public the URL is refused;
 *   otherwise the connection is made to exactly the address that was checked (the socket
 *   never resolves the name again, so a second, different DNS answer cannot redirect it).
 * - Redirects are followed by hand, at most five, and every hop passes the same checks.
 * - The response is read up to a size limit (after decompression), within a time limit that
 *   covers the whole fetch, and only for the content types asked for.
 *
 * Nothing is sent but a GET with a user agent: no cookies, no credentials, no body.
 */

export type UnsafeUrlReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "host"
  | "dns"
  | "address"
  | "redirect"
  | "too_many_redirects"
  | "content_type"
  | "too_large"
  | "timeout"
  | "network";

/** The URL was refused, or the fetch failed. `reason` is safe to store and to show. */
export class UnsafeUrlError extends AppError {
  readonly reason: UnsafeUrlReason;
  constructor(reason: UnsafeUrlReason, message: string, retryable = false) {
    super("validation_failed", message, { retryable, details: { reason } });
    this.reason = reason;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface SafeFetchOptions {
  /** Most bytes of body to accept, after decompression. Default 2 MB. */
  readonly maxBytes?: number;
  /** Time for the whole fetch, redirects included. Default 15 s. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Content types to accept, by prefix. Default: HTML, XHTML and plain text. */
  readonly accept?: readonly string[];
}

export interface SafeResponse {
  /** The URL the body came from, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The body as UTF-8 text. */
  text(): string;
  /** The URLs that redirected, in order. */
  readonly redirects: readonly string[];
}

export interface SafeFetcher {
  fetch(url: string, options?: SafeFetchOptions): Promise<SafeResponse>;
}

/** One HTTP exchange with a fixed address. Replaced in tests that need no sockets. */
export type Transport = (request: {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly accept: readonly string[];
  readonly signal: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

export interface SafeFetcherDeps {
  /** DNS. Default: the system resolver, every address of the name. */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /**
   * Which addresses may be connected to. Default `isPublicAddress`. Tests widen it to reach
   * a server on the loopback interface; product code never passes it.
   */
  readonly isAllowedAddress?: (address: string) => boolean;
  /** Ports besides the scheme's default. Default none. Tests pass their server's port. */
  readonly extraPorts?: readonly number[];
  readonly transport?: Transport;
  readonly userAgent?: string;
}

export const CRAWLER_USER_AGENT =
  "HomeServicesReplyBot/1.0 (business knowledge import; contact: the agency that operates this site's chat)";

const DEFAULT_ACCEPT = ["text/html", "application/xhtml+xml", "text/plain"] as const;
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
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function refuse(reason: UnsafeUrlReason, message: string): never {
  throw new UnsafeUrlError(reason, message);
}

const timedOut = () => new UnsafeUrlError("timeout", "The website took too long to answer.", true);

/**
 * `promise`, or a timeout error as soon as `signal` aborts. A DNS lookup cannot be cancelled,
 * so without this a resolver that never answers would hold the fetch past its time limit.
 */
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

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/** The default transport: `node:http(s)` with the socket's DNS lookup pinned to one address. */
const nodeTransport: Transport = ({ url, address, headers, maxBytes, accept, signal }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...headers, host: url.host },
      // No pooling: every request gets its own socket, connected to the checked address.
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
      const status = response.statusCode ?? 0;
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const done = (body: Uint8Array) => resolve({ status, headers: flat, body });
      // A redirect or an error status has no body worth reading.
      if (REDIRECTS.has(status) || status < 200 || status >= 300) {
        response.destroy();
        done(new Uint8Array());
        return;
      }
      const type = (flat["content-type"] ?? "").toLowerCase();
      if (!accept.some((prefix) => type.startsWith(prefix))) {
        response.destroy();
        reject(
          new UnsafeUrlError("content_type", "The address does not return a web page or text."),
        );
        return;
      }
      const encoding = (flat["content-encoding"] ?? "").toLowerCase().trim();
      const decoder =
        encoding === "gzip" || encoding === "x-gzip"
          ? createGunzip()
          : encoding === "deflate"
            ? createInflate()
            : encoding === "br"
              ? createBrotliDecompress()
              : null;
      if (decoder === null && encoding.length > 0 && encoding !== "identity") {
        response.destroy();
        reject(new UnsafeUrlError("network", "The page uses a compression that is not supported."));
        return;
      }
      const stream = decoder === null ? response : response.pipe(decoder);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          decoder?.destroy();
          reject(new UnsafeUrlError("too_large", "The page is larger than the size limit."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => done(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", (error) => reject(error));
      response.on("error", (error) => reject(error));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });

export function createSafeFetcher(deps: SafeFetcherDeps = {}): SafeFetcher {
  const resolve = deps.resolve ?? systemResolve;
  const isAllowed = deps.isAllowedAddress ?? isPublicAddress;
  const transport = deps.transport ?? nodeTransport;
  const userAgent = deps.userAgent ?? CRAWLER_USER_AGENT;
  const extraPorts = new Set(deps.extraPorts ?? []);

  /** Everything that can be decided from the URL alone. */
  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refuse("invalid_url", "That is not a web address.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return refuse("scheme", "Only http and https addresses can be read.");
    }
    // A fragment is never sent to a server.
    url.hash = "";
    if (url.username.length > 0 || url.password.length > 0) {
      return refuse("credentials", "An address with a user name or password in it is not read.");
    }
    if (url.port.length > 0 && !extraPorts.has(Number(url.port))) {
      return refuse("port", "Only the standard web ports are read.");
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.length === 0) return refuse("host", "The address has no host name.");
    if (isIpLiteral(host)) {
      if (!isAllowed(host)) return refuse("address", "That address is not on the public internet.");
      return url;
    }
    if (
      !host.includes(".") ||
      host === "localhost" ||
      PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ) {
      return refuse("host", "That host name is not a public website.");
    }
    return url;
  }

  /** Resolves the host and returns the one address the connection will be made to. */
  async function checkAddress(url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIpLiteral(host)) return { address: host, family: host.includes(":") ? 6 : 4 };
    let addresses: readonly ResolvedAddress[];
    try {
      // The lookup counts towards the time limit of the whole fetch.
      addresses = await untilAborted(resolve(host), signal);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error;
      throw new UnsafeUrlError("dns", "The website's name could not be found.", true);
    }
    if (addresses.length === 0) {
      throw new UnsafeUrlError("dns", "The website's name could not be found.", true);
    }
    // All of them, not just the one that would be used: a name that also points inside is
    // not a name to trust.
    if (!addresses.every((entry) => isAllowed(entry.address))) {
      return refuse("address", "The website's name points at an address that is not public.");
    }
    const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    if (chosen === undefined) {
      throw new UnsafeUrlError("dns", "The website's name could not be found.", true);
    }
    return chosen;
  }

  return {
    async fetch(raw, options = {}) {
      const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
      const maxRedirects = options.maxRedirects ?? 5;
      const accept = options.accept ?? DEFAULT_ACCEPT;
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const redirects: string[] = [];
      let current = raw;
      for (;;) {
        // The first URL is refused as itself; a later one as a redirect.
        let url: URL;
        let address: ResolvedAddress;
        try {
          url = checkUrl(current);
          address = await checkAddress(url, signal);
        } catch (error) {
          if (redirects.length > 0 && error instanceof UnsafeUrlError && !error.retryable) {
            throw new UnsafeUrlError(
              "redirect",
              "The website redirects to an address that cannot be read.",
            );
          }
          throw error;
        }
        let response: Awaited<ReturnType<Transport>>;
        try {
          response = await transport({
            url,
            address,
            headers: {
              "user-agent": userAgent,
              accept: `${accept.join(", ")};q=0.9, */*;q=0.1`,
              "accept-language": "en-US,en;q=0.8",
              "accept-encoding": "gzip, deflate, br",
            },
            maxBytes,
            accept,
            signal,
          });
        } catch (error) {
          if (error instanceof UnsafeUrlError) throw error;
          if (signal.aborted) {
            throw new UnsafeUrlError("timeout", "The website took too long to answer.", true);
          }
          throw new UnsafeUrlError("network", "The website could not be reached.", true);
        }
        if (REDIRECTS.has(response.status)) {
          const location = response.headers["location"];
          if (location === undefined || location.length === 0) {
            return refuse("redirect", "The website redirects without saying where to.");
          }
          if (redirects.length >= maxRedirects) {
            return refuse("too_many_redirects", "The website redirects too many times.");
          }
          redirects.push(url.toString());
          try {
            current = new URL(location, url).toString();
          } catch {
            return refuse("redirect", "The website redirects to something that is not an address.");
          }
          continue;
        }
        const body = response.body;
        return {
          url: url.toString(),
          status: response.status,
          contentType: response.headers["content-type"] ?? null,
          headers: response.headers,
          body,
          text: () => new TextDecoder("utf-8").decode(body),
          redirects,
        };
      }
    },
  };
}
