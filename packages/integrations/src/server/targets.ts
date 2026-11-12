import type { AgencyId, IntegrationConnectionId } from "@repo/core";
import {
  and,
  type BusinessContext,
  eq,
  integrationConnections,
  type SystemContext,
} from "@repo/db";
import type { AppSettings } from "@repo/settings";

import { generateSigningSecret } from "../webhook/sign";
import { WebhookCredentials } from "../webhook/connector";
import type { IntegrationDeps } from "./deps";

/*
 * Outgoing webhook targets. The targets themselves are settings (`integrations.webhooks` for a
 * business, `integrations.agency_webhooks` for every business of the agency): name, address,
 * events, active. What settings cannot hold lives elsewhere:
 *
 * - the signing secret, encrypted: a business target's on its connection row, an agency
 *   target's in `agency_secrets` (one secret for every business, so a receiver needs one);
 * - the status of each target per business (last error, last delivery), on one
 *   `integration_connections` row per target (provider "webhook", account "business:<name>" or
 *   "agency:<name>"), which the delivery journal refers to.
 */

export type TargetScope = "business" | "agency";

export interface WebhookTarget {
  readonly scope: TargetScope;
  readonly name: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
}

export const AGENCY_SECRET_PURPOSE = "webhook_target";

export function targetAccount(scope: TargetScope, name: string): string {
  return `${scope}:${name}`;
}

export function parseTargetAccount(
  account: string | null,
): { readonly scope: TargetScope; readonly name: string } | null {
  if (account === null) return null;
  const at = account.indexOf(":");
  const scope = account.slice(0, at);
  if (at <= 0 || (scope !== "business" && scope !== "agency")) return null;
  return { scope, name: account.slice(at + 1) };
}

/** Every webhook target in force for a business: its own, then the agency's. */
export function webhookTargets(values: AppSettings): WebhookTarget[] {
  return [
    ...values["integrations.webhooks"].map((target) => ({ ...target, scope: "business" as const })),
    ...values["integrations.agency_webhooks"].map((target) => ({
      ...target,
      scope: "agency" as const,
    })),
  ];
}

export function findTarget(
  values: AppSettings,
  scope: TargetScope,
  name: string,
): WebhookTarget | null {
  return webhookTargets(values).find((t) => t.scope === scope && t.name === name) ?? null;
}

/**
 * The connection row of a target in this business, created on first use. A business
 * target's signing secret is created with it.
 */
export async function ensureTargetConnection(
  deps: Pick<IntegrationDeps, "db">,
  ctx: BusinessContext,
  target: WebhookTarget,
  now: Date,
): Promise<IntegrationConnectionId> {
  const account = targetAccount(target.scope, target.name);
  const config = { name: target.name, url: target.url, scope: target.scope };
  const [existing] = await ctx.tx
    .select({ id: integrationConnections.id, config: integrationConnections.config })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, "webhook"),
        eq(integrationConnections.externalAccountId, account),
      ),
    )
    .limit(1);
  let id: IntegrationConnectionId;
  if (existing === undefined) {
    const [inserted] = await ctx.tx
      .insert(integrationConnections)
      .values({
        ...ctx.tenant,
        provider: "webhook",
        externalAccountId: account,
        displayName: target.name,
        status: "active",
        config,
        connectedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: integrationConnections.id });
    if (inserted === undefined) {
      // Another run created it a moment ago.
      const [again] = await ctx.tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.provider, "webhook"),
            eq(integrationConnections.externalAccountId, account),
          ),
        )
        .limit(1);
      id = again!.id;
    } else {
      id = inserted.id;
    }
  } else {
    id = existing.id;
    if (existing.config["url"] !== target.url) {
      await ctx.tx
        .update(integrationConnections)
        .set({ config, status: "active" })
        .where(eq(integrationConnections.id, id));
    }
  }
  if (target.scope === "business") {
    await deps.db.secrets.integration.update(
      ctx,
      id,
      (current) => (current === null ? { signingSecret: generateSigningSecret() } : undefined),
      WebhookCredentials,
    );
  }
  return id;
}

/**
 * The signing secret of an agency target, created on first use in its own agency-wide
 * transaction (a business scope may read agency secrets, not write them).
 */
export async function ensureAgencySecret(
  deps: Pick<IntegrationDeps, "db">,
  agencyId: AgencyId,
  name: string,
): Promise<void> {
  await deps.db.forAgency(agencyId).run(async (ctx) => {
    const current = await deps.db.secrets.agency.read(
      ctx,
      AGENCY_SECRET_PURPOSE,
      name,
      WebhookCredentials,
    );
    if (current === null) {
      await deps.db.secrets.agency.write(ctx, AGENCY_SECRET_PURPOSE, name, {
        signingSecret: generateSigningSecret(),
      });
    }
  });
}

/** The signing secret of a target, or null when none was made yet. */
export async function readTargetSecret(
  deps: Pick<IntegrationDeps, "db">,
  ctx: SystemContext & BusinessContext,
  target: { readonly scope: TargetScope; readonly name: string },
  connectionId: IntegrationConnectionId,
): Promise<WebhookCredentials | null> {
  return target.scope === "agency"
    ? deps.db.secrets.agency.read(ctx, AGENCY_SECRET_PURPOSE, target.name, WebhookCredentials)
    : deps.db.secrets.integration.read(ctx, connectionId, WebhookCredentials);
}
