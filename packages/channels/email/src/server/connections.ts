import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  AppError,
  type BusinessId,
  type AgencyId,
  type ChannelConnectionId,
  ConfigError,
  NotFoundError,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  type BusinessTenant,
  channelConnections,
  eq,
  isUniqueViolation,
  sql,
} from "@repo/db";

import { normalizeAddress } from "../addresses";
import {
  EmailConnectionConfig,
  type EmailConnectionState,
  EmailCredentials,
  type GmailConfig,
  type ImapConfig,
  MailServer,
  type MicrosoftConfig,
  type OAuthCredentials,
  type PasswordCredentials,
  readState,
} from "../config";
import { DEFAULT_MAIL_POLICY, MailHostError } from "../net/resolve";
import { MailServerError, checkSmtp, openImap } from "../providers/imap";
import {
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  googleAuthorizationUrl,
  microsoftAuthorizationUrl,
  pkcePair,
  revokeGoogleToken,
} from "../providers/oauth";
import { type EmailServerDeps, publicUrl, ROUTES } from "./deps";
import { emailSyncEvent } from "./jobs";
import {
  cookieValue,
  createOAuthState,
  OAUTH_COOKIE,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
  readCookieValue,
  verifyOAuthState,
} from "./oauth-state";
import { createAccessTokens } from "./tokens";
import { ensurePush, graphNotificationsPossible, stopPush } from "./watch";

/*
 * Connecting an inbox (the server half of C16's email connection page). Agency staff only:
 * the caller checks the role before calling. Every flow proves control of the mailbox before
 * anything is stored (an OAuth grant from the mailbox owner, or a working IMAP and SMTP
 * login), refuses a mailbox another business has, stores the credentials encrypted, and
 * returns a view without secrets.
 */

/** What the admin panel shows of a connected inbox. Never a token or a password. */
export interface EmailConnectionView {
  readonly connectionId: ChannelConnectionId;
  readonly provider: "gmail" | "microsoft" | "imap";
  readonly address: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly connectedAt: string | null;
  readonly lastSyncAt: string | null;
  /** "push" when the provider notifies us, "polling" when we look every minute. */
  readonly delivery: "push" | "polling";
  readonly imap: { readonly host: string; readonly port: number; readonly username: string } | null;
  readonly smtp: { readonly host: string; readonly port: number; readonly username: string } | null;
}

export const ImapConnectInput = z.object({
  address: z.email().max(320),
  displayName: z.string().trim().max(200).nullable().default(null),
  imap: MailServer,
  smtp: MailServer,
  imapPassword: z.string().min(1).max(1000),
  /** Empty: the IMAP password is used for SMTP too. */
  smtpPassword: z.string().max(1000).nullable().default(null),
});
export type ImapConnectInput = z.input<typeof ImapConnectInput>;

export interface OAuthStart {
  readonly authorizationUrl: string;
  /** Set on the response: `name=value; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/email`. */
  readonly cookie: {
    readonly name: string;
    readonly value: string;
    readonly maxAgeSeconds: number;
  };
}

export interface OAuthFinish {
  readonly tenant: BusinessTenant;
  readonly connection: EmailConnectionView;
  readonly returnTo: string;
}

function conflict(): AppError {
  return new AppError("conflict", "This mailbox is connected to another business.", {
    retryable: false,
  });
}

function view(
  row: typeof channelConnections.$inferSelect,
  deps: EmailServerDeps,
): EmailConnectionView {
  const config = EmailConnectionConfig.safeParse(row.config);
  const state = readState(row.state);
  const provider = config.success ? config.data.provider : "imap";
  const now = Date.now();
  const pushed =
    provider === "gmail"
      ? deps.google?.pubsubTopic != null && Date.parse(state.gmail?.watchExpiresAt ?? "") > now
      : provider === "microsoft"
        ? graphNotificationsPossible(deps) && state.subscriptionId != null
        : false;
  const imap = config.success && config.data.provider === "imap" ? config.data : null;
  return {
    connectionId: row.id,
    provider,
    address: row.externalAccountId,
    displayName: row.displayName,
    status: row.status,
    lastError: row.lastError,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastSyncAt: state.lastSyncAt ?? null,
    delivery: pushed ? "push" : "polling",
    imap:
      imap === null
        ? null
        : { host: imap.imap.host, port: imap.imap.port, username: imap.imap.username },
    smtp:
      imap === null
        ? null
        : { host: imap.smtp.host, port: imap.smtp.port, username: imap.smtp.username },
  };
}

