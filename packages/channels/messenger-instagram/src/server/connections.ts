import { z } from "zod";

import { exchangeCode, exchangeForLongLivedToken, GraphApiError } from "@repo/channel-meta";
import {
  AppError,
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
  inArray,
  isUniqueViolation,
  ne,
} from "@repo/db";

import { GraphId, MetaPageConfig, MetaPageCredentials } from "../credentials";
import type { MetaMessagingChannel } from "../webhook";
import type { MetaPagesServerDeps } from "./deps";

/*
 * Connecting a Facebook Page and its Instagram account (Facebook Login for Business,
 * developers.facebook.com/documentation/facebook-login/facebook-login-for-business and the
 * Messenger Platform webhook setup, read 2026-11-12):
 *
 * 1. In the browser (C16's page), `FB.login` with the configuration id, `response_type:
 *    "code"` and `override_default_response_type: true`. The person picks the Pages (and the
 *    Instagram accounts) the app may use; the callback carries a code (valid for a short
 *    while, used once).
 * 2. The page posts the code, and the Page when it knows it, to `POST
 *    /api/oauth/meta/facebook`, which calls `completeFacebookLogin` here: exchange the code
 *    (a business integration system user token does not expire; a user token is made
 *    long-lived first, so the Page token read with it does not expire either), read the
 *    Pages the login granted (`/me/accounts`, with each Page's token and linked Instagram
 *    account) — being in that list is the proof that the person controls the Page —,
 *    subscribe the app to the Page's messaging webhooks, then store one connection per
 *    channel, each with the Page token encrypted.
 * 3. When the login granted several Pages and none was named, nothing is stored and the
 *    choice comes back; the page asks which one and runs the login again with it (the code
 *    cannot be used twice, and the token is never kept between requests or sent to the
 *    browser).
 */

export const FacebookLoginInput = z.object({
  code: z.string().min(1).max(2000),
  pageId: GraphId.nullable().default(null),
  /** Which channels to connect for the Page (both by default). */
  channels: z
    .array(z.enum(["messenger", "instagram"]))
    .min(1)
    .max(2)
    .default(["messenger", "instagram"]),
});
export type FacebookLoginInput = z.input<typeof FacebookLoginInput>;

/** The webhook fields the Page is subscribed to (Messenger Platform field list). */
export const PAGE_SUBSCRIBED_FIELDS = [
  "messages",
  "message_echoes",
  "message_deliveries",
  "message_reads",
  "message_reactions",
  "messaging_postbacks",
  "messaging_referrals",
  "messaging_policy_enforcement",
  "standby",
] as const;

/** Tasks that let the Page's token send messages (the Page roles of the person). */
const MESSAGING_TASKS = new Set(["MESSAGING", "MODERATE", "MANAGE"]);

const Page = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().optional(),
    access_token: z.string().min(1).optional(),
    tasks: z.array(z.string()).optional(),
    instagram_business_account: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        username: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type Page = z.infer<typeof Page>;

const Pages = z.object({ data: z.array(Page) }).passthrough();
const Success = z.object({ success: z.union([z.boolean(), z.string()]) }).passthrough();

/** What the admin panel shows of a connected Page or Instagram account. Never a token. */
export interface MetaConnectionView {
  readonly connectionId: ChannelConnectionId;
  readonly channel: MetaMessagingChannel;
  readonly status: string;
  readonly pageId: string;
  readonly pageName: string | null;
  readonly instagramAccountId: string | null;
  readonly instagramUsername: string | null;
  readonly lastError: string | null;
  readonly connectedAt: string | null;
}

/** A Page the login granted, for the choice when there are several. */
export interface PageChoice {
  readonly pageId: string;
  readonly name: string | null;
  readonly instagramUsername: string | null;
  readonly hasInstagram: boolean;
  /** False when the person's role on the Page cannot send messages. */
  readonly canMessage: boolean;
}

export type FacebookLoginResult =
  | { readonly outcome: "connected"; readonly connections: readonly MetaConnectionView[] }
  | { readonly outcome: "choose_page"; readonly pages: readonly PageChoice[] };

/** The public values the browser needs to open Facebook Login for Business. */
export interface FacebookLoginConfig {
  readonly appId: string;
  readonly configId: string;
  readonly graphApiVersion: string;
}

const CHANNELS: readonly MetaMessagingChannel[] = ["messenger", "instagram"];

function canMessage(page: Page): boolean {
  return page.tasks === undefined || page.tasks.some((task) => MESSAGING_TASKS.has(task));
}

function conflict(channel: MetaMessagingChannel): AppError {
  return new AppError(
    "conflict",
    channel === "messenger"
      ? "This Facebook Page is connected to another business."
      : "This Instagram account is connected to another business.",
    { retryable: false },
  );
}

