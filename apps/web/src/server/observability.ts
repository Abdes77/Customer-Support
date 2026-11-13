import { logger } from "@repo/core";
import { deploymentInfo, getEnv } from "@repo/core/env";
import {
  createSentryClient,
  fetchTransport,
  installErrorReporting,
  type SentryClient,
  type SentryTransport,
  scrubPath,
} from "@repo/observability";

/**
 * Error reporting for this process (C17): with `SENTRY_DSN` set, every error-level log line
 * (from any package) and every request error Next.js reports (`instrumentation.ts`) goes to
 * Sentry, scrubbed of message text, contact details and tokens; without it nothing leaves the
 * process. Started once per process.
 */

interface Reporting {
  readonly client: SentryClient;
  readonly stop: () => void;
}

const SHARED = Symbol.for("@repo/web/error-reporting");
const holder = globalThis as { [SHARED]?: Reporting | null };

export function startErrorReporting(
  options: { readonly transport?: SentryTransport; readonly dsn?: string } = {},
): SentryClient | null {
  const existing = holder[SHARED];
  if (existing !== undefined) return existing?.client ?? null;
  const dsn = options.dsn ?? getEnv().SENTRY_DSN;
  if (dsn === undefined) {
    holder[SHARED] = null;
    return null;
  }
  const deployment = deploymentInfo();
  const client = createSentryClient({
    dsn,
    transport: options.transport ?? fetchTransport(),
    environment: deployment.environment,
    release: deployment.commitSha,
  });
  if (client === null) {
    logger.warn("sentry.invalid_dsn");
    holder[SHARED] = null;
    return null;
  }
  holder[SHARED] = { client, stop: installErrorReporting(client) };
  return client;
}

/** Stops reporting and forgets the client (tests). */
export function stopErrorReporting(): void {
  holder[SHARED]?.stop();
  delete holder[SHARED];
}

export function errorReportingEnabled(): boolean {
  return (holder[SHARED] ?? startErrorReporting()) !== null;
}

/**
 * A request error from Next.js (`onRequestError`): reported with the route's pattern and
 * method, never the URL's capabilities (an acknowledgement link, a webhook key) or a query.
 */
export function reportRequestError(
  error: unknown,
  request: { readonly path: string; readonly method: string },
  context: { readonly routePath?: string; readonly routeType?: string },
): string | null {
  const client = holder[SHARED]?.client ?? startErrorReporting();
  if (client === null) return null;
  return client.captureException(error, {
    tags: {
      event: "request.failed",
      route: context.routePath ?? scrubPath(request.path),
      method: request.method,
      routeType: context.routeType ?? null,
    },
    extra: { path: scrubPath(request.path) },
  });
}
