import { hkdfSync } from "node:crypto";

import { type Env, getEnv } from "@repo/core/env";

import type { SchedulingDeps } from "./deps";

/**
 * The parts of `SchedulingDeps` that come from the deployment's environment: the Google and
 * Microsoft OAuth apps (shared with email, C11; calendar scopes are asked for separately),
 * the Calendly app and its webhook signing key, the public origin, and the key that signs the
 * OAuth state (derived with HKDF from `CREDENTIALS_ENCRYPTION_KEY` under its own label, so no
 * other secret has to be configured).
 */
export function schedulingConfigFromEnv(
  env: Env = getEnv(),
): Pick<SchedulingDeps, "google" | "microsoft" | "calendly" | "appUrl" | "oauthStateKey"> {
  return {
    google:
      env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined
        ? null
        : { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    microsoft:
      env.MICROSOFT_CLIENT_ID === undefined || env.MICROSOFT_CLIENT_SECRET === undefined
        ? null
        : {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            tenant: env.MICROSOFT_TENANT_ID,
          },
    calendly: {
      app:
        env.CALENDLY_CLIENT_ID === undefined || env.CALENDLY_CLIENT_SECRET === undefined
          ? null
          : { clientId: env.CALENDLY_CLIENT_ID, clientSecret: env.CALENDLY_CLIENT_SECRET },
      webhookSigningKey: env.CALENDLY_WEBHOOK_SIGNING_KEY ?? null,
    },
    appUrl: env.APP_URL ?? "http://localhost:3000",
    oauthStateKey:
      env.CREDENTIALS_ENCRYPTION_KEY === undefined
        ? null
        : new Uint8Array(
            hkdfSync(
              "sha256",
              Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64"),
              Buffer.alloc(0),
              "hsrb/calendar-oauth-state/v1",
              32,
            ),
          ),
  };
}