export function createMetaPagesService(deps: MetaPagesServerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({ component: "meta-pages-connect" });
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  async function views(ctx: BusinessContext): Promise<MetaConnectionView[]> {
    const rows = await ctx.tx
      .select()
      .from(channelConnections)
      .where(inArray(channelConnections.channel, [...CHANNELS]))
      .orderBy(channelConnections.createdAt);
    return rows.map((row) => {
      const config = MetaPageConfig.safeParse(row.config);
      return {
        connectionId: row.id,
        channel: row.channel as MetaMessagingChannel,
        status: row.status,
        pageId: config.success ? config.data.pageId : row.externalAccountId,
        pageName: config.success ? config.data.pageName : row.displayName,
        instagramAccountId: config.success ? config.data.instagramAccountId : null,
        instagramUsername: config.success ? config.data.instagramUsername : null,
        lastError: row.lastError,
        connectedAt: row.connectedAt?.toISOString() ?? null,
      };
    });
  }

  /** Refuses an account another business has, before anything is asked of Meta. */
  async function assertFree(
    tenant: BusinessTenant,
    channel: MetaMessagingChannel,
    externalAccountId: string,
  ): Promise<void> {
    const owner = await deps.db.directory.findChannelConnection(channel, externalAccountId);
    if (owner !== null && owner.businessId !== tenant.businessId) throw conflict(channel);
  }

  async function grantedPages(token: string): Promise<Page[]> {
    const pages = await deps.graph.request(
      {
        method: "GET",
        path: "/me/accounts",
        token,
        query: {
          fields: "id,name,access_token,tasks,instagram_business_account{id,username}",
          limit: 100,
        },
      },
      Pages,
    );
    return pages.data;
  }

  return {
    /** Null when the deployment has no Meta app or login configuration. */
    loginConfig(): FacebookLoginConfig | null {
      if (deps.app == null || deps.loginConfigId == null) return null;
      return {
        appId: deps.app.appId,
        configId: deps.loginConfigId,
        graphApiVersion: deps.graph.version,
      };
    },

    /** The business's Messenger and Instagram connections, for the connection page (C16). */
    async list(tenant: BusinessTenant): Promise<MetaConnectionView[]> {
      return scope(tenant).run((ctx) => views(ctx));
    },

    /**
     * Finishes Facebook Login for a business. Call it only after checking that the user may
     * manage this business's channels (agency staff).
     */
    async completeFacebookLogin(
      tenant: BusinessTenant,
      userId: UserId | null,
      raw: FacebookLoginInput,
    ): Promise<FacebookLoginResult> {
      const app = deps.app;
      if (app == null) {
        throw new ConfigError(
          "Messenger and Instagram are not configured: set META_APP_ID and META_APP_SECRET.",
        );
      }
      const input = FacebookLoginInput.parse(raw);
      const wanted = new Set(input.channels);
      // A Page belongs to one business, also when only its Instagram account is connected:
      // both connections send with the Page's token and share its webhook subscription.
      if (input.pageId !== null) await assertFree(tenant, "messenger", input.pageId);

      const exchanged = await exchangeCode(deps.graph, {
        appId: app.appId,
        appSecret: app.appSecret,
        code: input.code,
      });
      const token =
        exchanged.expiresInSeconds === null
          ? exchanged.accessToken
          : (
              await exchangeForLongLivedToken(deps.graph, {
                appId: app.appId,
                appSecret: app.appSecret,
                token: exchanged.accessToken,
              })
            ).accessToken;
      const pages = await grantedPages(token);
      if (pages.length === 0) {
        throw new ValidationError("The login did not share any Facebook Page with the app.");
      }
      let page: Page | undefined;
      if (input.pageId === null) {
        if (pages.length > 1) {
          return {
            outcome: "choose_page",
            pages: pages.map((item) => ({
              pageId: item.id,
              name: item.name ?? null,
              instagramUsername: item.instagram_business_account?.username ?? null,
              hasInstagram: item.instagram_business_account !== undefined,
              canMessage: canMessage(item),
            })),
          };
        }
        page = pages[0];
      } else {
        page = pages.find((item) => item.id === input.pageId);
      }
      if (page === undefined) {
        throw new ValidationError("This Facebook Page was not shared during the login.");
      }
      if (!canMessage(page) || page.access_token === undefined) {
        throw new ValidationError("Your role on this Facebook Page cannot send messages.");
      }
      const instagram = page.instagram_business_account ?? null;
      if (wanted.has("instagram") && instagram === null && !wanted.has("messenger")) {
        throw new ValidationError(
          "This Facebook Page has no linked Instagram professional account.",
        );
      }
      // The Page and its Instagram account go together: either one held by another business
      // refuses both (a disconnect there would otherwise unsubscribe the Page from under it).
      await assertFree(tenant, "messenger", page.id);
      if (instagram !== null) await assertFree(tenant, "instagram", instagram.id);
      const pageToken = page.access_token;

      await deps.graph.request(
        {
          method: "POST",
          path: `/${page.id}/subscribed_apps`,
          token: pageToken,
          query: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS.join(",") },
        },
        Success,
      );

      const now = clock();
      const accounts: { channel: MetaMessagingChannel; externalAccountId: string }[] = [];
      if (wanted.has("messenger"))
        accounts.push({ channel: "messenger", externalAccountId: page.id });
      if (wanted.has("instagram") && instagram !== null) {
        accounts.push({ channel: "instagram", externalAccountId: instagram.id });
      }
      const config: MetaPageConfig = {
        pageId: page.id,
        pageName: page.name ?? null,
        instagramAccountId: instagram?.id ?? null,
        instagramUsername: instagram?.username ?? null,
      };
      const credentials: MetaPageCredentials = { pageAccessToken: pageToken };
      const connectionIds = await scope(tenant)
        .run(async (ctx) => {
          const ids: ChannelConnectionId[] = [];
          for (const account of accounts) {
            const values = {
              displayName:
                account.channel === "instagram" && config.instagramUsername !== null
                  ? `@${config.instagramUsername}`
                  : (config.pageName ?? account.externalAccountId),
              status: "active" as const,
              config,
              lastError: null,
              lastErrorAt: null,
              connectedBy: userId,
              connectedAt: now,
            };
            const [row] = await ctx.tx
              .insert(channelConnections)
              .values({
                ...ctx.tenant,
                channel: account.channel,
                externalAccountId: account.externalAccountId,
                ...values,
              })
              .onConflictDoUpdate({
                target: [channelConnections.channel, channelConnections.externalAccountId],
                set: values,
                // Never take over another tenant's row (RLS would refuse it too).
                setWhere: eq(channelConnections.businessId, ctx.tenant.businessId),
              })
              .returning({ id: channelConnections.id });
            if (row === undefined) throw conflict(account.channel);
            await deps.db.secrets.channel.write(ctx, row.id, credentials);
            ids.push(row.id);
          }
          return ids;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw conflict(accounts[0]?.channel ?? "messenger");
          throw error;
        });
      log.info("meta_pages.connected", {
        businessId: tenant.businessId,
        connections: connectionIds,
        channels: accounts.map((account) => account.channel),
      });
      const all = await scope(tenant).run((ctx) => views(ctx));
      return {
        outcome: "connected",
        connections: all.filter((item) => connectionIds.includes(item.connectionId)),
      };
    },

    /**
     * Switches a Page or Instagram account off: no more messages are stored or sent, and its
     * token is deleted. When no other connection of the business uses the Page any more, the
     * app is unsubscribed from its webhooks (best effort). The row stays while conversations
     * refer to it.
     */
    async disconnect(tenant: BusinessTenant, connectionId: string): Promise<void> {
      const unsubscribe = await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .update(channelConnections)
          .set({ status: "disabled" })
          .where(
            and(
              eq(channelConnections.id, connectionId as ChannelConnectionId),
              inArray(channelConnections.channel, [...CHANNELS]),
            ),
          )
          .returning({ id: channelConnections.id, config: channelConnections.config });
        if (row === undefined) throw new NotFoundError("Connection not found.");
        const secret = await deps.db.secrets.channel.read(ctx, row.id, MetaPageCredentials);
        await deps.db.secrets.channel.remove(ctx, row.id);
        const config = MetaPageConfig.safeParse(row.config);
        if (!config.success || secret === null) return null;
        const siblings = await ctx.tx
          .select({ config: channelConnections.config })
          .from(channelConnections)
          .where(
            and(
              inArray(channelConnections.channel, [...CHANNELS]),
              ne(channelConnections.id, row.id),
              // A Page blocked for a while ("error") still needs its webhooks for the unblock.
              inArray(channelConnections.status, ["active", "error", "pending"]),
            ),
          );
        const pageStillUsed = siblings.some(
          (item) => MetaPageConfig.safeParse(item.config).data?.pageId === config.data.pageId,
        );
        return pageStillUsed ? null : { pageId: config.data.pageId, token: secret.pageAccessToken };
      });
      if (unsubscribe === null) return;
      try {
        await deps.graph.request({
          method: "DELETE",
          path: `/${unsubscribe.pageId}/subscribed_apps`,
          token: unsubscribe.token,
        });
      } catch (error) {
        log.warn("meta_pages.unsubscribe_failed", {
          businessId: tenant.businessId,
          graphCode: error instanceof GraphApiError ? error.graphCode : null,
        });
      }
    },
  };
}

export type MetaPagesService = ReturnType<typeof createMetaPagesService>;
