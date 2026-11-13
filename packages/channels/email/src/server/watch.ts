import { createHmac, timingSafeEqual } from "node:crypto";

import { channelConnections, eq, sql } from "@repo/db";

import { EmailConnectionConfig, readState } from "../config";
import { MailProviderError } from "../providers/http";
import { type EmailServerDeps, publicUrl, ROUTES } from "./deps";
import type { SyncTarget } from "./sync";
import type { AccessTokens } from "./tokens";

/*
 * Keeping push notifications alive. Gmail: `users.watch` expires after seven days and Google
 * recommends renewing daily. Graph: a subscription to Outlook messages lasts at most 10,080
 * minutes; we ask for three days and renew when less than a day and a half is left. Without
 * a topic (Gmail) or without an https notification URL and the client-state secret (Graph),
 * the inbox is simply polled (`email-poll`).
 */

/** Graph subscriptions are created for this long. */
export const GRAPH_SUBSCRIPTION_MS = 3 * 24 * 3600_000;
/** Renew a Graph subscription when less than this is left. */
export const GRAPH_RENEW_BEFORE_MS = 36 * 3600_000;
/** Renew a Gmail watch when it was last renewed more than this ago (expiry minus 7 days). */
export const GMAIL_RENEW_AFTER_MS = 20 * 3600_000;
const GMAIL_WATCH_MS = 7 * 24 * 3600_000;

/**
 * The `clientState` of a connection's Graph subscription: an HMAC of the connection id with
 * `MICROSOFT_GRAPH_CLIENT_STATE`, so each subscription has its own value and none is stored.
 */
export function graphClientState(secret: string, connectionId: string): string {
  return createHmac("sha256", secret)
    .update(`graph-client-state:${connectionId}`)
    .digest("base64url");
}

/** Constant-time comparison of a notification's `clientState` with the expected one. */
export function clientStateMatches(
  secret: string,
  connectionId: string,
  presented: unknown,
): boolean {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 256)
    return false;
  const expected = Buffer.from(graphClientState(secret, connectionId));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Whether Graph can reach us: notifications need a public https URL. */
export function graphNotificationsPossible(deps: EmailServerDeps): boolean {
  return deps.microsoft?.clientStateSecret != null && deps.appUrl.startsWith("https://");
}

async function updateState(
  deps: EmailServerDeps,
  target: SyncTarget,
  patch: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify(patch);
  await deps.db.forBusiness(target.businessId, { agencyId: target.agencyId }).run(async (ctx) => {
    await ctx.tx
      .update(channelConnections)
      .set({ state: sql`${channelConnections.state} || ${value}::jsonb` })
      .where(eq(channelConnections.id, target.connectionId));
  });
}

/**
 * Makes sure an inbox's push channel is alive: renews a Gmail watch or a Graph subscription
 * that is close to expiry, creates a missing one. `force` renews regardless (a Graph
 * lifecycle notification asked for it). Returns what it did.
 */
