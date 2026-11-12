import { and, eq, inArray, sql } from "drizzle-orm";

import type { AgencyId, BusinessId, ChannelConnectionId, ChannelId, UserId } from "@repo/core";

import { hashApiKey, looksLikeApiKey } from "./api-keys";
import type { Connection } from "./internal/client";
import { apiKeys, businesses, channelConnections, users } from "./schema/tables";
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
