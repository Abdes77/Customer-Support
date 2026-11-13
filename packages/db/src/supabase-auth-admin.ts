import { ExternalServiceError, type UserId } from "@repo/core";

import type { Database } from "./database";

/**
 * The calls this package makes to Supabase Auth's server-side API with the service-role key:
 * create a user (the seed and the admin scripts), and invite someone or send them a sign-in
 * link (people management in the admin panel, C18). The service-role key bypasses row-level
 * security: it is read on the server only, never sent to a browser, never put in a log line,
 * an error or a job payload.
 *
 * Built from the Supabase Auth (GoTrue) API as documented: `POST /auth/v1/admin/users`,
 * `POST /auth/v1/invite` and `POST /auth/v1/otp` with `create_user: false`; not yet run against
 * a live project (docs/HUMAN_TODO.md, the people live check).
 */
export interface SupabaseAuthAdmin {
  /** Returns the id of the user with this email, creating the user when there is none. */
  ensureUser(
    db: Database,
    input: { readonly email: string; readonly password?: string; readonly fullName?: string },
  ): Promise<UserId>;

  /**
   * Creates the user and has Supabase send its "Invite user" email, whose link comes back to
   * `redirectTo`. "exists" when the address already has an account (nothing is sent).
   */
  inviteUser(input: {
    readonly email: string;
    readonly redirectTo: string;
  }): Promise<{ readonly id: UserId } | "exists">;

  /**
   * Has Supabase send its "Magic Link" email to an existing user. Never creates a user.
   */
  sendSignInLink(input: { readonly email: string; readonly redirectTo: string }): Promise<void>;
}

const PROVIDER = "supabase_auth";

function refused(what: string, response: Response): ExternalServiceError {
  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return new ExternalServiceError(`Supabase Auth refused to ${what} (HTTP ${response.status}).`, {
    provider: PROVIDER,
    status: response.status,
    ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
  });
}

/** Supabase's answer when an invited address already has an account. */
async function isEmailTaken(response: Response): Promise<boolean> {
  if (response.status !== 422 && response.status !== 400) return false;
  try {
    const body = (await response.clone().json()) as {
      error_code?: unknown;
      code?: unknown;
      msg?: unknown;
      message?: unknown;
    };
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const code = text(body.error_code) || text(body.code);
    const message = text(body.msg) || text(body.message);
    return code === "email_exists" || /already been registered|already registered/i.test(message);
  } catch {
    return false;
  }
}

export function createSupabaseAuthAdmin(options: {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly fetch?: typeof fetch;
}): SupabaseAuthAdmin {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.url.replace(/\/$/, "")}/auth/v1`;
  const headers = {
    "content-type": "application/json",
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const withRedirect = (path: string, redirectTo: string) =>
    `${base}${path}?${new URLSearchParams({ redirect_to: redirectTo }).toString()}`;

  return {
    async ensureUser(db, input) {
      // The auth trigger mirrors every auth user into public.users, so an existing user is
      // found there without another call.
      const existing = await db.directory.findUserByEmail(input.email);
      if (existing !== null) return existing.id;

      const response = await doFetch(`${base}/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          email_confirm: true,
          user_metadata: input.fullName === undefined ? {} : { full_name: input.fullName },
        }),
      });
      if (!response.ok) throw refused("create the user", response);
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string") {
        throw new ExternalServiceError("Supabase Auth returned no user id.", {
          provider: PROVIDER,
          retryable: false,
        });
      }
      return body.id as UserId;
    },

    async inviteUser(input) {
      const response = await doFetch(withRedirect("/invite", input.redirectTo), {
        method: "POST",
        headers,
        body: JSON.stringify({ email: input.email }),
      });
      if (!response.ok) {
        if (await isEmailTaken(response)) return "exists";
        throw refused("send the invitation", response);
      }
      const body = (await response.json()) as { id?: unknown; user?: { id?: unknown } };
      const id = typeof body.id === "string" ? body.id : body.user?.id;
      if (typeof id !== "string") {
        throw new ExternalServiceError("Supabase Auth returned no user id for the invitation.", {
          provider: PROVIDER,
          retryable: false,
        });
      }
      return { id: id as UserId };
    },

    async sendSignInLink(input) {
      const response = await doFetch(withRedirect("/otp", input.redirectTo), {
        method: "POST",
        headers,
        body: JSON.stringify({ email: input.email, create_user: false }),
      });
      if (!response.ok) throw refused("send the sign-in link", response);
    },
  };
}
