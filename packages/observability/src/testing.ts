import type { SentryRequest, SentryTransport } from "./sentry";

/** One envelope as the fake transport received it, parsed. */
export interface CapturedEnvelope {
  readonly request: SentryRequest;
  readonly header: Record<string, unknown>;
  readonly itemHeader: Record<string, unknown>;
  readonly event: Record<string, unknown>;
}

/**
 * A Sentry transport for tests: records every envelope instead of sending it, and can be
 * made to fail. `raw()` is the exact text that would have left the process.
 */
export function createFakeSentryTransport(options: { readonly fail?: boolean } = {}): {
  readonly transport: SentryTransport;
  readonly envelopes: CapturedEnvelope[];
  raw(): string;
} {
  const envelopes: CapturedEnvelope[] = [];
  return {
    envelopes,
    transport: async (request) => {
      if (options.fail === true) throw new Error("transport down");
      const [header, itemHeader, event] = request.body.split("\n");
      envelopes.push({
        request,
        header: JSON.parse(header ?? "{}") as Record<string, unknown>,
        itemHeader: JSON.parse(itemHeader ?? "{}") as Record<string, unknown>,
        event: JSON.parse(event ?? "{}") as Record<string, unknown>,
      });
    },
    raw: () => envelopes.map((item) => item.request.body).join("\n"),
  };
}
