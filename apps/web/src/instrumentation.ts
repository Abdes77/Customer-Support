import { nextRuntime } from "./env.public";

/**
 * Next.js instrumentation (C17): starts error reporting when the Node.js server starts, and
 * reports the errors Next.js catches in route handlers, server components and actions.
 * Both do nothing without `SENTRY_DSN`. The edge runtime runs only the session refresh
 * (`proxy.ts`) and reports nothing.
 */
export async function register(): Promise<void> {
  if (nextRuntime !== "nodejs") return;
  const { startErrorReporting } = await import("./server/observability");
  startErrorReporting();
}

export async function onRequestError(
  error: unknown,
  request: { readonly path: string; readonly method: string },
  context: { readonly routePath?: string; readonly routeType?: string },
): Promise<void> {
  if (nextRuntime !== "nodejs") return;
  const { reportRequestError } = await import("./server/observability");
  reportRequestError(error, request, context);
}
