import { describe, expect, it } from "vitest";

import { GET, type HealthResponse } from "./route";

describe("GET /api/health", () => {
  it("answers 200 with a status and a timestamp, and is never cached", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("web");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
