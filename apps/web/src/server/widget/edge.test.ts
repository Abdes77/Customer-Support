import { describe, expect, it } from "vitest";

import type { WidgetService } from "@repo/channel-widget/server";

import { clientIp, EDGE_LIMITS } from "./http";
import { configHandler, sessionHandler } from "./routes";

const API = "https://app.example.com/api/widget/v1";

describe("the visitor's address behind proxies (C17)", () => {
  const at = (headers: Record<string, string>, options?: Parameters<typeof clientIp>[1]) =>
    clientIp(new Request(`${API}/session`, { headers }), options);

  it("takes the entry the trusted proxies added, never one the client chose", () => {
    const chain = { "x-forwarded-for": "6.6.6.6, 198.51.100.9, 203.0.113.5" };
    // Vercel alone: the last entry is the client as Vercel saw it.
    expect(at(chain, { trustedHops: 1 })).toBe("203.0.113.5");
    // A CDN in front of Vercel: the CDN's address is last, the client one to its left.
    expect(at(chain, { trustedHops: 2 })).toBe("198.51.100.9");
    // Fewer entries than hops: the nearest one, never further left than the chain goes.
    expect(at({ "x-forwarded-for": "198.51.100.9" }, { trustedHops: 3 })).toBe("198.51.100.9");
  });

  it("prefers the edge's own client header when one is configured", () => {
    const headers = { "cf-connecting-ip": "192.0.2.44", "x-forwarded-for": "6.6.6.6, 10.0.0.1" };
    expect(at(headers, { header: "cf-connecting-ip", trustedHops: 1 })).toBe("192.0.2.44");
    // Not configured: a header any client can send is ignored.
    expect(at(headers, { trustedHops: 1 })).toBe("10.0.0.1");
  });
});

describe("per-address limits before the database (C17)", () => {
  function fakeWidget() {
    const calls = { config: 0, session: 0 };
    const widget = {
      async config() {
        calls.config += 1;
        return { ok: true, value: {} };
      },
      async startSession() {
        calls.session += 1;
        return { ok: true, value: {} };
      },
    } as unknown as WidgetService;
    return { widget, calls };
  }

  it("answers 429 once one address has made too many config or session calls", async () => {
    const { widget, calls } = fakeWidget();
    const config = configHandler(() => widget);
    const session = sessionHandler(() => widget);
    const from = (ip: string, path: string, init: RequestInit = {}) =>
      new Request(`${API}${path}`, {
        ...init,
        headers: { origin: "https://site.test", "x-forwarded-for": ip, ...init.headers },
      });

    const statuses: number[] = [];
    for (let index = 0; index <= EDGE_LIMITS.config.limit; index += 1) {
      statuses.push((await config(from("198.51.100.77", "/config?key=wpk_x"))).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(EDGE_LIMITS.config.limit);
    const refused = await config(from("198.51.100.77", "/config?key=wpk_x"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // The service (and the database behind it) never saw the refused calls.
    expect(calls.config).toBe(EDGE_LIMITS.config.limit);
    // Another address is not affected.
    expect((await config(from("198.51.100.78", "/config?key=wpk_x"))).status).toBe(200);

    for (let index = 0; index < EDGE_LIMITS.session.limit; index += 1) {
      await session(
        from("198.51.100.79", "/session", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const sessionRefused = await session(
      from("198.51.100.79", "/session", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(sessionRefused.status).toBe(429);
    expect(calls.session).toBe(EDGE_LIMITS.session.limit);
  });
});
