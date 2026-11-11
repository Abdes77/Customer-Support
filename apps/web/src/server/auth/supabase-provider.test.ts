import { describe, expect, it, vi } from "vitest";

import { MemoryCookieJar } from "./cookies";
import { createSupabaseAuthProvider, type SupabaseAuthClient } from "./supabase-provider";

const user = { id: "5b8f1c1e-7a44-4d0a-9d6c-3f2a1b0c9d8e", email: "pat@example.com" };
const success = { data: { user }, error: null };
const noUser = { data: { user: null }, error: null };
const failure = (status?: number) => ({ data: { user: null }, error: { status } });

function providerWith(overrides: Partial<SupabaseAuthClient>) {
  const client: SupabaseAuthClient = {
    signInWithPassword: vi.fn().mockResolvedValue(success),
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    exchangeCodeForSession: vi.fn().mockResolvedValue(success),
    verifyOtp: vi.fn().mockResolvedValue(success),
    getClaims: vi
      .fn()
      .mockResolvedValue({ data: { claims: { sub: user.id, email: user.email } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };
  const provider = createSupabaseAuthProvider({
    jar: new MemoryCookieJar(),
    url: "https://project.supabase.co",
    anonKey: "anon",
    client,
  });
  return { provider, client };
}

describe("Supabase auth provider", () => {
  it("signs in with a password", async () => {
    const { provider, client } = providerWith({});
    expect(await provider.signInWithPassword("pat@example.com", "pw")).toEqual({
      ok: true,
      value: user,
    });
    expect(client.signInWithPassword).toHaveBeenCalledWith({
      email: "pat@example.com",
      password: "pw",
    });
  });

  it.each([
    [400, "invalid_credentials"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [undefined, "unavailable"],
  ] as const)("maps a password failure with status %s to %s", async (status, code) => {
    const { provider } = providerWith({
      signInWithPassword: vi.fn().mockResolvedValue(failure(status)),
    });
    expect(await provider.signInWithPassword("pat@example.com", "pw")).toEqual({
      ok: false,
      error: { code },
    });
  });

  it("treats a response without a user as a failure", async () => {
    const { provider } = providerWith({ signInWithPassword: vi.fn().mockResolvedValue(noUser) });
    expect(await provider.signInWithPassword("a@b.co", "pw")).toEqual({
      ok: false,
      error: { code: "invalid_credentials" },
    });
  });

  it("asks for a magic link without ever creating a user", async () => {
    const { provider, client } = providerWith({});
    const result = await provider.sendMagicLink("pat@example.com", {
      redirectTo: "https://app.example.com/auth/callback",
    });
    expect(result).toEqual({ ok: true, value: { link: null } });
    expect(client.signInWithOtp).toHaveBeenCalledWith({
      email: "pat@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://app.example.com/auth/callback",
      },
    });
  });

  it("answers the same for an unknown address, but reports rate limits and outages", async () => {
    const unknown = providerWith({
      signInWithOtp: vi.fn().mockResolvedValue({ error: { status: 422 } }),
    });
    expect(
      await unknown.provider.sendMagicLink("nobody@example.com", { redirectTo: "https://x" }),
    ).toEqual({
      ok: true,
      value: { link: null },
    });
    const limited = providerWith({
      signInWithOtp: vi.fn().mockResolvedValue({ error: { status: 429 } }),
    });
    expect(
      await limited.provider.sendMagicLink("pat@example.com", { redirectTo: "https://x" }),
    ).toEqual({
      ok: false,
      error: { code: "rate_limited" },
    });
    const down = providerWith({
      signInWithOtp: vi.fn().mockResolvedValue({ error: { status: 503 } }),
    });
    expect(
      await down.provider.sendMagicLink("pat@example.com", { redirectTo: "https://x" }),
    ).toEqual({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("exchanges a code and verifies a token hash", async () => {
    const { provider, client } = providerWith({});
    expect(await provider.exchangeCode("code-123")).toEqual({ ok: true, value: user });
    expect(client.exchangeCodeForSession).toHaveBeenCalledWith("code-123");
    expect(await provider.verifyEmailToken("hash", "email")).toEqual({ ok: true, value: user });
    expect(client.verifyOtp).toHaveBeenCalledWith({ token_hash: "hash", type: "email" });
  });

  it("refuses link types it does not know, and maps a bad link", async () => {
    const { provider, client } = providerWith({
      verifyOtp: vi.fn().mockResolvedValue(failure(403)),
    });
    expect(await provider.verifyEmailToken("hash", "sms")).toEqual({
      ok: false,
      error: { code: "link_invalid" },
    });
    expect(client.verifyOtp).not.toHaveBeenCalled();
    expect(await provider.verifyEmailToken("hash", "magiclink")).toEqual({
      ok: false,
      error: { code: "link_invalid" },
    });
  });

  it("establishes the user from verified claims only", async () => {
    expect(await providerWith({}).provider.getUser()).toEqual(user);
    const invalid = providerWith({
      getClaims: vi.fn().mockResolvedValue({ data: null, error: { status: 401 } }),
    });
    expect(await invalid.provider.getUser()).toBeNull();
    const none = providerWith({
      getClaims: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    expect(await none.provider.getUser()).toBeNull();
    const noSubject = providerWith({
      getClaims: vi.fn().mockResolvedValue({ data: { claims: {} }, error: null }),
    });
    expect(await noSubject.provider.getUser()).toBeNull();
  });

  it("refreshes through getClaims and signs out", async () => {
    const { provider, client } = providerWith({});
    await provider.refresh();
    expect(client.getClaims).toHaveBeenCalledTimes(1);
    await provider.signOut();
    expect(client.signOut).toHaveBeenCalledTimes(1);
  });

  it("builds a real client that reads and writes through the cookie jar", async () => {
    // No network: with no session cookie, getClaims() answers locally.
    const jar = new MemoryCookieJar();
    const provider = createSupabaseAuthProvider({
      jar,
      url: "https://project.supabase.co",
      anonKey: "anon",
    });
    expect(provider.mode).toBe("supabase");
    expect(await provider.getUser()).toBeNull();
  });
});
