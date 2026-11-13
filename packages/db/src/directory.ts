import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  AgencyId,
  BusinessId,
  ChannelConnectionId,
  ChannelId,
  IntegrationConnectionId,
  UserId,
} from "@repo/core";

import { hashApiKey, looksLikeApiKey } from "./api-keys";
import type { Connection } from "./internal/client";
import {
  alerts,
  apiKeys,
  businesses,
  channelConnections,
  escalations,
  integrationConnections,
  users,
} from "./schema/tables";
import type { BusinessStatus, ConnectionStatus } from "./schema/vocab";

/*
 * CROSS-TENANT CODE. Everything here runs on the unrestricted connection, outside row-level
 * security, because it answers a question that has no tenant yet: which tenant does this
 * webhook, API key or cron tick belong to?
 *
 * Rules for this file (and for anything a later chunk adds to it):
 * - look up by an exact key and return ids and classifications, never customer content;
 * - never take a tenant id from the caller and trust it: the answer IS the tenant;
 * - writes are limited to bookkeeping on the row that was looked up;
 * - the caller continues inside `forBusiness()` / `forAgency()` with the ids it got.
 */

export interface TenantRef {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
}

export interface BusinessRef extends TenantRef {
  readonly status: BusinessStatus;
}

export interface ChannelConnectionRef extends TenantRef {
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelId;
  readonly status: ConnectionStatus;
  readonly businessStatus: BusinessStatus;
}

export interface IntegrationConnectionRef extends TenantRef {
  readonly connectionId: IntegrationConnectionId;
  readonly provider: string;
  readonly status: ConnectionStatus;
  readonly businessStatus: BusinessStatus;
}

/** An alert found by an acknowledgement link or a provider callback (C13). */
export interface AlertRef extends TenantRef {
  readonly alertId: string;
}

