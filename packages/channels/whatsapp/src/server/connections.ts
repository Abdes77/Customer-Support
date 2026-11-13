import { randomInt } from "node:crypto";

import { z } from "zod";

import { exchangeCode, GraphApiError } from "@repo/channel-meta";
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
  isUniqueViolation,
  messageTemplates,
} from "@repo/db";

import { GraphId, WhatsAppConfig, WhatsAppCredentials } from "../credentials";
import type { WhatsAppServerDeps } from "./deps";
import { createTemplateService } from "./templates";

/*
 * Connecting a number (Embedded Signup, developers.facebook.com/documentation/
 * business-messaging/whatsapp/embedded-signup, read 2026-11-12):
 *
 * 1. In the browser (C16's page), `FB.login` with the signup configuration id,
 *    `response_type: "code"`, `override_default_response_type: true`, `extras: { setup: {} }`.
 *    A `message` event from facebook.com of type `WA_EMBEDDED_SIGNUP` with event `FINISH`
 *    carries `phone_number_id`, `waba_id` and `business_id`; the login callback carries the
 *    code (valid for 30 seconds).
 * 2. The page posts the three to `POST /api/oauth/meta/whatsapp`, which calls
 *    `completeEmbeddedSignup` here: exchange the code for the business token, check that the
 *    number belongs to that account as seen with that token (the proof of control), subscribe
 *    the app to the account's webhooks, register the number for the Cloud API with a random
 *    two-step PIN, then store the connection and the encrypted `{ accessToken, pin }`.
 */

export const EmbeddedSignupInput = z.object({
  code: z.string().min(1).max(2000),
  businessAccountId: GraphId,
  phoneNumberId: GraphId,
  businessPortfolioId: GraphId.nullable().default(null),
});
export type EmbeddedSignupInput = z.input<typeof EmbeddedSignupInput>;

const PhoneNumber = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    display_phone_number: z.string().optional(),
    verified_name: z.string().optional(),
    quality_rating: z.string().optional(),
  })
  .passthrough();

const PhoneNumbers = z.object({ data: z.array(PhoneNumber) });
const Success = z.object({ success: z.boolean() }).passthrough();

/** What the admin panel shows of a connected number. Never a token or the PIN. */
export interface WhatsAppConnectionView {
  readonly connectionId: ChannelConnectionId;
  readonly status: string;
  readonly phoneNumberId: string;
  readonly businessAccountId: string | null;
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
  readonly qualityRating: string | null;
  readonly lastError: string | null;
  readonly connectedAt: string | null;
  readonly templates: {
    readonly approved: number;
    readonly pending: number;
    readonly other: number;
  };
}

/** The public values the browser needs to open Embedded Signup. */
export interface EmbeddedSignupConfig {
  readonly appId: string;
  readonly configId: string;
  readonly graphApiVersion: string;
}

