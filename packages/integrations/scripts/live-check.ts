/**
 * Live check of a CRM account or a webhook receiver (HUMAN_TODO 34) with the app's own
 * connectors. Secrets are read from standard input, never from the command line, and never
 * printed.
 *
 *   pnpm --filter @repo/integrations live:check --provider hubspot            (private app token)
 *   pnpm --filter @repo/integrations live:check --provider gohighlevel --location <id>
 *                                                                             (private integration token)
 *   pnpm --filter @repo/integrations live:check --provider jobber             (OAuth access token)
 *   pnpm --filter @repo/integrations live:check --provider housecall_pro      (API key)
 *   pnpm --filter @repo/integrations live:check --provider servicetitan --tenant <id>
 *        --client-id <id> --booking-provider <id> [--environment integration|production]
 *                                                     (client secret; SERVICETITAN_APP_KEY in env)
 *   pnpm --filter @repo/integrations live:check --provider webhook --url https://...
 *                                                                             (signing secret)
 *
 * Without `--write` it only tests the connection. With `--write` it pushes a clearly marked
 * test lead ("HSRB Test Lead", test@example.com) with the report as a note, then updates it
 * once, and prints the external id and link: delete the record in the CRM afterwards.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  type BusinessId,
  type ConnectorContext,
  createLogger,
  type IntegrationConnectionId,
  type IntegrationConnector,
} from "@repo/core";
import { getEnv } from "@repo/core/env";

import {
  createGoHighLevelConnector,
  createHousecallProConnector,
  createHubSpotConnector,
  createJobberConnector,
  createSafePoster,
  createServiceTitanConnector,
  createWebhookConnector,
} from "../src";
import { sampleLeadPayload } from "../src/testing";

async function readSecret(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await lines.question(`${prompt}, then Enter: `);
  lines.close();
  return answer.trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      location: { type: "string" },
      tenant: { type: "string" },
      "client-id": { type: "string" },
      "booking-provider": { type: "string" },
      environment: { type: "string", default: "integration" },
      url: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const provider = values.provider;
  const logger = createLogger({ level: "warn" });
  let connector: IntegrationConnector<unknown, unknown>;
  let credentials: unknown;
  let config: unknown;
  let fetchImpl: typeof fetch = fetch;
  switch (provider) {
    case "hubspot":
      connector = createHubSpotConnector();
      credentials = { kind: "token", accessToken: await readSecret("Private app access token") };
      config = { hubId: null };
      break;
    case "gohighlevel":
      if (values.location === undefined) throw new Error("--location <id> is required.");
      connector = createGoHighLevelConnector();
      credentials = { kind: "token", accessToken: await readSecret("Private integration token") };
      config = { locationId: values.location, pipelineId: null, pipelineStageId: null };
      break;
    case "jobber":
      connector = createJobberConnector();
      credentials = {
        kind: "oauth",
        accessToken: await readSecret("Jobber OAuth access token"),
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      config = { accountName: null };
      break;
    case "housecall_pro":
      connector = createHousecallProConnector();
      credentials = { kind: "api_key", apiKey: await readSecret("Housecall Pro API key") };
      config = {};
      break;
    case "servicetitan": {
      const appKey = getEnv().SERVICETITAN_APP_KEY;
      if (appKey === undefined) throw new Error("Set SERVICETITAN_APP_KEY.");
      if (values.tenant === undefined || values["client-id"] === undefined) {
        throw new Error("--tenant and --client-id are required.");
      }
      const environment = values.environment === "production" ? "production" : "integration";
      connector = createServiceTitanConnector({ appKey, environment });
      credentials = {
        kind: "client_credentials",
        tenantId: values.tenant,
        clientId: values["client-id"],
        clientSecret: await readSecret("Client secret"),
        accessToken: null,
        expiresAt: null,
      };
      config = {
        bookingProviderId: values["booking-provider"] ?? null,
        campaignId: null,
        businessUnitId: null,
        jobTypeId: null,
      };
      break;
    }
    case "webhook":
      if (values.url === undefined) throw new Error("--url https://... is required.");
      connector = createWebhookConnector();
      credentials = { signingSecret: await readSecret("Signing secret (whsec_...)") };
      config = { name: "Live check", url: values.url, scope: "business" };
      fetchImpl = createSafePoster().fetch as unknown as typeof fetch;
      break;
    default:
      throw new Error(
        "--provider hubspot|gohighlevel|jobber|housecall_pro|servicetitan|webhook is required.",
      );
  }
  const context: ConnectorContext<unknown, unknown> = {
    connectionId: "00000000-0000-4000-8000-000000000001" as IntegrationConnectionId,
    businessId: "00000000-0000-4000-8000-000000000002" as BusinessId,
    credentials,
    config: connector.configSchema.parse(config),
    fieldMapping: connector.defaultFieldMapping,
    options: {
      leadSource: "AI assistant (live check)",
      tags: ["hsrb-live-check"],
      includeReport: true,
      includeTranscript: false,
      duplicates: "update_existing",
    },
    fetch: fetchImpl,
    logger,
    now: () => new Date(),
  };
  let ctx = context;
  if (
    connector.credentialsExpireSoon?.(credentials, new Date()) === true &&
    connector.refreshCredentials
  ) {
    const refreshed = await connector.refreshCredentials(ctx);
    if (!refreshed.ok) throw new Error(`Sign-in failed: ${refreshed.error.message}`);
    ctx = { ...ctx, credentials: refreshed.value };
  }
  const tested = await connector.testConnection(ctx);
  console.log(
    tested.ok ? `connected: ${tested.value.accountLabel}` : `test failed: ${tested.error.message}`,
  );
  if (!tested.ok || !values.write) return;

  const payload = sampleLeadPayload({
    name: "HSRB Test Lead",
    firstName: "HSRB Test",
    lastName: "Lead",
    email: "test@example.com",
    phone: "(512) 555-0100",
  });
  const pushed = await connector.pushLead(ctx, payload, { idempotencyKey: `live-${Date.now()}` });
  if (!pushed.ok) throw new Error(`push failed: ${pushed.error.code}: ${pushed.error.message}`);
  console.log(`pushed: ${pushed.value.externalId} ${pushed.value.externalUrl ?? ""}`);
  const updated = await connector.updateLead(ctx, pushed.value.externalId, payload, {
    idempotencyKey: `live-${Date.now()}-update`,
    record: pushed.value,
  });
  console.log(updated.ok ? "updated: ok" : `update failed: ${updated.error.message}`);
  // A push whose answer was lost: the same lead pushed again in recovery mode must find the
  // record the first push made instead of creating a second one.
  const started = new Date(Date.now() - 15 * 60_000);
  const recovered = await connector.pushLead(ctx, payload, {
    idempotencyKey: `live-${Date.now()}-recovery`,
    recovery: { since: started, isKnownRecord: async () => false },
  });
  if (!recovered.ok) {
    console.log(`recovery failed: ${recovered.error.code}: ${recovered.error.message}`);
  } else if (values.provider === "webhook") {
    console.log("recovery: not applicable to webhooks");
  } else {
    console.log(
      recovered.value.externalId === pushed.value.externalId
        ? "recovery: found the first record (ok)"
        : `recovery: made another record ${recovered.value.externalId} (delete it; the lookup did not match)`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