export interface ApiKeyRef {
  readonly id: string;
  readonly agencyId: AgencyId;
  /** Null for an agency-wide key. */
  readonly businessId: BusinessId | null;
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface Directory {
  /**
   * Maps the receiving account of a webhook to its tenant (ARCHITECTURE §2, step 4). This
   * is the only place an unauthenticated request is turned into a tenant.
   */
  findChannelConnection(
    channel: ChannelId,
    externalAccountId: string,
  ): Promise<ChannelConnectionRef | null>;

  /**
   * The connections under one provider account group, for provider events that name the
   * group rather than a connection (C9: a WhatsApp Business Account's template and account
   * updates; it can hold several connected numbers, possibly of different businesses).
   * Matches `config.businessAccountId`, which only a connect flow writes.
   */
  findChannelConnectionsByBusinessAccount(
    channel: ChannelId,
    businessAccountId: string,
  ): Promise<ChannelConnectionRef[]>;

  /**
   * The connection a provider subscription belongs to (C11: a Microsoft Graph change
   * notification names its subscription). Matches `state.subscriptionId`, which only the
   * channel's own connect and renew code writes; the index makes it unique per channel.
   */
  findChannelConnectionBySubscription(
    channel: ChannelId,
    subscriptionId: string,
  ): Promise<ChannelConnectionRef | null>;

  /**
   * The integration connection whose webhook URL carries this key (C12: Calendly posts to
   * `/api/webhooks/calendly/{key}`). Matches `config.webhookKey`, which only the connect flow
   * writes; the index makes it unique per provider. The caller still verifies the request
   * with that connection's signing key before it trusts anything in it.
   */
  findIntegrationConnectionByWebhookKey(
    provider: string,
    webhookKey: string,
  ): Promise<IntegrationConnectionRef | null>;

  /**
   * The tenant of an alert (C13), for the requests that name one without a session: the
   * acknowledgement link of an emergency alert, Twilio's callbacks for a text message or a
   * call. The caller still checks the request (the link's secret against the stored hash,
   * Twilio's signature) inside the tenant before it trusts or changes anything.
   */
  findAlert(alertId: string): Promise<AlertRef | null>;

  /**
   * Emergency alerts sent to this number whose chain is still active (C13): a reply to the
   * text message (with the alert's code) acknowledges the emergency. Matched by the exact
   * recipient number; the caller checks the code inside each tenant.
   */
  findActiveEmergencyAlertsByRecipient(recipient: string): Promise<AlertRef[]>;

  /** The agency of a business, for callers that hold only a business id. */
  findBusiness(businessId: BusinessId): Promise<BusinessRef | null>;

  /** Tenants for a cron run to visit, oldest first. Default: active businesses only. */
  listBusinesses(filter?: {
    readonly statuses?: readonly BusinessStatus[];
    readonly agencyId?: AgencyId;
  }): Promise<BusinessRef[]>;

  /**
   * Checks a presented API key. Returns the key's tenant when the key exists, is not
   * revoked and has not expired, and records the use; otherwise null.
   */
  authenticateApiKey(presentedKey: string, now?: Date): Promise<ApiKeyRef | null>;

  /** Finds a profile by email address, for invitations and the admin scripts. */
  findUserByEmail(email: string): Promise<{ readonly id: UserId; readonly email: string } | null>;

  /**
   * The estimated model spend of a whole agency since `since`, in millionths of a dollar,
   * for the agency-wide spend cap (C17, `limits.agency_daily_spend_usd`). One number, no
   * rows: calls of turns that escalated an emergency are left out (life-safety answers never
   * count against a cap). The caller passes the agency it is already confined to.
   */
  agencyModelSpendSince(agencyId: AgencyId, since: Date): Promise<number>;
}

export function createDirectory(connection: Connection): Directory {
  const { db } = connection;

  return {
    async findChannelConnection(channel, externalAccountId) {
      const rows = await db
        .select({
          connectionId: channelConnections.id,
          agencyId: channelConnections.agencyId,
          businessId: channelConnections.businessId,
          channel: channelConnections.channel,
          status: channelConnections.status,
          businessStatus: businesses.status,
        })
        .from(channelConnections)
        .innerJoin(businesses, eq(businesses.id, channelConnections.businessId))
        .where(
          and(
            eq(channelConnections.channel, channel),
            eq(channelConnections.externalAccountId, externalAccountId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findChannelConnectionsByBusinessAccount(channel, businessAccountId) {
      if (businessAccountId.length === 0) return [];
      return db
        .select({
          connectionId: channelConnections.id,
          agencyId: channelConnections.agencyId,
          businessId: channelConnections.businessId,
          channel: channelConnections.channel,
          status: channelConnections.status,
          businessStatus: businesses.status,
        })
        .from(channelConnections)
        .innerJoin(businesses, eq(businesses.id, channelConnections.businessId))
        .where(
          and(
            eq(channelConnections.channel, channel),
            sql`(${channelConnections.config} ->> 'businessAccountId') = ${businessAccountId}`,
          ),
        )
        .orderBy(channelConnections.createdAt)
        .limit(100);
    },

    async findChannelConnectionBySubscription(channel, subscriptionId) {
      if (subscriptionId.length === 0) return null;
      const rows = await db
        .select({
          connectionId: channelConnections.id,
          agencyId: channelConnections.agencyId,
          businessId: channelConnections.businessId,
          channel: channelConnections.channel,
          status: channelConnections.status,
          businessStatus: businesses.status,
        })
        .from(channelConnections)
        .innerJoin(businesses, eq(businesses.id, channelConnections.businessId))
        .where(
          and(
            eq(channelConnections.channel, channel),
            sql`(${channelConnections.state} ->> 'subscriptionId') = ${subscriptionId}`,
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntegrationConnectionByWebhookKey(provider, webhookKey) {
      if (webhookKey.length === 0) return null;
      const rows = await db
        .select({
          connectionId: integrationConnections.id,
          agencyId: integrationConnections.agencyId,
          businessId: integrationConnections.businessId,
          provider: integrationConnections.provider,
          status: integrationConnections.status,
          businessStatus: businesses.status,
        })
        .from(integrationConnections)
        .innerJoin(businesses, eq(businesses.id, integrationConnections.businessId))
        .where(
          and(
            eq(integrationConnections.provider, provider),
            sql`(${integrationConnections.config} ->> 'webhookKey') = ${webhookKey}`,
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findAlert(alertId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alertId)) {
        return null;
      }
      const rows = await db
        .select({ alertId: alerts.id, agencyId: alerts.agencyId, businessId: alerts.businessId })
        .from(alerts)
        .where(eq(alerts.id, alertId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveEmergencyAlertsByRecipient(recipient) {
      if (recipient.length === 0) return [];
      return db
        .select({ alertId: alerts.id, agencyId: alerts.agencyId, businessId: alerts.businessId })
        .from(alerts)
        .innerJoin(
          escalations,
          and(
            eq(escalations.id, alerts.escalationId),
            eq(escalations.businessId, alerts.businessId),
          ),
        )
        .where(
          and(
            eq(alerts.recipient, recipient),
            sql`${alerts.ackCodeHash} is not null`,
            eq(escalations.status, "active"),
          ),
        )
        .limit(20);
    },

    async findBusiness(businessId) {
      const rows = await db
        .select({
          agencyId: businesses.agencyId,
          businessId: businesses.id,
          status: businesses.status,
        })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listBusinesses(filter = {}) {
      const statuses = filter.statuses ?? ["active"];
      if (statuses.length === 0) return [];
      return db
        .select({
          agencyId: businesses.agencyId,
          businessId: businesses.id,
          status: businesses.status,
        })
        .from(businesses)
        .where(
          and(
            inArray(businesses.status, [...statuses]),
            filter.agencyId === undefined ? undefined : eq(businesses.agencyId, filter.agencyId),
          ),
        )
        .orderBy(businesses.createdAt, businesses.id);
    },

    async authenticateApiKey(presentedKey, now = new Date()) {
      if (!looksLikeApiKey(presentedKey)) return null;
      const rows = await db
        .select({
          id: apiKeys.id,
          agencyId: apiKeys.agencyId,
          businessId: apiKeys.businessId,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashApiKey(presentedKey)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      if (row.revokedAt !== null) return null;
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;
      await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
      return {
        id: row.id,
        agencyId: row.agencyId,
        businessId: row.businessId,
        name: row.name,
        scopes: row.scopes,
      };
    },

    async agencyModelSpendSince(agencyId, since) {
      const rows = await db.execute(
        sql`select coalesce(sum(mc.cost_micro_usd), 0)::text as total
              from model_calls mc
             where mc.agency_id = ${agencyId}::uuid
               and mc.started_at >= ${since.toISOString()}::timestamptz
               and not exists (
                 select 1 from escalations e
                  where e.agency_id = mc.agency_id and e.trace_id = mc.trace_id
               )`,
      );
      return Number((rows[0] as { total?: string } | undefined)?.total ?? 0);
    },

    async findUserByEmail(email) {
      const rows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
