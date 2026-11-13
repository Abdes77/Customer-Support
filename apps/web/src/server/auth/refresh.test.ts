import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "@repo/core/env";

import {
  createLocalToken,
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_SECONDS,
  signLocalToken,
  verifyLocalToken,
} from "./local-session";
import { createAuthProvider } from "./provider";
import { MemoryCookieJar } from "./cookies";
import { refreshSession } from "./refresh";

const SECRET = "refresh-test-secret-".repeat(2);
const user = { id: "5b8f1c1e-7a44-4d0a-9d6c-3f2a1b0c9d8e", email: "pat@example.com" };
const VARIABLES = [
  "LOCAL_AUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "APP_URL",
  "VERCEL_ENV",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  resetEnvCache();
});

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetEnvCache();
});

const requestWith = (cookie?: string) =>
  new NextRequest("http://localhost:3000/admin", {
    headers: cookie === undefined ? {} : { cookie: `${LOCAL_SESSION_COOKIE}=${cookie}` },
  });

const oldToken = (ageSeconds: number) => {
  const issuedAt = Math.floor(Date.now() / 1000) - ageSeconds;
  return signLocalToken(
    {
      sub: user.id,
      email: user.email,
      typ: "session",
      iat: issuedAt,
      exp: issuedAt + LOCAL_SESSION_SECONDS,
    },
    SECRET,
  );
};

describe("refreshSession (proxy)", () => {
  it("passes the request through untouched when no sign-in is configured", async () => {
    const response = await refreshSession(requestWith("anything"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("leaves a fresh local session alone", async () => {
    process.env["LOCAL_AUTH_SECRET"] = SECRET;
    resetEnvCache();
    const response = await refreshSession(
      requestWith(createLocalToken(user, "session", SECRET, new Date())),
    );
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("renews a local session that is past half of its life", async () => {
    process.env["LOCAL_AUTH_SECRET"] = SECRET;
    process.env["APP_URL"] = "https://app.example.com";
    resetEnvCache();
    const response = await refreshSession(requestWith(oldToken(LOCAL_SESSION_SECONDS / 2 + 120)));
    const renewed = response.cookies.get(LOCAL_SESSION_COOKIE);
    expect(renewed).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    const payload = verifyLocalToken(renewed?.value ?? "", SECRET, "session", new Date());
    expect(payload?.sub).toBe(user.id);
    expect(payload?.iat).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it("never turns a forged or expired cookie into a session", async () => {
    process.env["LOCAL_AUTH_SECRET"] = SECRET;
    resetEnvCache();
    for (const cookie of ["forged.value", oldToken(LOCAL_SESSION_SECONDS + 10)]) {
      const response = await refreshSession(requestWith(cookie));
      expect(response.cookies.getAll()).toEqual([]);
    }
  });

  it("does not use the local sign-in on Vercel", async () => {
    process.env["LOCAL_AUTH_SECRET"] = SECRET;
    process.env["VERCEL_ENV"] = "production";
    resetEnvCache();
    const response = await refreshSession(requestWith(oldToken(LOCAL_SESSION_SECONDS / 2 + 120)));
    expect(response.cookies.getAll()).toEqual([]);
    expect(createAuthProvider(new MemoryCookieJar())).toBeNull();
  });

  it("with Supabase configured and no session, lets the request through", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co";
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon";
    resetEnvCache();
    const response = await refreshSession(requestWith());
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(createAuthProvider(new MemoryCookieJar())?.mode).toBe("supabase");
  });
});
