import { describe, expect, it, vi } from "vitest";

import type { UserId } from "@repo/core";

import type { Database } from "./database";
import { createSupabaseAuthAdmin } from "./supabase-auth-admin";

function fakeDatabase(existing: { id: UserId; email: string } | null): Database {
  return {
    directory: { findUserByEmail: vi.fn().mockResolvedValue(existing) },
  } as unknown as Database;
}

describe("createSupabaseAuthAdmin", () => {
  const options = { url: "https://project.supabase.co/", serviceRoleKey: "service-role-key" };

  it("returns an existing user without calling Supabase", async () => {
    const fetchMock = vi.fn();
    const admin = createSupabaseAuthAdmin({ ...options, fetch: fetchMock });
    const id = await admin.ensureUser(
      fakeDatabase({ id: "u-1" as UserId, email: "a@example.com" }),
      { email: "a@example.com" },
    );
    expect(id).toBe("u-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a confirmed user through the admin API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: "u-2" }), { status: 200 }));
    const admin = createSupabaseAuthAdmin({ ...options, fetch: fetchMock });
    const id = await admin.ensureUser(fakeDatabase(null), {
      email: "b@example.com",
      password: "a-long-password",
      fullName: "B",
    });
    expect(id).toBe("u-2");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://project.supabase.co/auth/v1/admin/users");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer service-role-key",
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      email: "b@example.com",
      password: "a-long-password",
      email_confirm: true,
      user_metadata: { full_name: "B" },
    });
  });

  it("reports a refusal without echoing the key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 403 }));
    const admin = createSupabaseAuthAdmin({ ...options, fetch: fetchMock });
    await expect(admin.ensureUser(fakeDatabase(null), { email: "c@example.com" })).rejects.toThrow(
      /HTTP 403/,
    );
    await expect(
      admin.ensureUser(fakeDatabase(null), { email: "c@example.com" }),
    ).rejects.not.toThrow(/service-role-key/);
  });

  it("invites a new person with the redirect, and reports an address that has an account", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "u-3" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 422, error_code: "email_exists", msg: "x" }), {
          status: 422,
        }),
      );
    const admin = createSupabaseAuthAdmin({ ...options, fetch: fetchMock });
    const redirectTo = "https://app.example.com/auth/confirm";
    expect(await admin.inviteUser({ email: "new@example.com", redirectTo })).toEqual({
      id: "u-3",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://project.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fconfirm",
    );
    expect((init?.headers as Record<string, string>)["apikey"]).toBe("service-role-key");
    expect(JSON.parse(init?.body as string)).toEqual({ email: "new@example.com" });
    expect(await admin.inviteUser({ email: "taken@example.com", redirectTo })).toBe("exists");
  });

  it("sends a sign-in link without creating a user", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "60" } }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const admin = createSupabaseAuthAdmin({ ...options, fetch: fetchMock });
    const redirectTo = "https://app.example.com/auth/confirm";
    await admin.sendSignInLink({ email: "known@example.com", redirectTo });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url as string).toMatch(/\/auth\/v1\/otp\?redirect_to=/);
    expect(JSON.parse(init?.body as string)).toEqual({
      email: "known@example.com",
      create_user: false,
    });
    const failure = admin.sendSignInLink({ email: "known@example.com", redirectTo });
    await expect(failure).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    const outage = await admin
      .inviteUser({ email: "x@example.com", redirectTo })
      .catch((error: unknown) => error as Error);
    expect(outage).toBeInstanceOf(Error);
    expect((outage as Error).message).toMatch(/HTTP 500/);
    expect((outage as Error).message).not.toMatch(/x@example\.com|service-role-key/);
  });
});