export async function ensurePush(
  deps: EmailServerDeps,
  tokens: AccessTokens,
  target: SyncTarget,
  options: { readonly force?: boolean } = {},
): Promise<"renewed" | "created" | "current" | "unavailable"> {
  const now = (deps.clock ?? (() => new Date()))();
  const row = await deps.db
    .forBusiness(target.businessId, { agencyId: target.agencyId })
    .run(async (ctx) => {
      const [found] = await ctx.tx
        .select({
          status: channelConnections.status,
          config: channelConnections.config,
          state: channelConnections.state,
        })
        .from(channelConnections)
        .where(eq(channelConnections.id, target.connectionId))
        .limit(1);
      return found;
    });
  if (row === undefined || (row.status !== "active" && row.status !== "error"))
    return "unavailable";
  const config = EmailConnectionConfig.safeParse(row.config);
  if (!config.success) return "unavailable";
  const state = readState(row.state);
  const scope = deps.db.forBusiness(target.businessId, { agencyId: target.agencyId });

  if (config.data.provider === "gmail") {
    const topic = deps.google?.pubsubTopic ?? null;
    if (topic === null) return "unavailable";
    const expires = Date.parse(state.gmail?.watchExpiresAt ?? "");
    const renewedAt = Number.isNaN(expires) ? 0 : expires - GMAIL_WATCH_MS;
    if (!options.force && now.getTime() - renewedAt < GMAIL_RENEW_AFTER_MS) return "current";
    const token = await scope.run((ctx) => tokens.inScope(ctx, target.connectionId, "gmail"));
    const watch = await deps.gmail.watch(token, topic);
    const expiration = Number(watch.expiration);
    // The cursor stays: the watch's history id is "now", and mail since the cursor would be lost.
    await updateState(deps, target, {
      gmail: {
        historyId: state.gmail?.historyId ?? watch.historyId,
        watchExpiresAt: new Date(
          Number.isFinite(expiration) ? expiration : now.getTime() + GMAIL_WATCH_MS,
        ).toISOString(),
      },
    });
    return Number.isNaN(expires) ? "created" : "renewed";
  }

  if (config.data.provider === "microsoft") {
    const secret = deps.microsoft?.clientStateSecret ?? null;
    if (secret === null || !graphNotificationsPossible(deps)) return "unavailable";
    const expires = Date.parse(state.microsoft?.subscriptionExpiresAt ?? "");
    const subscriptionId = state.subscriptionId ?? null;
    if (
      !options.force &&
      subscriptionId !== null &&
      !Number.isNaN(expires) &&
      expires - now.getTime() > GRAPH_RENEW_BEFORE_MS
    ) {
      return "current";
    }
    const token = await scope.run((ctx) => tokens.inScope(ctx, target.connectionId, "microsoft"));
    const until = new Date(now.getTime() + GRAPH_SUBSCRIPTION_MS);
    if (subscriptionId !== null) {
      try {
        const renewed = await deps.graph.renew(token, subscriptionId, until);
        await updateState(deps, target, {
          microsoft: {
            deltaLinks: state.microsoft?.deltaLinks ?? {},
            subscriptionExpiresAt: renewed.expirationDateTime,
          },
        });
        return "renewed";
      } catch (error) {
        // Gone (expired or removed): create a new one below.
        if (!(error instanceof MailProviderError && error.status === 404)) throw error;
      }
    }
    const created = await deps.graph.subscribe(token, {
      notificationUrl: publicUrl(deps.appUrl, ROUTES.graphNotifications),
      clientState: graphClientState(secret, target.connectionId),
      expiresAt: until,
    });
    await updateState(deps, target, {
      subscriptionId: created.id,
      microsoft: {
        deltaLinks: state.microsoft?.deltaLinks ?? {},
        subscriptionExpiresAt: created.expirationDateTime,
      },
    });
    return "created";
  }
  return "unavailable";
}

/** Stops push for a connection being disconnected (best effort) and frees its subscription. */
export async function stopPush(
  deps: EmailServerDeps,
  target: SyncTarget,
  token: string | null,
): Promise<void> {
  const row = await deps.db
    .forBusiness(target.businessId, { agencyId: target.agencyId })
    .run(async (ctx) => {
      const [found] = await ctx.tx
        .select({ config: channelConnections.config, state: channelConnections.state })
        .from(channelConnections)
        .where(eq(channelConnections.id, target.connectionId))
        .limit(1);
      return found;
    });
  if (row === undefined) return;
  const config = EmailConnectionConfig.safeParse(row.config);
  const state = readState(row.state);
  try {
    if (
      token !== null &&
      config.success &&
      config.data.provider === "gmail" &&
      state.gmail?.watchExpiresAt
    ) {
      await deps.gmail.stop(token);
    }
    if (
      token !== null &&
      config.success &&
      config.data.provider === "microsoft" &&
      state.subscriptionId
    ) {
      await deps.graph.unsubscribe(token, state.subscriptionId);
    }
  } catch (error) {
    deps.logger.warn("email.stop_push_failed", {
      businessId: target.businessId,
      connectionId: target.connectionId,
      status: error instanceof MailProviderError ? (error.status ?? null) : null,
    });
  }
  await updateState(deps, target, { subscriptionId: null });
}
