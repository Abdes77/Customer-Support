import {
  type BusinessId,
  type ChannelConnectionContext,
  type ChannelConnectionId,
  ConfigError,
} from "@repo/core";
import { type BusinessContext, channelConnections, eq } from "@repo/db";

import { OAuthCredentials } from "../config";
import { MailProviderError } from "../providers/http";
import { refreshGoogleToken, refreshMicrosoftToken, tokenExpiresSoon } from "../providers/oauth";
import type { EmailServerDeps } from "./deps";

/** The message shown in the admin panel when a mailbox refused our access. */
export const RECONNECT_MESSAGE =
  "The mailbox refused the app's access (the password changed or access was removed): connect it again.";

/** Marks a connection as needing a reconnect, in its own transaction. */
export async function markReconnectNeeded(
  deps: Pick<EmailServerDeps, "db" | "logger" | "clock">,
  businessId: BusinessId,
  connectionId: ChannelConnectionId,
  detail: string,
): Promise<void> {
  const now = (deps.clock ?? (() => new Date()))();
  await deps.db.forBusiness(businessId).run(async (ctx) => {
    await ctx.tx
      .update(channelConnections)
      .set({ status: "error", lastError: RECONNECT_MESSAGE, lastErrorAt: now })
      .where(eq(channelConnections.id, connectionId));
  });
  deps.logger.warn("email.reconnect_needed", {
    businessId,
    connectionId,
    detail: detail.slice(0, 200),
  });
}

/**
 * Access tokens of Gmail and Microsoft connections. A token that expires within two minutes
 * is refreshed under the row lock of the connection's secret (`secrets.channel.update`), so
 * two jobs never refresh at once: the second waits and then reads the token the first one
 * stored. Microsoft returns a new refresh token every time; it replaces the old one.
 */
export function createAccessTokens(deps: EmailServerDeps) {
  const clock = deps.clock ?? (() => new Date());

  async function refreshIn(
    ctx: BusinessContext,
    connectionId: ChannelConnectionId,
    provider: "gmail" | "microsoft",
  ): Promise<string> {
    let token: string | null = null;
    await deps.db.secrets.channel.update(ctx, connectionId, async (current: unknown) => {
      const parsed = OAuthCredentials.safeParse(current);
      if (!parsed.success) throw new ConfigError("The mailbox is not connected.");
      const now = clock();
      if (!tokenExpiresSoon(parsed.data, now)) {
        token = parsed.data.accessToken;
        return undefined;
      }
      if (parsed.data.refreshToken === null) {
        throw new MailProviderError(
          provider === "gmail" ? "google_oauth" : "microsoft_oauth",
          "No refresh token is stored.",
          {
            authFailed: true,
            retryable: false,
          },
        );
      }
      let next: OAuthCredentials;
      if (provider === "gmail") {
        if (deps.google === null)
          throw new ConfigError("Gmail is not configured (GOOGLE_CLIENT_ID).");
        next = await refreshGoogleToken(deps.fetch, {
          app: deps.google.app,
          refreshToken: parsed.data.refreshToken,
          now,
        });
      } else {
        if (deps.microsoft === null)
          throw new ConfigError("Microsoft 365 is not configured (MICROSOFT_CLIENT_ID).");
        next = await refreshMicrosoftToken(deps.fetch, {
          app: deps.microsoft.app,
          refreshToken: parsed.data.refreshToken,
          now,
        });
      }
      token = next.accessToken;
      return { ...next, scope: next.scope.length > 0 ? next.scope : parsed.data.scope };
    });
    if (token === null) throw new ConfigError("The mailbox is not connected.");
    return token;
  }

  /** A valid token for a connection, inside the business's system scope. */
  async function inScope(
    ctx: BusinessContext,
    connectionId: ChannelConnectionId,
    provider: "gmail" | "microsoft",
  ): Promise<string> {
    return refreshIn(ctx, connectionId, provider);
  }

  /**
   * For the adapter: the token of the loaded connection when it is still good, otherwise a
   * refresh in its own transaction. A refused refresh marks the connection for reconnecting.
   */
  async function forConnection(connection: ChannelConnectionContext): Promise<string> {
    const current = OAuthCredentials.safeParse(connection.credentials);
    if (current.success && !tokenExpiresSoon(current.data, clock()))
      return current.data.accessToken;
    const provider =
      (connection.config as { provider?: string } | null)?.provider === "microsoft"
        ? "microsoft"
        : "gmail";
    try {
      return await deps.db
        .forBusiness(connection.businessId)
        .run((ctx) => refreshIn(ctx, connection.connectionId, provider));
    } catch (error) {
      if (error instanceof MailProviderError && error.authFailed) {
        await markReconnectNeeded(
          deps,
          connection.businessId,
          connection.connectionId,
          error.message,
        );
      }
      throw error;
    }
  }

  return { inScope, forConnection };
}

export type AccessTokens = ReturnType<typeof createAccessTokens>;
