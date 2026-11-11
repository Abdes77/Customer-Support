/**
 * Supabase compatibility bootstrap for plain PostgreSQL.
 *
 * Production runs on Supabase, where the roles `anon`, `authenticated` and `service_role`,
 * the schema `auth` with `auth.users`, and the functions `auth.uid()` / `auth.jwt()` already
 * exist. Local development and CI use plain PostgreSQL 16 (DECISIONS 16); this script creates
 * the same names there, so the migrations, the policies and the row-level security tests run
 * unchanged.
 *
 * It is applied by `migrateDatabase()` only when the database is not a Supabase one, and it
 * marks the `auth` schema with a comment so it can be told apart from the real thing. It is
 * idempotent. The connection role needs CREATEROLE (scripts/dev-services.sh grants it).
 */

/** Comment on schema `auth` that marks a database as bootstrapped by this script. */
export const SUPABASE_COMPAT_MARKER = "hsrb:supabase-compat";

export const SUPABASE_COMPAT_SQL = `
DO $$
BEGIN
  BEGIN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  -- Like the "postgres" role on Supabase, the connection role may SET ROLE to each of them.
  EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;
COMMENT ON SCHEMA auth IS '${SUPABASE_COMPAT_MARKER}';
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- The columns of Supabase's auth.users that this system reads or writes. On Supabase the
-- table belongs to Supabase Auth; here the local sign-in store and the seed fill it.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON auth.users (lower(email));

-- Same definitions as Supabase: the claims of the request live in transaction-local settings.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;
`;
