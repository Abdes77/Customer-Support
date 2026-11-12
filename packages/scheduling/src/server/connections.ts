import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  type AgencyId,
  type BusinessId,
  ConfigError,
  type IntegrationConnectionId,
  NotFoundError,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  desc,
  eq,
  integrationConnections,
  recordSystemAudit,
} from "@repo/db";

import { createGoogleCalendarClient } from "../calendars/google";
import { createMicrosoftCalendarClient } from "../calendars/microsoft";
import type { CalendarClient, CalendarInfo, CalendarProviderId } from "../calendars/types";
import { type CalendlyClient, createCalendlyClient } from "../calendly/client";
import { CalendarApiError } from "../http";
import {
  CALENDAR_OAUTH_COOKIE,
  CalendarCredentials,
  type CalendarOAuthProvider,
  type CalendarOAuthState,
  calendlyAuthorizationUrl,
  cookieValue,
  createOAuthState,
  exchangeCode,
  googleAuthorizationUrl,
  microsoftAuthorizationUrl,
  OAUTH_STATE_TTL_MS,
  pkcePair,
  readCookieValue,
  refreshAccessToken,
  tokenExpiresSoon,
  verifyOAuthState,
} from "../oauth";
import { clockOf, publicUrl, SCHEDULING_ROUTES, type SchedulingDeps } from "./deps";

/*
 * Calendar connections: one `integration_connections` row per connected account (provider
 * `google_calendar`, `outlook_calendar` or `calendly`), its tokens encrypted in
 * `integration_connection_secrets`. A business has at most one active connection per
 * provider; connecting again replaces the tokens of the same row. `scheduling.provider`
 * decides which one books. Only these connect flows write the rows (ARCHITECTURE §3).
 */

export type SchedulingProvider = CalendarProviderId | "calendly";
export const SCHEDULING_PROVIDERS: readonly SchedulingProvider[] = [
  "google_calendar",
  "outlook_calendar",
  "calendly",
];

export const CalendarConfig = z.object({
  /** The calendars whose events keep times from being offered. */
  calendarIds: z.array(z.string().min(1)).min(1).max(10),
  /** The calendar the bot's events go into. */
  bookingCalendarId: z.string().min(1),
});
export type CalendarConfig = z.infer<typeof CalendarConfig>;

export const CalendlyConfig = z.object({
  userUri: z.string().min(1),
  organization: z.string().min(1),
  /** The key in our webhook URL; names this connection (unique per provider). */
  webhookKey: z.string().min(16),
  webhookUri: z.string().nullable(),
  /** "oauth": signed with the app's key; "token": with this connection's own key. */
  auth: z.enum(["oauth", "token"]),
});
export type CalendlyConfig = z.infer<typeof CalendlyConfig>;

export interface ConnectionRow {
  readonly id: IntegrationConnectionId;
  readonly provider: SchedulingProvider;
  readonly status: string;
  readonly externalAccountId: string | null;
  readonly config: Record<string, unknown>;
  readonly state: Record<string, unknown>;
}

/** What the admin panel sees of a connection: no token, no key. */
export interface ConnectionView {
  readonly id: IntegrationConnectionId;
  readonly provider: SchedulingProvider;
  readonly account: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly connectedAt: string | null;
  readonly calendars: CalendarConfig | null;
}

export const RECONNECT_MESSAGE =
  "The calendar refused the app's access (the password changed or access was removed): connect it again.";

export function isSchedulingProvider(value: string): value is SchedulingProvider {
  return (SCHEDULING_PROVIDERS as readonly string[]).includes(value);
}

export function calendarClients(deps: SchedulingDeps): {
  readonly google: CalendarClient;
  readonly microsoft: CalendarClient;
  readonly calendly: CalendlyClient;
} {
  return {
    google: deps.clients?.google ?? createGoogleCalendarClient(deps.fetch),
    microsoft: deps.clients?.microsoft ?? createMicrosoftCalendarClient(deps.fetch),
    calendly: deps.clients?.calendly ?? createCalendlyClient(deps.fetch),
  };
}

/** The business's active connection of a provider, newest first. */
export async function activeConnection(
  ctx: BusinessContext,
  provider: SchedulingProvider,
): Promise<ConnectionRow | null> {
  const [row] = await ctx.tx
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      status: integrationConnections.status,
      externalAccountId: integrationConnections.externalAccountId,
      config: integrationConnections.config,
      state: integrationConnections.state,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, provider),
        eq(integrationConnections.status, "active"),
      ),
    )
    .orderBy(desc(integrationConnections.connectedAt))
    .limit(1);
  return row === undefined ? null : { ...row, provider };
}

