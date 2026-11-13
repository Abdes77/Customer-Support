import { afterEach, describe, expect, it } from "vitest";

import { logger } from "@repo/core";
import { createFakeSentryTransport } from "@repo/observability/testing";

import {
  errorReportingEnabled,
  reportRequestError,
  startErrorReporting,
  stopErrorReporting,
} from "./observability";

afterEach(() => {
  stopErrorReporting();
});

describe("error reporting (C17)", () => {
  it("stays off without a DSN: nothing leaves the process", () => {
    expect(startErrorReporting({ dsn: undefined as never })).toBeNull();
  });

  it("reports error logs and request errors, scrubbed, through the deployment's transport", async () => {
    const fake = createFakeSentryTransport();
    const client = startErrorReporting({
      dsn: "https://publickey@o1.ingest.sentry.io/42",
      transport: fake.transport,
    });
    expect(client).not.toBeNull();
    expect(errorReportingEnabled()).toBe(true);

    logger.error("turn.failed", {
      businessId: "7d0c3f2e-1b2a-4c5d-8e9f-0a1b2c3d4e5f",
      error: new Error("model said: call me at 303-555-0142"),
      text: "my basement is flooding",
    });
    reportRequestError(
      new Error("boom for jane@example.com"),
      {
        path: "/api/handoff/ack/3f1c9a8e-2b7d-4e6f-9a1b-2c3d4e5f6a7b.Xk9Lm2Np4Qr6St8Uv0Wx2Yz4?x=1",
        method: "POST",
      },
      { routePath: "/api/handoff/ack/[token]", routeType: "route" },
    );
    await client!.flush();
    expect(fake.envelopes.map((item) => item.event["tags"])).toEqual([
      expect.objectContaining({ event: "turn.failed" }),
      expect.objectContaining({
        event: "request.failed",
        route: "/api/handoff/ack/[token]",
        method: "POST",
      }),
    ]);
    const raw = fake.raw();
    for (const leak of [
      "303-555-0142",
      "flooding",
      "jane@example.com",
      "Xk9Lm2Np4Qr6St8Uv0Wx2Yz4",
    ]) {
      expect(raw).not.toContain(leak);
    }
  });
});