export function createEmailConnectionService(deps: EmailServerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const tokens = createAccessTokens(deps);
  const policy = deps.mailPolicy ?? DEFAULT_MAIL_POLICY;
  const log = deps.logger.child({ component: "email-connect" });
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  async function assertFree(tenant: BusinessTenant, address: string): Promise<void> {
    const owner = await deps.db.directory.findChannelConnection("email", address);
    if (owner !== null && owner.businessId !== tenant.businessId) throw conflict();
  }

  /** Inserts or updates the business's connection of `address`; never another tenant's. */
  async function upsert(
    ctx: BusinessContext,
    input: {
      readonly address: string;
      readonly displayName: string | null;
      readonly config: (current: EmailConnectionConfig | null) => EmailConnectionConfig;
      readonly state: (current: EmailConnectionState) => EmailConnectionState;
      readonly credentials: OAuthCredentials | PasswordCredentials;
      readonly userId: UserId | null;
    },
  ): Promise<ChannelConnectionId> {
    const [existing] = await ctx.tx
      .select({
        id: channelConnections.id,
        config: channelConnections.config,
        state: channelConnections.state,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, "email"),
          eq(channelConnections.externalAccountId, input.address),
        ),
      )
      .limit(1)
      .for("update");
    const current =
      existing === undefined
        ? null
        : (EmailConnectionConfig.safeParse(existing.config).data ?? null);
    const config = input.config(current);
    const state = input.state(existing === undefined ? {} : readState(existing.state));
    const values = {
      displayName: input.displayName,
      status: "active" as const,
      config,
      state,
      lastError: null,
      lastErrorAt: null,
      connectedBy: input.userId,
      connectedAt: clock(),
    };
    let id: ChannelConnectionId;
    if (existing !== undefined) {
      await ctx.tx
        .update(channelConnections)
        .set(values)
        .where(eq(channelConnections.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await ctx.tx
        .insert(channelConnections)
        .values({ ...ctx.tenant, channel: "email", externalAccountId: input.address, ...values })
        .onConflictDoNothing()
        .returning({ id: channelConnections.id });
      if (row === undefined) throw conflict();
      id = row.id;
    }
    await deps.db.secrets.channel.write(ctx, id, input.credentials);
    return id;
  }

  async function viewOf(
    tenant: BusinessTenant,
    connectionId: ChannelConnectionId,
  ): Promise<EmailConnectionView> {
    return scope(tenant).run(async (ctx) => {
      const [row] = await ctx.tx
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, connectionId))
        .limit(1);
      if (row === undefined) throw new NotFoundError("Connection not found.");
      return view(row, deps);
    });
  }

  function loopToken(current: EmailConnectionConfig | null): string {
    return current?.loopToken ?? randomBytes(18).toString("base64url");
  }

  async function startPush(
    tenant: BusinessTenant,
    connectionId: ChannelConnectionId,
  ): Promise<void> {
    try {
      await ensurePush(deps, tokens, { ...tenant, connectionId }, { force: true });
    } catch (error) {
      // The inbox works without push: it is polled until the renew job sets push up.
      log.warn("email.push_setup_failed", { businessId: tenant.businessId, connectionId, error });
    }
  }

  return {
    /** Which connection types this deployment offers. */
    availability(): { readonly gmail: boolean; readonly microsoft: boolean; readonly imap: true } {
      return {
        gmail: deps.google !== null && deps.oauthStateKey !== null,
        microsoft: deps.microsoft !== null && deps.oauthStateKey !== null,
        imap: true,
      };
    },

    async list(tenant: BusinessTenant): Promise<EmailConnectionView[]> {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select()
          .from(channelConnections)
          .where(eq(channelConnections.channel, "email"))
          .orderBy(channelConnections.createdAt);
        return rows.map((row) => view(row, deps));
      });
    },

    /**
     * The first half of Gmail or Microsoft OAuth: the provider's authorization URL and the
     * cookie the browser must carry back. `returnTo` is a path on this site.
     */
    startOAuth(
      tenant: BusinessTenant,
      userId: UserId,
      provider: "gmail" | "microsoft",
      options: { readonly returnTo: string; readonly loginHint?: string | null },
    ): OAuthStart {
      const key = deps.oauthStateKey;
      if (key === null)
        throw new ConfigError("OAuth is not configured (CREDENTIALS_ENCRYPTION_KEY).");
      const pkce = pkcePair();
      const { state, nonce } = createOAuthState(
        key,
        { p: provider, a: tenant.agencyId, b: tenant.businessId, u: userId, r: options.returnTo },
        clock(),
      );
      let authorizationUrl: string;
      if (provider === "gmail") {
        if (deps.google === null)
          throw new ConfigError(
            "Gmail is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
          );
        authorizationUrl = googleAuthorizationUrl({
          app: deps.google.app,
          redirectUri: publicUrl(deps.appUrl, ROUTES.googleCallback),
          state,
          codeChallenge: pkce.challenge,
          loginHint: options.loginHint ?? null,
        });
      } else {
        if (deps.microsoft === null)
          throw new ConfigError(
            "Microsoft 365 is not configured: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.",
          );
        authorizationUrl = microsoftAuthorizationUrl({
          app: deps.microsoft.app,
          redirectUri: publicUrl(deps.appUrl, ROUTES.microsoftCallback),
          state,
          codeChallenge: pkce.challenge,
          loginHint: options.loginHint ?? null,
        });
      }
      return {
        authorizationUrl,
        cookie: {
          name: OAUTH_COOKIE,
          value: cookieValue(nonce, pkce.verifier),
          maxAgeSeconds: OAUTH_STATE_TTL_MS / 1000,
        },
      };
    },

    /** Checks the state against the cookie; the route then checks the person and the role. */
    readState(
      state: string,
      cookie: string | null,
    ): OAuthStatePayload & { readonly verifier: string } {
      const key = deps.oauthStateKey;
      if (key === null) throw new ConfigError("OAuth is not configured.");
      const stored = readCookieValue(cookie);
      const check = verifyOAuthState(key, state, stored?.nonce ?? null, clock());
      if (!check.ok || stored === null) {
        throw new ValidationError(
          "The sign-in could not be verified. Start connecting the inbox again.",
          {
            details: { reason: check.ok ? "cookie" : check.reason },
          },
        );
      }
      return { ...check.payload, verifier: stored.verifier };
    },

    /**
     * The second half: exchange the code, read the mailbox's address, store the connection
     * and start push. `state` comes from `readState`, after the route checked the person.
     */
    async completeOAuth(
      state: OAuthStatePayload & { readonly verifier: string },
      code: string,
    ): Promise<OAuthFinish> {
      const tenant = { agencyId: state.a as AgencyId, businessId: state.b as BusinessId };
      const now = clock();
      let connectionId: ChannelConnectionId;
      if (state.p === "gmail") {
        if (deps.google === null) throw new ConfigError("Gmail is not configured.");
        const credentials = await exchangeGoogleCode(deps.fetch, {
          app: deps.google.app,
          code,
          redirectUri: publicUrl(deps.appUrl, ROUTES.googleCallback),
          codeVerifier: state.verifier,
          now,
        });
        if (
          !credentials.scope.includes("gmail.readonly") ||
          !credentials.scope.includes("gmail.send")
        ) {
          throw new ValidationError(
            "Allow the app to read and send email for this inbox, then try again.",
          );
        }
        const profile = await deps.gmail.profile(credentials.accessToken);
        const address = normalizeAddress(profile.emailAddress);
        if (address === null) throw new ValidationError("The mailbox has no usable address.");
        await assertFree(tenant, address);
        connectionId = await scope(tenant).run((ctx) =>
          upsert(ctx, {
            address,
            displayName: address,
            config: (current): GmailConfig => ({
              provider: "gmail",
              address,
              displayName: null,
              loopToken: loopToken(current),
            }),
            // A reconnect keeps its cursor, so mail that arrived meanwhile is still read.
            state: (current) => ({
              ...current,
              gmail: {
                historyId: current.gmail?.historyId ?? profile.historyId,
                watchExpiresAt: current.gmail?.watchExpiresAt ?? null,
              },
              lastSyncError: null,
            }),
            credentials,
            userId: state.u as UserId,
          }),
        );
      } else {
        if (deps.microsoft === null) throw new ConfigError("Microsoft 365 is not configured.");
        const credentials = await exchangeMicrosoftCode(deps.fetch, {
          app: deps.microsoft.app,
          code,
          redirectUri: publicUrl(deps.appUrl, ROUTES.microsoftCallback),
          codeVerifier: state.verifier,
          now,
        });
        const me = await deps.graph.me(credentials.accessToken);
        const address = normalizeAddress(me.mail ?? me.userPrincipalName ?? null);
        if (address === null)
          throw new ValidationError("The Microsoft account has no mailbox address.");
        await assertFree(tenant, address);
        connectionId = await scope(tenant).run((ctx) =>
          upsert(ctx, {
            address,
            displayName: me.displayName ?? address,
            config: (current): MicrosoftConfig => ({
              provider: "microsoft",
              address,
              displayName: null,
              loopToken: loopToken(current),
              userId: me.id,
            }),
            state: (current) => ({ ...current, lastSyncError: null }),
            credentials,
            userId: state.u as UserId,
          }),
        );
      }
      await startPush(tenant, connectionId);
      log.info("email.connected", {
        businessId: tenant.businessId,
        connectionId,
        provider: state.p,
      });
      return { tenant, connection: await viewOf(tenant, connectionId), returnTo: state.r };
    },

    /**
     * Connects an IMAP/SMTP inbox: both servers are checked (public address, TLS, a working
     * login) before anything is stored; reading starts with the next message to arrive.
     */
    async connectImap(
      tenant: BusinessTenant,
      userId: UserId | null,
      raw: ImapConnectInput,
    ): Promise<EmailConnectionView> {
      const input = ImapConnectInput.parse(raw);
      const address = normalizeAddress(input.address);
      if (address === null) throw new ValidationError("Enter the inbox's email address.");
      await assertFree(tenant, address);
      const smtpPassword =
        input.smtpPassword === null || input.smtpPassword.length === 0
          ? input.imapPassword
          : input.smtpPassword;
      let sentFolder: string | null = null;
      const folders: Record<string, { uidValidity: string; lastUid: number }> = {};
      try {
        const session = await openImap(input.imap, input.imapPassword, policy);
        try {
          const list = await session.folders();
          sentFolder = list.find((folder) => folder.specialUse === "\\Sent")?.path ?? null;
          for (const path of sentFolder === null ? ["INBOX"] : ["INBOX", sentFolder]) {
            const box = await session.open(path);
            folders[path] = { uidValidity: box.uidValidity, lastUid: Math.max(0, box.uidNext - 1) };
          }
        } finally {
          await session.close();
        }
        await checkSmtp(input.smtp, smtpPassword, policy);
      } catch (error) {
        if (error instanceof MailHostError) throw error;
        if (error instanceof MailServerError) {
          throw new ValidationError(
            error.authFailed
              ? `The ${error.provider.toUpperCase()} server refused the user name or password.`
              : `The ${error.provider.toUpperCase()} server could not be reached: ${error.message}`,
            { details: { protocol: error.provider, authFailed: error.authFailed } },
          );
        }
        throw error;
      }
      const credentials: PasswordCredentials = {
        kind: "password",
        imapPassword: input.imapPassword,
        smtpPassword,
      };
      const connectionId = await scope(tenant)
        .run((ctx) =>
          upsert(ctx, {
            address,
            displayName: input.displayName ?? address,
            config: (current): ImapConfig => ({
              provider: "imap",
              address,
              displayName: input.displayName,
              loopToken: loopToken(current),
              imap: input.imap,
              smtp: input.smtp,
              sentFolder,
              appendSent: true,
            }),
            state: (current) => ({ ...current, imap: { folders }, lastSyncError: null }),
            credentials,
            userId,
          }),
        )
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw conflict();
          throw error;
        });
      log.info("email.connected", {
        businessId: tenant.businessId,
        connectionId,
        provider: "imap",
      });
      return viewOf(tenant, connectionId);
    },

    /** Reads the inbox now (the admin panel's "check for new mail"). */
    async syncNow(tenant: BusinessTenant, connectionId: ChannelConnectionId): Promise<void> {
      await viewOf(tenant, connectionId);
      const minute = Math.floor(clock().getTime() / 60_000);
      await deps.events.send([
        emailSyncEvent(
          { ...tenant, connectionId },
          "connect",
          `email-manual-${connectionId}-${minute}`,
        ),
      ]);
    },

    /**
     * Switches an inbox off: no more mail is read or sent, push is stopped, the Google token
     * revoked, and the credentials deleted. The row stays while conversations refer to it.
     */
    async disconnect(tenant: BusinessTenant, connectionId: ChannelConnectionId): Promise<void> {
      const found = await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .select({ id: channelConnections.id, config: channelConnections.config })
          .from(channelConnections)
          .where(
            and(eq(channelConnections.id, connectionId), eq(channelConnections.channel, "email")),
          )
          .limit(1);
        if (row === undefined) return null;
        const credentials = await deps.db.secrets.channel.read(ctx, row.id, EmailCredentials);
        return { config: EmailConnectionConfig.safeParse(row.config).data ?? null, credentials };
      });
      if (found === null) throw new NotFoundError("Connection not found.");
      const token = found.credentials?.kind === "oauth" ? found.credentials.accessToken : null;
      await stopPush(deps, { ...tenant, connectionId }, token);
      if (found.config?.provider === "gmail" && found.credentials?.kind === "oauth") {
        const revoke = found.credentials.refreshToken ?? found.credentials.accessToken;
        await revokeGoogleToken(deps.fetch, revoke).catch(() => undefined);
      }
      await scope(tenant).run(async (ctx) => {
        await ctx.tx
          .update(channelConnections)
          .set({ status: "disabled", state: sql`${channelConnections.state} - 'subscriptionId'` })
          .where(eq(channelConnections.id, connectionId));
        await deps.db.secrets.channel.remove(ctx, connectionId);
      });
      log.info("email.disconnected", { businessId: tenant.businessId, connectionId });
    },
  };
}

export type EmailConnectionService = ReturnType<typeof createEmailConnectionService>;
