import { ExternalServiceError, type UserId } from "@repo/core";

import type { Database } from "./database";

/**
 * The one call this package makes to Supabase Auth: create a user with the admin API, for
 * the seed and the admin scripts on a Supabase database. The service-role key bypasses
 * row-level security; it stays in scripts and never reaches a route or a browser.
 *
 * Built from the Supabase Auth admin API as documented; not yet run against a live project
 * (docs/HUMAN_TODO.md).
 */
export interface SupabaseAuthAdmin {
  /** Returns the id of the user with this email, creating the user when there is none. */
  ensureUser(
    db: Database,
    input: { readonly email: string; readonly password?: string; readonly fullName?: string },
  ): Promise<UserId>;
}

export function createSupabaseAuthAdmin(options: {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly fetch?: typeof fetch;
}): SupabaseAuthAdmin {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/$/, "")}/auth/v1/admin/users`;

  return {
    async ensureUser(db, input) {
      // The auth trigger mirrors every auth user into public.users, so an existing user is
      // found there without another call.
      const existing = await db.directory.findUserByEmail(input.email);
      if (existing !== null) return existing.id;

      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: options.serviceRoleKey,
          authorization: `Bearer ${options.serviceRoleKey}`,
        },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          email_confirm: true,
          user_metadata: input.fullName === undefined ? {} : { full_name: input.fullName },
        }),
      });
      if (!response.ok) {
        throw new ExternalServiceError(
          `Supabase Auth refused to create the user (HTTP ${response.status}).`,
          { provider: "supabase_auth", status: response.status },
        );
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string") {
        throw new ExternalServiceError("Supabase Auth returned no user id.", {
          provider: "supabase_auth",
          retryable: false,
        });
      }
      return body.id as UserId;
    },
  };
}
