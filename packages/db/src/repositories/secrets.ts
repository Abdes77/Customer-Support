import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { ChannelConnectionId, IntegrationConnectionId } from "@repo/core";

import type { BusinessContext } from "../context";
import {
  decryptJson,
  encryptJson,
  type Keyring,
  needsReencryption,
  type SecretBinding,
} from "../crypto/secrets";

/**
 * Stored credentials of a channel or integration connection: one encrypted JSON document per
 * connection (for example `{ accessToken, refreshToken }` or `{ imapPassword, smtpPassword }`).
 *
 * Every method needs a `BusinessContext`, so credentials are reachable from the system scope
 * of the owning business only: there is no policy for signed-in users on these tables, and
 * the envelope is bound to agency, business and connection, so it decrypts nowhere else.
 *
 * Read just in time, in the step that calls the vendor. Never return what `read` gives you
 * from a server action or an API route, and never put it in a job payload or a log line.
 */
export interface SecretStore<TConnectionId extends string> {
  /** Encrypts and stores the credentials, replacing any previous value. */
  write(ctx: BusinessContext, connectionId: TConnectionId, credentials: unknown): Promise<void>;

  /** Decrypts the credentials, or returns null when none are stored. */
  read<T = unknown>(
    ctx: BusinessContext,
    connectionId: TConnectionId,
    schema?: z.ZodType<T>,
  ): Promise<T | null>;

  /**
   * Reads, changes and writes the credentials under a row lock that lasts until the
   * transaction of `ctx` ends, so two jobs cannot refresh the same OAuth token at once: the
   * second waits, then sees the token the first one stored. `change` returns the new value,
   * or `undefined` to leave the stored one as it is.
   */
  update<T = unknown>(
    ctx: BusinessContext,
    connectionId: TConnectionId,
    change: (current: T | null) => unknown,
    schema?: z.ZodType<T>,
  ): Promise<void>;

  /** Deletes the stored credentials (the connection row stays). */
  remove(ctx: BusinessContext, connectionId: TConnectionId): Promise<void>;

  /** Re-encrypts with the primary key if a retired key was used. True when it rewrote. */
  reencrypt(ctx: BusinessContext, connectionId: TConnectionId): Promise<boolean>;
}

export interface SecretStores {
  readonly channel: SecretStore<ChannelConnectionId>;
  readonly integration: SecretStore<IntegrationConnectionId>;
}

type Rows = readonly Record<string, unknown>[];

function createSecretStore<TConnectionId extends string>(
  tableName: "channel_connection_secrets" | "integration_connection_secrets",
  purpose: "channel_connection" | "integration_connection",
  getKeyring: () => Keyring,
): SecretStore<TConnectionId> {
  const table = sql.identifier(tableName);

  const bindingFor = (ctx: BusinessContext, connectionId: string): SecretBinding => ({
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.tenant.businessId,
    purpose,
    recordId: connectionId,
  });

  async function load(
    ctx: BusinessContext,
    connectionId: string,
    lock: boolean,
  ): Promise<string | null> {
    const rows = (await ctx.tx.execute(
      sql`select ciphertext from ${table} where connection_id = ${connectionId}::uuid ${lock ? sql`for update` : sql``}`,
    )) as unknown as Rows;
    return (rows[0]?.["ciphertext"] as string | undefined) ?? null;
  }

  async function store(ctx: BusinessContext, connectionId: string, value: unknown): Promise<void> {
    const keyring = getKeyring();
    const envelope = encryptJson(value, bindingFor(ctx, connectionId), keyring);
    await ctx.tx.execute(sql`
      insert into ${table} (connection_id, agency_id, business_id, ciphertext, key_id)
      values (${connectionId}::uuid, ${ctx.tenant.agencyId}::uuid, ${ctx.tenant.businessId}::uuid,
              ${envelope}, ${keyring.primaryKeyId})
      on conflict (connection_id) do update
        set ciphertext = excluded.ciphertext,
            key_id = excluded.key_id,
            updated_at = now()`);
  }

  return {
    write: (ctx, connectionId, credentials) => store(ctx, connectionId, credentials),

    async read(ctx, connectionId, schema) {
      const envelope = await load(ctx, connectionId, false);
      if (envelope === null) return null;
      return decryptJson(envelope, bindingFor(ctx, connectionId), getKeyring(), schema);
    },

    async update(ctx, connectionId, change, schema) {
      const envelope = await load(ctx, connectionId, true);
      const current =
        envelope === null
          ? null
          : decryptJson(envelope, bindingFor(ctx, connectionId), getKeyring(), schema);
      const next: unknown = await change(current);
      if (next !== undefined) await store(ctx, connectionId, next);
    },

    async remove(ctx, connectionId) {
      await ctx.tx.execute(sql`delete from ${table} where connection_id = ${connectionId}::uuid`);
    },

    async reencrypt(ctx, connectionId) {
      const envelope = await load(ctx, connectionId, true);
      const keyring = getKeyring();
      if (envelope === null || !needsReencryption(envelope, keyring)) return false;
      await store(ctx, connectionId, decryptJson(envelope, bindingFor(ctx, connectionId), keyring));
      return true;
    },
  };
}

export function createSecretStores(getKeyring: () => Keyring): SecretStores {
  return {
    channel: createSecretStore("channel_connection_secrets", "channel_connection", getKeyring),
    integration: createSecretStore(
      "integration_connection_secrets",
      "integration_connection",
      getKeyring,
    ),
  };
}