function oauthApp(deps: SchedulingDeps, provider: CalendarOAuthProvider) {
  if (provider === "google_calendar") return deps.google;
  if (provider === "outlook_calendar") return deps.microsoft;
  return deps.calendly.app;
}

/**
 * A valid access token for a connection, inside the business's system scope. An OAuth token
 * that expires within two minutes is refreshed under the secret's row lock, so two jobs never
 * refresh at once; a refused refresh marks the connection for reconnecting.
 */
export async function accessToken(
  deps: SchedulingDeps,
  ctx: BusinessContext,
  connection: ConnectionRow,
): Promise<string> {
  const clock = clockOf(deps);
  let token: string | null = null;
  try {
    await deps.db.secrets.integration.update(
      ctx,
      connection.id,
      async (current) => {
        if (current === null) throw new ConfigError("The calendar is not connected.");
        if (current.kind === "token") {
          token = current.accessToken;
          return undefined;
        }
        const now = clock();
        if (!tokenExpiresSoon(current, now)) {
          token = current.accessToken;
          return undefined;
        }
        if (current.refreshToken === null) {
          throw new CalendarApiError(connection.provider, "No refresh token is stored.", {
            authFailed: true,
            retryable: false,
          });
        }
        const app = oauthApp(deps, connection.provider);
        if (app === null) throw new ConfigError(`${connection.provider} is not configured.`);
        const next = await refreshAccessToken(deps.fetch, connection.provider, {
          app,
          refreshToken: current.refreshToken,
          now,
        });
        token = next.accessToken;
        return { ...next, scope: next.scope.length > 0 ? next.scope : current.scope };
      },
      CalendarCredentials,
    );
  } catch (error) {
    if (error instanceof CalendarApiError && error.authFailed) {
      await markReconnectNeeded(deps, ctx, connection.id, error.message);
    }
    throw error;
  }
  if (token === null) throw new ConfigError("The calendar is not connected.");
  return token;
}

/**
 * Marks a connection as needing a reconnect. Runs in its own transaction, so the mark stays
 * even when the caller's transaction is rolled back by the error that follows.
 */
export async function markReconnectNeeded(
  deps: SchedulingDeps,
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  detail: string,
): Promise<void> {
  const now = clockOf(deps)();
  await deps.db
    .forBusiness(ctx.tenant.businessId, { agencyId: ctx.tenant.agencyId })
    .run((own) =>
      own.tx
        .update(integrationConnections)
        .set({ status: "error", lastError: RECONNECT_MESSAGE, lastErrorAt: now })
        .where(eq(integrationConnections.id, connectionId)),
    );
  deps.logger.warn("scheduling.reconnect_needed", {
    businessId: ctx.tenant.businessId,
    connectionId,
    detail: detail.slice(0, 200),
  });
}

export function calendarConfigOf(connection: ConnectionRow): CalendarConfig {
  const parsed = CalendarConfig.safeParse(connection.config);
  if (parsed.success) return parsed.data;
  const fallback = connection.provider === "outlook_calendar" ? "default" : "primary";
  return { calendarIds: [fallback], bookingCalendarId: fallback };
}

// --- the admin panel's service ------------------------------------------------------------

export interface Tenant {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
}

export interface OAuthStart {
  readonly authorizationUrl: string;
  readonly cookie: {
    readonly name: string;
    readonly value: string;
    readonly maxAgeSeconds: number;
  };
}

export interface SchedulingConnectionService {
  /** Which connect methods this deployment offers. */
  availability(): {
    readonly google: boolean;
    readonly microsoft: boolean;
    readonly calendlyOAuth: boolean;
    readonly calendlyToken: boolean;
  };
  startOAuth(
    tenant: Tenant,
    userId: UserId,
    provider: CalendarOAuthProvider,
    options: { readonly returnTo: string },
  ): OAuthStart;
  /** Checks the signed state against the flow's cookie; throws when it does not hold. */
  readState(
    state: string,
    cookie: string | null,
  ): CalendarOAuthState & { readonly verifier: string };
  completeOAuth(
    payload: CalendarOAuthState & { readonly verifier: string },
    code: string,
  ): Promise<ConnectionView>;
  /** Connects Calendly with a personal access token (no OAuth app needed). */
  connectCalendlyToken(tenant: Tenant, userId: UserId, token: string): Promise<ConnectionView>;
  list(tenant: Tenant): Promise<ConnectionView[]>;
  listCalendars(tenant: Tenant, connectionId: IntegrationConnectionId): Promise<CalendarInfo[]>;
  setCalendars(
    tenant: Tenant,
    userId: UserId,
    connectionId: IntegrationConnectionId,
    calendars: CalendarConfig,
  ): Promise<ConnectionView>;
  disconnect(tenant: Tenant, userId: UserId, connectionId: IntegrationConnectionId): Promise<void>;
}

