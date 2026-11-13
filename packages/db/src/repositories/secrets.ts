import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { ChannelConnectionId, IntegrationConnectionId } from "@repo/core";

import type { AgencyContext, BusinessContext, SystemContext } from "../context";
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

/**
 * Secrets that belong to an agency rather than one business (C14: the signing secret of an
 * agency-wide webhook target), in `agency_secrets`, keyed by purpose and name. Any system
 * scope inside the agency may read (a business's delivery job signs with it); only an
 * agency-wide scope writes. The envelope is bound to agency, purpose and name.
 */
export interface AgencySecretStore {
  read<T = unknown>(
    ctx: SystemContext,
    purpose: string,
    name: string,
    schema?: z.ZodType<T>,
  ): Promise<T | null>;
  write(ctx: AgencyContext, purpose: string, name: string, value: unknown): Promise<void>;
  remove(ctx: AgencyContext, purpose: string, name: string): Promise<void>;
}

export interface SecretStores {
  readonly channel: SecretStore<ChannelConnectionId>;
  readonly integration: SecretStore<IntegrationConnectionId>;
  readonly agency: AgencySecretStore;
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

function createAgencySecretStore(getKeyring: () => Keyring): AgencySecretStore {
  const binding = (agencyId: string, purpose: string, name: string): SecretBinding => ({
    agencyId,
    businessId: null,
    purpose: `agency:${purpose}`,
    recordId: name,
  });
  return {
    async read(ctx, purpose, name, schema) {
      const rows = (await ctx.tx.execute(
        sql`select ciphertext from agency_secrets where agency_id = ${ctx.tenant.agencyId}::uuid and purpose = ${purpose} and name = ${name}`,
      )) as unknown as Rows;
      const envelope = (rows[0]?.["ciphertext"] as string | undefined) ?? null;
      if (envelope === null) return null;
      return decryptJson(
        envelope,
        binding(ctx.tenant.agencyId, purpose, name),
        getKeyring(),
        schema,
      );
    },
    async write(ctx, purpose, name, value) {
      const keyring = getKeyring();
      const envelope = encryptJson(value, binding(ctx.tenant.agencyId, purpose, name), keyring);
      await ctx.tx.execute(sql`
        insert into agency_secrets (agency_id, purpose, name, ciphertext, key_id)
        values (${ctx.tenant.agencyId}::uuid, ${purpose}, ${name}, ${envelope}, ${keyring.primaryKeyId})
        on conflict (agency_id, purpose, name) do update
          set ciphertext = excluded.ciphertext,
              key_id = excluded.key_id,
              updated_at = now()`);
    },
    async remove(ctx, purpose, name) {
      await ctx.tx.execute(
        sql`delete from agency_secrets where agency_id = ${ctx.tenant.agencyId}::uuid and purpose = ${purpose} and name = ${name}`,
      );
    },
  };
}

export function createSecretStores(getKeyring: () => Keyring): SecretStores {
  return {
    agency: createAgencySecretStore(getKeyring),
    channel: createSecretStore("channel_connection_secrets", "channel_connection", getKeyring),
    integration: createSecretStore(
      "integration_connection_secrets",
      "integration_connection",
      getKeyring,
    ),
  };
}
