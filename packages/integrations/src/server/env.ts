import { hkdfSync } from "node:crypto";

import { type Env, getEnv } from "@repo/core/env";

import type { ConnectorApps } from "../connectors/registry";
import type { IntegrationDeps } from "./deps";

function oauthApp(id: string | undefined, secret: string | undefined) {
  return id === undefined || secret === undefined ? null : { clientId: id, clientSecret: secret };
}

/**
 * The parts of `IntegrationDeps` that come from the deployment's environment: the CRMs' OAuth
 * apps, ServiceTitan's application key and environment, the public origin, and the key that
 * signs the OAuth state (derived with HKDF from `CREDENTIALS_ENCRYPTION_KEY` under its own
 * label, so no other secret has to be configured).
 */
export function integrationConfigFromEnv(
  env: Env = getEnv(),
): Pick<IntegrationDeps, "apps" | "appUrl" | "oauthStateKey"> {
  const apps: ConnectorApps = {
    hubspot: oauthApp(env.HUBSPOT_CLIENT_ID, env.HUBSPOT_CLIENT_SECRET),
    gohighlevel: oauthApp(env.GOHIGHLEVEL_CLIENT_ID, env.GOHIGHLEVEL_CLIENT_SECRET),
    jobber: oauthApp(env.JOBBER_CLIENT_ID, env.JOBBER_CLIENT_SECRET),
    servicetitan:
      env.SERVICETITAN_APP_KEY === undefined
        ? null
        : { appKey: env.SERVICETITAN_APP_KEY, environment: env.SERVICETITAN_ENVIRONMENT },
  };
  return {
    apps,
    appUrl: env.APP_URL ?? "http://localhost:3000",
    oauthStateKey:
      env.CREDENTIALS_ENCRYPTION_KEY === undefined
        ? null
        : new Uint8Array(
            hkdfSync(
              "sha256",
              Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64"),
              Buffer.alloc(0),
              "hsrb/crm-oauth-state/v1",
              32,
            ),
          ),
  };
}
