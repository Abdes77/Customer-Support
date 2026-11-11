import { describe, expect, it } from "vitest";

import { isSameOriginRequest, safeNextPath, seeOther, signInUrl } from "./redirects";

describe("safeNextPath", () => {
  it("keeps paths on this site", () => {
    for (const path of ["/", "/admin", "/admin/businesses?tab=leads#top", "/a/b-c_d/123"]) {
      expect(safeNextPath(path)).toBe(path);
    }
  });

  it("falls back to the home page for anything that could leave the site", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "admin",
      "/admin\nSet-Cookie: x=1",
      "/\tadmin",
      `/${"a".repeat(600)}`,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBe("/");
    }
  });

  it("never sends a signed-in user back to the auth endpoints", () => {
    expect(safeNextPath("/sign-in")).toBe("/");
    expect(safeNextPath("/sign-in?next=/x")).toBe("/");
    expect(safeNextPath("/auth/sign-out")).toBe("/");
    expect(safeNextPath("/sign-in-help")).toBe("/sign-in-help");
  });
});

describe("signInUrl", () => {
  it("builds the sign-in path and leaves out empty values and the default destination", () => {
    expect(signInUrl()).toBe("/sign-in");
    expect(signInUrl({ error: "no_access" })).toBe("/sign-in?error=no_access");
    expect(signInUrl({ error: undefined, next: "/" })).toBe("/sign-in");
    expect(signInUrl({ notice: "link_sent", next: "/admin?x=1" })).toBe(
      "/sign-in?notice=link_sent&next=%2Fadmin%3Fx%3D1",
    );
  });
});

describe("isSameOriginRequest", () => {
  const request = (headers: Record<string, string>, url = "https://app.example.com/auth/sign-in") =>
    new Request(url, { method: "POST", headers });

  it("accepts posts from the site itself", () => {
    expect(isSameOriginRequest(request({ origin: "https://app.example.com" }), undefined)).toBe(
      true,
    );
    expect(
      isSameOriginRequest(
        request({ origin: "https://app.example.com", "sec-fetch-site": "same-origin" }),
        undefined,
      ),
    ).toBe(true);
  });

  it("accepts the configured APP_URL and the forwarded host behind a proxy", () => {
    const internal = "http://127.0.0.1:3000/auth/sign-in";
    expect(
      isSameOriginRequest(
        request({ origin: "https://app.example.com" }, internal),
        "https://app.example.com",
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request(
          { origin: "https://app.example.com", "x-forwarded-host": "app.example.com" },
          internal,
        ),
        undefined,
      ),
    ).toBe(true);
  });

  it("rejects posts from other sites", () => {
    expect(
      isSameOriginRequest(request({ origin: "https://evil.example" }), "https://app.example.com"),
    ).toBe(false);
    expect(isSameOriginRequest(request({ origin: "null" }), undefined)).toBe(false);
    expect(isSameOriginRequest(request({ "sec-fetch-site": "cross-site" }), undefined)).toBe(false);
    expect(
      isSameOriginRequest(
        request({ origin: "https://app.example.com", "sec-fetch-site": "same-site" }),
        undefined,
      ),
    ).toBe(false);
    // A look-alike host is not the host.
    expect(
      isSameOriginRequest(request({ origin: "https://app.example.com.evil.example" }), undefined),
    ).toBe(false);
  });

  it("lets through requests that carry neither header (not a browser)", () => {
    expect(isSameOriginRequest(request({}), undefined)).toBe(true);
  });
});

describe("seeOther", () => {
  it("is a 303 to a path", () => {
    const response = seeOther("/sign-in?error=x");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?error=x");
  });
});