function segmentOf(provider: CalendarOAuthProvider): "google" | "microsoft" | "calendly" {
  return provider === "google_calendar"
    ? "google"
    : provider === "outlook_calendar"
      ? "microsoft"
      : "calendly";
}

const VIEW_COLUMNS = {
  id: integrationConnections.id,
  provider: integrationConnections.provider,
  externalAccountId: integrationConnections.externalAccountId,
  displayName: integrationConnections.displayName,
  status: integrationConnections.status,
  lastError: integrationConnections.lastError,
  connectedAt: integrationConnections.connectedAt,
  config: integrationConnections.config,
};

function toView(row: {
  id: IntegrationConnectionId;
  provider: string;
  externalAccountId: string | null;
  displayName: string | null;
  status: string;
  lastError: string | null;
  connectedAt: Date | null;
  config: Record<string, unknown>;
}): ConnectionView {
  const provider = row.provider as SchedulingProvider;
  return {
    id: row.id,
    provider,
    account: row.displayName ?? row.externalAccountId,
    status: row.status,
    lastError: row.lastError,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    calendars: provider === "calendly" ? null : calendarConfigOf({ ...row, provider, state: {} }),
  };
}

export function createSchedulingConnectionService(
  deps: SchedulingDeps,
): SchedulingConnectionService {
  const clock = clockOf(deps);
  const clients = calendarClients(deps);
  const scope = (tenant: Tenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  function redirectUri(provider: CalendarOAuthProvider): string {
    return publicUrl(deps.appUrl, SCHEDULING_ROUTES.oauthCallback(segmentOf(provider)));
  }

  /** Stores a connection: the same row again for the same account, else a new one. */
  async function save(
    tenant: Tenant,
    userId: UserId,
    input: {
      readonly provider: SchedulingProvider;
      readonly account: string;
      readonly displayName: string;
      readonly config: Record<string, unknown>;
      readonly credentials: CalendarCredentials;
    },
  ): Promise<{ view: ConnectionView; replaced: Record<string, unknown> | null }> {
    const now = clock();
    return scope(tenant).run(async (ctx) => {
      const [existing] = await ctx.tx
        .select({ id: integrationConnections.id, config: integrationConnections.config })
        .from(integrationConnections)
        .where(eq(integrationConnections.provider, input.provider))
        .orderBy(desc(integrationConnections.connectedAt))
        .limit(1);
      let id: IntegrationConnectionId;
      if (existing !== undefined) {
        // Keep the calendar choice when the same calendar account connects again.
        const config =
          input.provider === "calendly"
            ? input.config
            : { ...input.config, ...keepCalendars(existing.config, input) };
        await ctx.tx
          .update(integrationConnections)
          .set({
            externalAccountId: input.account,
            displayName: input.displayName,
            status: "active",
            config,
            state: {},
            lastError: null,
            lastErrorAt: null,
            connectedBy: userId,
            connectedAt: now,
          })
          .where(eq(integrationConnections.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await ctx.tx
          .insert(integrationConnections)
          .values({
            ...ctx.tenant,
            provider: input.provider,
            externalAccountId: input.account,
            displayName: input.displayName,
            status: "active",
            config: input.config,
            connectedBy: userId,
            connectedAt: now,
          })
          .returning({ id: integrationConnections.id });
        id = row!.id;
      }
      await deps.db.secrets.integration.write(ctx, id, input.credentials);
      await recordSystemAudit(
        ctx,
        { type: "user", userId },
        {
          action: "scheduling.connect",
          targetType: "integration_connection",
          targetId: id,
          summary: `Connected ${input.provider.replace("_", " ")} (${input.displayName}).`,
        },
      );
      const [view] = await ctx.tx
        .select(VIEW_COLUMNS)
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id));
      return { view: toView(view!), replaced: existing?.config ?? null };
    });
  }

  function keepCalendars(
    previous: Record<string, unknown>,
    input: { readonly provider: SchedulingProvider; readonly account: string },
  ): Record<string, unknown> {
    const parsed = CalendarConfig.safeParse(previous);
    return parsed.success &&
      (previous["account"] === undefined || previous["account"] === input.account)
      ? parsed.data
      : {};
  }

  async function connectCalendly(
    tenant: Tenant,
    userId: UserId,
    token: string,
    credentials: CalendarCredentials,
    auth: "oauth" | "token",
  ): Promise<ConnectionView> {
    const me = await clients.calendly.me(token);
    const webhookKey = randomBytes(24).toString("base64url");
    const signingKey = credentials.kind === "token" ? credentials.webhookSigningKey : null;
    if (auth === "oauth" && deps.calendly.webhookSigningKey === null) {
      throw new ConfigError("Calendly webhooks are not configured (CALENDLY_WEBHOOK_SIGNING_KEY).");
    }
    const webhookUri = await clients.calendly.createWebhook(token, {
      url: publicUrl(deps.appUrl, SCHEDULING_ROUTES.calendlyWebhook(webhookKey)),
      organization: me.organization,
      user: me.uri,
      signingKey,
    });
    const { view, replaced } = await save(tenant, userId, {
      provider: "calendly",
      account: me.uri,
      displayName: me.name ?? me.schedulingUrl ?? "Calendly",
      config: {
        userUri: me.uri,
        organization: me.organization,
        webhookKey,
        webhookUri,
        auth,
      } satisfies CalendlyConfig,
      credentials,
    });
    // The subscription of the connection this one replaced stops (best effort).
    const old = replaced === null ? null : CalendlyConfig.safeParse(replaced);
    if (
      old?.success === true &&
      old.data.webhookUri !== null &&
      old.data.webhookUri !== webhookUri
    ) {
      await clients.calendly.deleteWebhook(token, old.data.webhookUri).catch((error: unknown) => {
        deps.logger.warn("scheduling.calendly_webhook_cleanup_failed", { error });
      });
    }
    return view;
  }

  async function loadConnection(
    ctx: BusinessContext,
    connectionId: IntegrationConnectionId,
  ): Promise<ConnectionRow> {
    const [row] = await ctx.tx
      .select({
        id: integrationConnections.id,
        provider: integrationConnections.provider,
        status: integrationConnections.status,
        externalAccountId: integrationConnections.externalAccountId,
        config: integrationConnections.config,
        state: integrationConnections.state,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (row === undefined || !isSchedulingProvider(row.provider)) {
      throw new NotFoundError("The calendar connection was not found.");
    }
    return { ...row, provider: row.provider };
  }

  return {
    availability: () => ({
      google: deps.google !== null && deps.oauthStateKey !== null,
      microsoft: deps.microsoft !== null && deps.oauthStateKey !== null,
      calendlyOAuth:
        deps.calendly.app !== null &&
        deps.calendly.webhookSigningKey !== null &&
        deps.oauthStateKey !== null,
      calendlyToken: true,
    }),

    startOAuth(tenant, userId, provider, options) {
      const app = oauthApp(deps, provider);
      if (app === null || deps.oauthStateKey === null) {
        throw new ConfigError(
          `${provider.replace("_", " ")} is not configured on this deployment.`,
        );
      }
      const { verifier, challenge } = pkcePair();
      const { state, nonce } = createOAuthState(
        deps.oauthStateKey,
        { p: provider, a: tenant.agencyId, b: tenant.businessId, u: userId, r: options.returnTo },
        clock(),
      );
      const input = { redirectUri: redirectUri(provider), state, codeChallenge: challenge };
      const authorizationUrl =
        provider === "google_calendar"
          ? googleAuthorizationUrl({ app, ...input })
          : provider === "outlook_calendar"
            ? microsoftAuthorizationUrl({ app: deps.microsoft!, ...input })
            : calendlyAuthorizationUrl({ app, ...input });
      return {
        authorizationUrl,
        cookie: {
          name: CALENDAR_OAUTH_COOKIE,
          value: cookieValue(nonce, verifier),
          maxAgeSeconds: OAUTH_STATE_TTL_MS / 1000,
        },
      };
    },

    readState(state, cookie) {
      if (deps.oauthStateKey === null) throw new ConfigError("OAuth is not configured.");
      const parsed = readCookieValue(cookie);
      const check = verifyOAuthState(deps.oauthStateKey, state, parsed?.nonce ?? null, clock());
      if (!check.ok || parsed === null) {
        throw new ValidationError("The sign-in could not be verified. Start again.", {
          details: { reason: check.ok ? "cookie" : check.reason },
        });
      }
      return { ...check.payload, verifier: parsed.verifier };
    },

    async completeOAuth(payload, code) {
      const provider = payload.p;
      const app = oauthApp(deps, provider);
      if (app === null) throw new ConfigError(`${provider} is not configured on this deployment.`);
      const tenant = { agencyId: payload.a as AgencyId, businessId: payload.b as BusinessId };
      const userId = payload.u as UserId;
      const grant = await exchangeCode(deps.fetch, provider, {
        app,
        code,
        redirectUri: redirectUri(provider),
        codeVerifier: payload.verifier,
        now: clock(),
      });
      if (provider === "calendly") {
        return connectCalendly(
          tenant,
          userId,
          grant.credentials.accessToken,
          grant.credentials,
          "oauth",
        );
      }
      const client = provider === "google_calendar" ? clients.google : clients.microsoft;
      const account = await client.account(grant.credentials.accessToken);
      const fallback = provider === "outlook_calendar" ? "default" : "primary";
      const { view } = await save(tenant, userId, {
        provider,
        account: account.address,
        displayName: account.address,
        config: { calendarIds: [fallback], bookingCalendarId: fallback, account: account.address },
        credentials: grant.credentials,
      });
      return view;
    },

    async connectCalendlyToken(tenant, userId, token) {
      const trimmed = token.trim();
      if (trimmed.length < 20 || trimmed.length > 4000 || /\s/.test(trimmed)) {
        throw new ValidationError("That does not look like a Calendly personal access token.");
      }
      try {
        return await connectCalendly(
          tenant,
          userId,
          trimmed,
          {
            kind: "token",
            accessToken: trimmed,
            webhookSigningKey: randomBytes(32).toString("base64url"),
          },
          "token",
        );
      } catch (error) {
        if (error instanceof CalendarApiError && error.authFailed) {
          throw new ValidationError("Calendly refused the token. Check it and try again.");
        }
        throw error;
      }
    },

    async list(tenant) {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select(VIEW_COLUMNS)
          .from(integrationConnections)
          .orderBy(desc(integrationConnections.connectedAt));
        return rows.filter((row) => isSchedulingProvider(row.provider)).map(toView);
      });
    },

    async listCalendars(tenant, connectionId) {
      return scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        if (connection.provider === "calendly") return [];
        const token = await accessToken(deps, ctx, connection);
        const client =
          connection.provider === "google_calendar" ? clients.google : clients.microsoft;
        return client.listCalendars(token);
      });
    },

    async setCalendars(tenant, userId, connectionId, calendars) {
      const parsed = CalendarConfig.parse(calendars);
      return scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        if (connection.provider === "calendly") {
          throw new ValidationError("Calendly has no calendars to choose.");
        }
        const token = await accessToken(deps, ctx, connection);
        const client =
          connection.provider === "google_calendar" ? clients.google : clients.microsoft;
        const available = await client.listCalendars(token);
        const known = new Set(available.map((item) => item.id));
        // Google lists the primary calendar under its address; "primary" names it too.
        if (connection.provider === "google_calendar") known.add("primary");
        const unknown = parsed.calendarIds.filter((id) => !known.has(id));
        if (unknown.length > 0 || !known.has(parsed.bookingCalendarId)) {
          throw new ValidationError("Choose calendars of the connected account.");
        }
        const writable = available.find((item) => item.id === parsed.bookingCalendarId);
        if (writable !== undefined && !writable.canWrite) {
          throw new ValidationError("The bot cannot add events to that calendar.");
        }
        await ctx.tx
          .update(integrationConnections)
          .set({ config: { ...connection.config, ...parsed } })
          .where(eq(integrationConnections.id, connectionId));
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "scheduling.calendars",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: "Changed which calendars are checked and booked into.",
          },
        );
        const [view] = await ctx.tx
          .select(VIEW_COLUMNS)
          .from(integrationConnections)
          .where(eq(integrationConnections.id, connectionId));
        return toView(view!);
      });
    },

    async disconnect(tenant, userId, connectionId) {
      await scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        if (connection.provider === "calendly") {
          const config = CalendlyConfig.safeParse(connection.config);
          if (config.success && config.data.webhookUri !== null) {
            try {
              const token = await accessToken(deps, ctx, connection);
              await clients.calendly.deleteWebhook(token, config.data.webhookUri);
            } catch (error) {
              deps.logger.warn("scheduling.calendly_webhook_cleanup_failed", { error });
            }
          }
        }
        // Switched off, not deleted: bookings keep pointing at it.
        await ctx.tx
          .update(integrationConnections)
          .set({
            status: "disabled",
            config: { ...connection.config, webhookKey: null },
          })
          .where(eq(integrationConnections.id, connectionId));
        await deps.db.secrets.integration.remove(ctx, connectionId);
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "scheduling.disconnect",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: `Disconnected ${connection.provider.replace("_", " ")}.`,
          },
        );
      });
    },
  };
}
