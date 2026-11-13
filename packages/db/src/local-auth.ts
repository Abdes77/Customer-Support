import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";

import { ConfigError, type UserId, ValidationError } from "@repo/core";

import type { Connection } from "./internal/client";
import { SUPABASE_COMPAT_MARKER } from "./supabase-compat";

/*
 * CROSS-TENANT CODE (see directory.ts), for local development and CI only.
 *
 * Production signs users in with Supabase Auth. A plain PostgreSQL database has no auth
 * server, so the compatibility bootstrap creates a small `auth.users` table and this store
 * fills and checks it: enough for the web app's local sign-in provider, the seed and the
 * end-to-end tests. Every method refuses to work on a database that is not marked as
 * bootstrapped, so it can never read or write a real Supabase `auth.users`.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keyLength: number,
) => Promise<Buffer>;

const HASH_BYTES = 32;

export interface LocalAuthUser {
  readonly id: UserId;
  readonly email: string;
  readonly fullName: string | null;
}

export interface LocalAuthStore {
  /** True when the database was set up by the compatibility bootstrap. */
  isAvailable(): Promise<boolean>;
  /** Creates the user, or updates name and password of the user with that email. */
  upsertUser(input: {
    readonly id?: UserId;
    readonly email: string;
    readonly password?: string;
    readonly fullName?: string;
  }): Promise<LocalAuthUser>;
  /** The user when email and password match, otherwise null. */
  verifyPassword(email: string, password: string): Promise<LocalAuthUser | null>;
  findUserByEmail(email: string): Promise<LocalAuthUser | null>;
  findUserById(id: UserId): Promise<LocalAuthUser | null>;
  /** Deletes the auth user; the profile and its memberships go with it. */
  deleteUser(id: UserId): Promise<void>;
}

/** `scrypt$<salt>$<hash>`, both base64url. */
export async function hashLocalPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, HASH_BYTES);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyLocalPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  const [scheme, salt, hash] = (stored ?? "").split("$");
  // Hash even when there is nothing to compare with, so a missing user takes as long as a
  // wrong password.
  const expected =
    scheme === "scrypt" && hash !== undefined ? Buffer.from(hash, "base64url") : null;
  const actual = await scrypt(
    password,
    salt === undefined || expected === null ? Buffer.alloc(16) : Buffer.from(salt, "base64url"),
    HASH_BYTES,
  );
  return expected?.length === actual.length && timingSafeEqual(expected, actual);
}

type Rows = readonly Record<string, unknown>[];

function toUser(row: Record<string, unknown> | undefined): LocalAuthUser | null {
  if (row === undefined) return null;
  return {
    id: row["id"] as UserId,
    email: row["email"] as string,
    fullName: (row["full_name"] as string | null) ?? null,
  };
}

export function createLocalAuthStore(connection: Connection): LocalAuthStore {
  const { db } = connection;
  let available: boolean | undefined;

  async function isAvailable(): Promise<boolean> {
    if (available === undefined) {
      const rows = (await db.execute(sql`
        select d.description as comment
          from pg_catalog.pg_namespace n
          join pg_catalog.pg_description d
            on d.objoid = n.oid and d.classoid = 'pg_catalog.pg_namespace'::regclass
         where n.nspname = 'auth'`)) as unknown as Rows;
      available = rows[0]?.["comment"] === SUPABASE_COMPAT_MARKER;
    }
    return available;
  }

  async function assertAvailable(): Promise<void> {
    if (!(await isAvailable())) {
      throw new ConfigError(
        "Local sign-in works only on a database set up by the Supabase compatibility bootstrap. " +
          "On Supabase, users are managed by Supabase Auth.",
      );
    }
  }

  const SELECT_USER = sql`select u.id, u.email, u.raw_user_meta_data ->> 'full_name' as full_name, u.encrypted_password from auth.users u`;

  return {
    isAvailable,

    async upsertUser(input) {
      await assertAvailable();
      const email = input.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw new ValidationError("That is not an email address.");
      }
      const passwordHash =
        input.password === undefined ? null : await hashLocalPassword(input.password);
      const metadata = JSON.stringify(
        input.fullName === undefined ? {} : { full_name: input.fullName },
      );
      const rows = (await db.execute(sql`
        insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at)
        values (coalesce(${input.id ?? null}::uuid, gen_random_uuid()), ${email}, ${passwordHash}, ${metadata}::jsonb, now())
        on conflict (lower(email)) do update
          set encrypted_password = coalesce(excluded.encrypted_password, auth.users.encrypted_password),
              raw_user_meta_data = auth.users.raw_user_meta_data || excluded.raw_user_meta_data,
              updated_at = now()
        returning id, email, raw_user_meta_data ->> 'full_name' as full_name`)) as unknown as Rows;
      const user = toUser(rows[0]);
      if (user === null) throw new Error("The auth user upsert returned no row.");
      // The trigger copies new users and email changes into public.users; a changed name on
      // an existing user is copied here.
      await db.execute(sql`
        update public.users set full_name = ${user.fullName}, updated_at = now()
         where id = ${user.id}::uuid and full_name is distinct from ${user.fullName}`);
      return user;
    },

    async verifyPassword(email, password) {
      await assertAvailable();
      const rows = (await db.execute(
        sql`${SELECT_USER} where lower(u.email) = ${email.trim().toLowerCase()} limit 1`,
      )) as unknown as Rows;
      const row = rows[0];
      const matches = await verifyLocalPassword(
        password,
        (row?.["encrypted_password"] as string | null | undefined) ?? null,
      );
      if (!matches || row === undefined) return null;
      await db.execute(
        sql`update auth.users set last_sign_in_at = now() where id = ${row["id"] as string}::uuid`,
      );
      return toUser(row);
    },

    async findUserByEmail(email) {
      await assertAvailable();
      const rows = (await db.execute(
        sql`${SELECT_USER} where lower(u.email) = ${email.trim().toLowerCase()} limit 1`,
      )) as unknown as Rows;
      return toUser(rows[0]);
    },

    async findUserById(id) {
      await assertAvailable();
      const rows = (await db.execute(
        sql`${SELECT_USER} where u.id = ${id}::uuid limit 1`,
      )) as unknown as Rows;
      return toUser(rows[0]);
    },

    async deleteUser(id) {
      await assertAvailable();
      await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
    },
  };
}
