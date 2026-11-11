import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type LogRecord, ok } from "@repo/core";
import { hasAnyAccess, loadUserAccess } from "@repo/db";
import {
  type CastName,
  createTestDatabase,
  createWorld,
  type TestDatabase,
  type World,
} from "@repo/db/testing";

import { MemoryCookieJar } from "./cookies";
import {
  type AuthFlowContext,
  completeCodeSignIn,
  completeTokenSignIn,
  LOCAL_MAGIC_LINK_COOKIE,
  passwordSignIn,
  requestMagicLink,
  signOut,
} from "./flows";
import { createLocalAuthProvider } from "./local-provider";
import { LOCAL_SESSION_COOKIE } from "./local-session";
import type { AuthProvider } from "./types";

/*
 * The sign-in flows against a real database: the local provider, the membership check under
 * row-level security, and the redirects. (The Supabase provider has its own tests with a
 * stand-in client.)
 */

const SECRET = "flow-test-secret-".repeat(3);
const PASSWORD = "correct horse battery staple";
const APP_URL = "https://app.example.com";

let t: TestDatabase;
let world: World;
let logs: LogRecord[];

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  for (const name of ["aAdmin", "aMember", "a1Owner", "a1Staff", "a3Owner", "outsider"] as const) {
    await t.db.localAuth.upsertUser({ email: world.users[name].email ?? "", password: PASSWORD });
  }
});

afterAll(async () => {
  await t?.dispose();
});

beforeEach(() => {
  logs = [];
});