export function createConnectionService(deps: WhatsAppServerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const templates = createTemplateService(deps);
  const log = deps.logger.child({ component: "whatsapp-connect" });
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  async function views(ctx: BusinessContext): Promise<WhatsAppConnectionView[]> {
    const rows = await ctx.tx
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channel, "whatsapp"))
      .orderBy(channelConnections.createdAt);
    const counts = await ctx.tx
      .select({
        connectionId: messageTemplates.channelConnectionId,
        status: messageTemplates.status,
      })
      .from(messageTemplates);
    return rows.map((row) => {
      const config = WhatsAppConfig.safeParse(row.config);
      const mine = counts.filter((item) => item.connectionId === row.id);
      return {
        connectionId: row.id,
        status: row.status,
        phoneNumberId: row.externalAccountId,
        businessAccountId: config.success ? config.data.businessAccountId : null,
        displayPhoneNumber: config.success ? config.data.displayPhoneNumber : row.displayName,
        verifiedName: config.success ? config.data.verifiedName : null,
        qualityRating: config.success ? config.data.qualityRating : null,
        lastError: row.lastError,
        connectedAt: row.connectedAt?.toISOString() ?? null,
        templates: {
          approved: mine.filter((item) => item.status === "approved").length,
          pending: mine.filter((item) => item.status === "pending").length,
          other: mine.filter((item) => item.status !== "approved" && item.status !== "pending")
            .length,
        },
      };
    });
  }

  return {
    templates,

    /** Null when the deployment has no Meta app or signup configuration. */
    signupConfig(): EmbeddedSignupConfig | null {
      if (deps.app == null || deps.signupConfigId == null) return null;
      return {
        appId: deps.app.appId,
        configId: deps.signupConfigId,
        graphApiVersion: deps.graph.version,
      };
    },

    /** The business's WhatsApp numbers, for the connection page (C16). */
    async list(tenant: BusinessTenant): Promise<WhatsAppConnectionView[]> {
      return scope(tenant).run((ctx) => views(ctx));
    },

    /**
     * Finishes Embedded Signup for a business. Call it only after checking that the user may
     * manage this business's channels (agency staff).
     */
    async completeEmbeddedSignup(
      tenant: BusinessTenant,
      userId: UserId | null,
      raw: EmbeddedSignupInput,
    ): Promise<WhatsAppConnectionView> {
      const app = deps.app;
      if (app == null) {
        throw new ConfigError("WhatsApp is not configured: set META_APP_ID and META_APP_SECRET.");
      }
      const input = EmbeddedSignupInput.parse(raw);

      // A number belongs to one business: refuse before touching Meta if another has it.
      const owner = await deps.db.directory.findChannelConnection("whatsapp", input.phoneNumberId);
      if (owner !== null && owner.businessId !== tenant.businessId) {
        throw new AppError("conflict", "This WhatsApp number is connected to another business.", {
          retryable: false,
        });
      }

      const { accessToken } = await exchangeCode(deps.graph, {
        appId: app.appId,
        appSecret: app.appSecret,
        code: input.code,
      });
      const numbers = await deps.graph.request(
        {
          method: "GET",
          path: `/${input.businessAccountId}/phone_numbers`,
          token: accessToken,
          query: { fields: "id,display_phone_number,verified_name,quality_rating" },
        },
        PhoneNumbers,
      );
      const number = numbers.data.find((item) => item.id === input.phoneNumberId);
      if (number === undefined) {
        throw new ValidationError("This phone number is not part of the WhatsApp account.");
      }
      await deps.graph.request(
        {
          method: "POST",
          path: `/${input.businessAccountId}/subscribed_apps`,
          token: accessToken,
        },
        Success,
      );

      // Reconnecting a number of this business keeps its PIN: a registered number refuses
      // a new one.
      const previous = await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .select({ id: channelConnections.id })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, "whatsapp"),
              eq(channelConnections.externalAccountId, input.phoneNumberId),
            ),
          )
          .limit(1);
        if (row === undefined) return null;
        return deps.db.secrets.channel.read(ctx, row.id, WhatsAppCredentials);
      });
      const pin = previous?.pin ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
      let registerError: string | null = null;
      try {
        await deps.graph.request(
          {
            method: "POST",
            path: `/${input.phoneNumberId}/register`,
            token: accessToken,
            json: { messaging_product: "whatsapp", pin },
          },
          Success,
        );
      } catch (error) {
        if (!(error instanceof GraphApiError)) throw error;
        // The connection is stored anyway, marked with the problem, so the admin panel can
        // show it and the agency can fix it in WhatsApp Manager and reconnect.
        registerError = `Registering the number failed: ${error.message}`.slice(0, 500);
        log.warn("whatsapp.register_failed", {
          businessId: tenant.businessId,
          graphCode: error.graphCode,
        });
      }

      const config: WhatsAppConfig = {
        businessAccountId: input.businessAccountId,
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: number.display_phone_number ?? null,
        verifiedName: number.verified_name ?? null,
        businessPortfolioId: input.businessPortfolioId,
        qualityRating: number.quality_rating ?? null,
      };
      const now = clock();
      const connectionId = await scope(tenant)
        .run(async (ctx) => {
          const values = {
            displayName: config.displayPhoneNumber ?? config.phoneNumberId,
            status: registerError === null ? ("active" as const) : ("error" as const),
            config,
            lastError: registerError,
            lastErrorAt: registerError === null ? null : now,
            connectedBy: userId,
            connectedAt: now,
          };
          const [row] = await ctx.tx
            .insert(channelConnections)
            .values({
              ...ctx.tenant,
              channel: "whatsapp",
              externalAccountId: input.phoneNumberId,
              ...values,
            })
            .onConflictDoUpdate({
              target: [channelConnections.channel, channelConnections.externalAccountId],
              set: values,
              // Never take over another tenant's row (RLS would refuse it too).
              setWhere: eq(channelConnections.businessId, ctx.tenant.businessId),
            })
            .returning({ id: channelConnections.id });
          if (row === undefined) {
            throw new AppError(
              "conflict",
              "This WhatsApp number is connected to another business.",
              {
                retryable: false,
              },
            );
          }
          await deps.db.secrets.channel.write(ctx, row.id, { accessToken, pin });
          return row.id;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new AppError(
              "conflict",
              "This WhatsApp number is connected to another business.",
              { retryable: false },
            );
          }
          throw error;
        });
      log.info("whatsapp.connected", {
        businessId: tenant.businessId,
        connectionId,
        registered: registerError === null,
      });

      try {
        await templates.sync(tenant, connectionId);
      } catch (error) {
        log.warn("whatsapp.template_sync_failed", { businessId: tenant.businessId, error });
      }
      const all = await scope(tenant).run((ctx) => views(ctx));
      return all.find((item) => item.connectionId === connectionId)!;
    },

    /**
     * Switches a number off: no more messages are stored or sent, and its token is deleted.
     * The row stays while conversations refer to it.
     */
    async disconnect(tenant: BusinessTenant, connectionId: string): Promise<void> {
      await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .update(channelConnections)
          .set({ status: "disabled" })
          .where(
            and(
              eq(channelConnections.id, connectionId as ChannelConnectionId),
              eq(channelConnections.channel, "whatsapp"),
            ),
          )
          .returning({ id: channelConnections.id });
        if (row === undefined) throw new NotFoundError("WhatsApp connection not found.");
        await deps.db.secrets.channel.remove(ctx, row.id);
      });
    },
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
