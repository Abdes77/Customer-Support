import { scrubText, scrubValue } from "./scrub";

/**
 * A small Sentry client (C17): events go to Sentry's envelope endpoint as JSON, through an
 * injected transport, after scrubbing. No SDK: what leaves the process is exactly what this
 * file builds, which is the point of the scrubbing rules, and the tests read every envelope
 * through a fake transport (`@repo/observability/testing`). Off without `SENTRY_DSN`.
 *
 * Envelope format: one header line `{event_id, sent_at, dsn}`, one item header
 * `{type: "event"}`, then the event JSON; POSTed to
 * `<scheme>://<host><path>/api/<project>/envelope/` with `X-Sentry-Auth` carrying the public
 * key (Sentry's documented "envelope" and "store" protocols; unverified against a live
 * project, HUMAN_TODO 19).
 */

export interface SentryDsn {
  readonly raw: string;
  readonly publicKey: string;
  readonly projectId: string;
  readonly envelopeUrl: string;
}

/** Parses `https://<public key>@<host>[/<path>]/<project id>`, or null when it is not one. */
export function parseDsn(dsn: string): SentryDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const publicKey = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const projectId = segments.pop();
  if (publicKey.length === 0 || projectId === undefined || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length === 0 ? "" : `/${segments.join("/")}`;
  return {
    raw: dsn,
    publicKey,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

export interface SentryRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Sends one envelope. Failures are swallowed by the client (reporting never breaks a request). */
export type SentryTransport = (request: SentryRequest) => Promise<void>;

/** The transport for a deployment: `fetch`, with a timeout. */
export function fetchTransport(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
  timeoutMs = 5000,
): SentryTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The answer is not needed; drain it so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
  };
}

export type SentryLevel = "fatal" | "error" | "warning" | "info";

export interface CaptureContext {
  readonly level?: SentryLevel;
  /** Short, indexed values: ids and classifications only. */
  readonly tags?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** Anything else worth reading; scrubbed like everything else. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Our trace id (a UUID), linking the event to logs, model calls and sends. */
  readonly traceId?: string | null;
  /** Groups events that are the same problem (default: Sentry's own grouping). */
  readonly fingerprint?: readonly string[];
}

export interface SentryClient {
  /** Queues the error for sending and returns the event id, or null when it was dropped. */
  captureException(error: unknown, context?: CaptureContext): string | null;
  captureMessage(message: string, context?: CaptureContext): string | null;
  /** Waits for queued events (at most `timeoutMs`). */
  flush(timeoutMs?: number): Promise<void>;
  /** Events dropped by the per-minute cap or a failing transport, for the readiness check. */
  stats(): { readonly sent: number; readonly dropped: number; readonly failed: number };
}

export interface SentryClientOptions {
  readonly dsn: string;
  readonly transport: SentryTransport;
  readonly environment?: string;
  readonly release?: string | null;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  /** At most this many events a minute leave the process (a flood must not cost the quota). */
  readonly maxEventsPerMinute?: number;
}

interface ExceptionValue {
  readonly type: string;
  readonly value: string;
  readonly stacktrace?: { readonly frames: readonly StackFrame[] };
}

interface StackFrame {
  readonly function?: string;
  readonly filename: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app: boolean;
}

const SDK = { name: "hsrb.observability", version: "1.0.0" } as const;

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/** V8 stack lines as Sentry frames, oldest call first (Sentry's order). */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (stack === undefined) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n").slice(1, 60)) {
    const match = V8_FRAME.exec(line);
    if (match === null) continue;
    const filename = match[2] ?? "";
    frames.push({
      ...(match[1] === undefined ? {} : { function: match[1].slice(0, 200) }),
      filename: filename.slice(0, 300),
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
  readonly code?: unknown;
  readonly cause?: unknown;
}

function exceptionValues(error: unknown): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== "object") {
      const text =
        typeof current === "string" || typeof current === "number" || typeof current === "boolean"
          ? String(current)
          : typeof current;
      values.push({ type: "Error", value: scrubText(text) });
      break;
    }
    const like = current as ErrorLike;
    const type = typeof like.name === "string" && like.name.length > 0 ? like.name : "Error";
    const message = typeof like.message === "string" ? like.message : "";
    const code = typeof like.code === "string" ? ` [${like.code}]` : "";
    const frames = parseStack(typeof like.stack === "string" ? like.stack : undefined);
    values.push({
      type: type.slice(0, 100),
      value: scrubText(`${message}${code}`),
      ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
    });
    current = like.cause;
  }
  // Sentry lists the outermost exception last.
  return values.reverse();
}

function cleanTags(tags: CaptureContext["tags"]): Record<string, string> | undefined {
  if (tags === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    out[key.slice(0, 32)] = scrubText(String(value)).slice(0, 200);
  }
  return out;
}

export function createSentryClient(options: SentryClientOptions): SentryClient | null {
  const parsed = parseDsn(options.dsn);
  if (parsed === null) return null;
  const dsn: SentryDsn = parsed;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomHex;
  const cap = options.maxEventsPerMinute ?? 30;
  const pending = new Set<Promise<void>>();
  const counters = { sent: 0, dropped: 0, failed: 0 };
  let minute = -1;
  let inMinute = 0;

  function admit(): boolean {
    const current = Math.floor(now().getTime() / 60_000);
    if (current !== minute) {
      minute = current;
      inMinute = 0;
    }
    if (inMinute >= cap) {
      counters.dropped += 1;
      return false;
    }
    inMinute += 1;
    return true;
  }

  function send(event: Record<string, unknown>): string | null {
    if (!admit()) return null;
    const eventId = randomId();
    const sentAt = now();
    const payload = {
      ...event,
      event_id: eventId,
      timestamp: sentAt.getTime() / 1000,
      platform: "node",
      sdk: SDK,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.release === undefined || options.release === null
        ? {}
        : { release: options.release }),
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: sentAt.toISOString(), dsn: dsn.raw }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(payload),
    ].join("\n");
    const request: SentryRequest = {
      url: dsn.envelopeUrl,
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=${SDK.name}/${SDK.version}, sentry_key=${dsn.publicKey}`,
      },
      body,
    };
    const delivery = options
      .transport(request)
      .then(() => {
        counters.sent += 1;
      })
      .catch(() => {
        counters.failed += 1;
      })
      .finally(() => {
        pending.delete(delivery);
      });
    pending.add(delivery);
    return eventId;
  }

  function common(context: CaptureContext | undefined): Record<string, unknown> {
    const tags = cleanTags(context?.tags);
    const extra =
      context?.extra === undefined
        ? undefined
        : (scrubValue(context.extra) as Record<string, unknown>);
    const traceId = context?.traceId?.replaceAll("-", "").toLowerCase();
    return {
      level: context?.level ?? "error",
      ...(tags === undefined ? {} : { tags }),
      ...(extra === undefined ? {} : { extra }),
      ...(traceId !== undefined && /^[0-9a-f]{32}$/.test(traceId)
        ? { contexts: { trace: { trace_id: traceId, span_id: traceId.slice(0, 16) } } }
        : {}),
      ...(context?.fingerprint === undefined ? {} : { fingerprint: [...context.fingerprint] }),
    };
  }

  return {
    captureException(error, context) {
      return send({ ...common(context), exception: { values: exceptionValues(error) } });
    },
    captureMessage(message, context) {
      return send({ ...common(context), message: { formatted: scrubText(message) } });
    },
    async flush(timeoutMs = 2000) {
      if (pending.size === 0) return;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
    stats: () => ({ ...counters }),
  };
}