function context(
  overrides: Partial<Omit<AuthFlowContext, "jar">> = {},
): AuthFlowContext & { jar: MemoryCookieJar } {
  const jar = new MemoryCookieJar();
  return {
    jar,
    provider: createLocalAuthProvider({ jar, secret: SECRET, secure: true, store: t.db.localAuth }),
    appUrl: APP_URL,
    hasAccess: async (user) =>
      hasAnyAccess(await t.db.asUser(user).run((ctx) => loadUserAccess(ctx))),
    logger: createLogger({ level: "debug", sink: (record) => logs.push(record) }),
    ...overrides,
  };
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}${path}`, {
    method: "POST",
    headers: { origin: APP_URL, ...headers },
    body: new URLSearchParams(fields),
  });
}

const emailOf = (name: CastName) => world.users[name].email ?? "";
const location = (response: Response) => response.headers.get("location");

describe("password sign-in", () => {
  it("signs an agency admin in and goes where they were heading", async () => {
    const ctx = context();
    const response = await passwordSignIn(
      post("/auth/sign-in", {
        email: emailOf("aAdmin"),
        password: PASSWORD,
        next: "/admin/businesses",
      }),
      ctx,
    );
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/admin/businesses");
    expect(ctx.jar.cookies.get(LOCAL_SESSION_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    expect(await ctx.provider?.getUser()).toEqual(world.users.aAdmin);
  });

  it("accepts the email in any case and with stray spaces", async () => {
    const ctx = context();
    const response = await passwordSignIn(
      post("/auth/sign-in", {
        email: `  ${emailOf("aMember").toUpperCase()} `,
        password: PASSWORD,
      }),
      ctx,
    );
    expect(location(response)).toBe("/");
    expect((await ctx.provider?.getUser())?.id).toBe(world.users.aMember.id);
  });

  it("lets client users in when logins are enabled for their business", async () => {
    for (const name of ["a1Owner", "a1Staff"] as const) {
      const ctx = context();
      const response = await passwordSignIn(
        post("/auth/sign-in", { email: emailOf(name), password: PASSWORD }),
        ctx,
      );
      expect(location(response), name).toBe("/");
      expect((await ctx.provider?.getUser())?.id).toBe(world.users[name].id);
    }
  });

  it.each([
    ["a wrong password", { password: "wrong" }],
    ["an unknown address", { email: "nobody@world.test" }],
    ["an empty password", { password: "" }],
    ["something that is not an address", { email: "not-an-email" }],
  ])("refuses %s with the same message and no session", async (_label, change) => {
    const ctx = context();
    const response = await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD, ...change }),
      ctx,
    );
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/sign-in?error=invalid_credentials");
    expect(ctx.jar.get(LOCAL_SESSION_COOKIE)).toBeUndefined();
  });

  it("refuses a request without a form body", async () => {
    const ctx = context();
    const response = await passwordSignIn(
      new Request(`${APP_URL}/auth/sign-in`, { method: "POST", headers: { origin: APP_URL } }),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=invalid_credentials");
  });

  it("signs out again a user who is a member of nothing", async () => {
    const ctx = context();
    const response = await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("outsider"), password: PASSWORD, next: "/admin" }),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=no_access");
    expect(await ctx.provider?.getUser()).toBeNull();
  });

  it("signs out again a client user whose business has logins switched off", async () => {
    const ctx = context();
    const response = await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("a3Owner"), password: PASSWORD }),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=no_access");
    expect(await ctx.provider?.getUser()).toBeNull();
  });

  it.each(["https://evil.example/", "//evil.example", "/\\evil.example", "/auth/sign-out"])(
    "never redirects off the site (next=%s)",
    async (next) => {
      const ctx = context();
      const response = await passwordSignIn(
        post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD, next }),
        ctx,
      );
      expect(location(response)).toBe("/");
    },
  );

  it("keeps the destination through a failed attempt", async () => {
    const response = await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: "wrong", next: "/admin/leads" }),
      context(),
    );
    expect(location(response)).toBe("/sign-in?error=invalid_credentials&next=%2Fadmin%2Fleads");
  });

  it("refuses a form posted from another site before looking at it", async () => {
    const provider = { signInWithPassword: vi.fn() } as unknown as AuthProvider;
    const ctx = context({ provider });
    const response = await passwordSignIn(
      post(
        "/auth/sign-in",
        { email: emailOf("aAdmin"), password: PASSWORD },
        { origin: "https://evil.example" },
      ),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=forbidden_origin");
    expect(provider.signInWithPassword).not.toHaveBeenCalled();
  });

  it("says so when no sign-in is configured", async () => {
    const response = await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD }),
      context({ provider: null }),
    );
    expect(location(response)).toBe("/sign-in?error=not_configured");
  });

  it("logs outcomes with ids only: no address, no password", async () => {
    const ctx = context();
    await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD }),
      ctx,
    );
    await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: "wrong-pw" }),
      ctx,
    );
    const text = JSON.stringify(logs);
    expect(logs.map((record) => record.msg)).toEqual(["auth.sign_in", "auth.sign_in.failed"]);
    expect(logs[0]).toMatchObject({
      userId: world.users.aAdmin.id,
      method: "password",
      provider: "local",
    });
    expect(text).not.toContain(emailOf("aAdmin"));
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("wrong-pw");
  });
});

describe("magic link", () => {
  it("hands the link to the page in local mode and signs in when it is opened", async () => {
    const ctx = context();
    const asked = await requestMagicLink(
      post("/auth/magic-link", { email: emailOf("a1Owner"), next: "/portal" }),
      ctx,
    );
    expect(location(asked)).toBe("/sign-in?notice=link_sent&next=%2Fportal");
    const link = ctx.jar.get(LOCAL_MAGIC_LINK_COOKIE);
    expect(link).toMatch(
      /^https:\/\/app\.example\.com\/auth\/confirm\?next=%2Fportal&token_hash=.+&type=magiclink$/,
    );
    expect(ctx.jar.cookies.get(LOCAL_MAGIC_LINK_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      path: "/sign-in",
    });
    expect(await ctx.provider?.getUser()).toBeNull();

    const opened = await completeTokenSignIn(new Request(link ?? ""), ctx);
    expect(location(opened)).toBe("/portal");
    expect((await ctx.provider?.getUser())?.id).toBe(world.users.a1Owner.id);
    expect(ctx.jar.get(LOCAL_MAGIC_LINK_COOKIE)).toBeUndefined();
  });

  it("answers the same for an address without an account, and sends nothing", async () => {
    const ctx = context();
    const response = await requestMagicLink(
      post("/auth/magic-link", { email: "nobody@world.test" }),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?notice=link_sent");
    expect(ctx.jar.get(LOCAL_MAGIC_LINK_COOKIE)).toBeUndefined();
  });

  it("asks for an address when none was given", async () => {
    const response = await requestMagicLink(post("/auth/magic-link", { email: "nope" }), context());
    expect(location(response)).toBe("/sign-in?error=invalid_email");
  });

  it("points Supabase's email at /auth/callback on the public origin", async () => {
    const sendMagicLink = vi.fn().mockResolvedValue(ok({ link: null }));
    const provider = { mode: "supabase", sendMagicLink } as unknown as AuthProvider;
    await requestMagicLink(
      // The request reaches the app on an internal address; the email must not.
      new Request("http://10.0.0.5:3000/auth/magic-link", {
        method: "POST",
        headers: { origin: APP_URL },
        body: new URLSearchParams({ email: "pat@example.com", next: "/admin" }),
      }),
      context({ provider }),
    );
    expect(sendMagicLink).toHaveBeenCalledWith("pat@example.com", {
      redirectTo: "https://app.example.com/auth/callback?next=%2Fadmin",
    });
  });

  it.each([
    ["no token", "/auth/confirm?type=magiclink"],
    ["garbage", "/auth/confirm?token_hash=abc.def&type=magiclink"],
    ["a wrong type", "/auth/confirm?token_hash=abc.def&type=sms"],
  ])("refuses a link with %s", async (_label, path) => {
    const ctx = context();
    const response = await completeTokenSignIn(new Request(`${APP_URL}${path}`), ctx);
    expect(location(response)).toBe("/sign-in?error=link_invalid");
    expect(await ctx.provider?.getUser()).toBeNull();
  });

  it("does not accept a session token as a sign-in link", async () => {
    const signedIn = context();
    await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD }),
      signedIn,
    );
    const sessionToken = signedIn.jar.get(LOCAL_SESSION_COOKIE) ?? "";
    const ctx = context();
    const response = await completeTokenSignIn(
      new Request(
        `${APP_URL}/auth/confirm?token_hash=${encodeURIComponent(sessionToken)}&type=magiclink`,
      ),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=link_invalid");
  });

  it("refuses a link for a user who has no access", async () => {
    const ctx = context();
    await requestMagicLink(post("/auth/magic-link", { email: emailOf("outsider") }), ctx);
    const response = await completeTokenSignIn(
      new Request(ctx.jar.get(LOCAL_MAGIC_LINK_COOKIE) ?? ""),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=no_access");
    expect(await ctx.provider?.getUser()).toBeNull();
  });

  it("the code callback rejects a missing code, and the local provider has no code flow", async () => {
    const ctx = context();
    expect(location(await completeCodeSignIn(new Request(`${APP_URL}/auth/callback`), ctx))).toBe(
      "/sign-in?error=link_invalid",
    );
    expect(
      location(
        await completeCodeSignIn(new Request(`${APP_URL}/auth/callback?code=abc&next=/admin`), ctx),
      ),
    ).toBe("/sign-in?error=link_invalid&next=%2Fadmin");
  });

  it("the code callback signs in through a provider that supports it", async () => {
    const provider = {
      mode: "supabase",
      exchangeCode: vi.fn().mockResolvedValue(ok(world.users.aMember)),
      signOut: vi.fn(),
    } as unknown as AuthProvider;
    const response = await completeCodeSignIn(
      new Request(`${APP_URL}/auth/callback?code=pkce-code&next=/admin/inbox`),
      context({ provider }),
    );
    expect(provider.exchangeCode).toHaveBeenCalledWith("pkce-code");
    expect(location(response)).toBe("/admin/inbox");
  });
});

describe("sign-out", () => {
  it("ends the session", async () => {
    const ctx = context();
    await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD }),
      ctx,
    );
    expect(await ctx.provider?.getUser()).not.toBeNull();

    const response = await signOut(post("/auth/sign-out", {}), ctx);
    expect(location(response)).toBe("/sign-in?notice=signed_out");
    expect(await ctx.provider?.getUser()).toBeNull();
    expect(ctx.jar.cookies.get(LOCAL_SESSION_COOKIE)?.options.maxAge).toBe(0);
  });

  it("cannot be triggered from another site", async () => {
    const ctx = context();
    await passwordSignIn(
      post("/auth/sign-in", { email: emailOf("aAdmin"), password: PASSWORD }),
      ctx,
    );
    const response = await signOut(
      post("/auth/sign-out", {}, { origin: "https://evil.example" }),
      ctx,
    );
    expect(location(response)).toBe("/sign-in?error=forbidden_origin");
    expect(await ctx.provider?.getUser()).not.toBeNull();
  });

  it("is harmless when nobody is signed in or nothing is configured", async () => {
    expect(location(await signOut(post("/auth/sign-out", {}), context()))).toBe(
      "/sign-in?notice=signed_out",
    );
    expect(location(await signOut(post("/auth/sign-out", {}), context({ provider: null })))).toBe(
      "/sign-in?notice=signed_out",
    );
  });
});
