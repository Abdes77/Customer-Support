-- Guards that Drizzle cannot express (hand-written).
--
-- 1. public.users follows auth.users (Supabase Auth, or the local compatibility table).
-- 2. Append-only tables refuse updates on every connection.
-- 3. app.sync_table_privileges() forces row-level security on every table and grants each
--    restricted role exactly the commands its policies cover. `pnpm db:migrate` runs it after
--    every migration, so tables added by later migrations are covered without more SQL.

-- ---------------------------------------------------------------------------------------
-- 1. Profiles follow auth users
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.sync_auth_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name)
  VALUES (
    NEW.id,
    coalesce(NEW.email, ''),
    nullif(NEW.raw_user_meta_data ->> 'full_name', '')
  )
  ON CONFLICT (id) DO UPDATE
    SET email = excluded.email,
        updated_at = now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS app_sync_auth_user ON auth.users;
--> statement-breakpoint
CREATE TRIGGER app_sync_auth_user
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.sync_auth_user();
--> statement-breakpoint

-- People who signed up before this migration.
INSERT INTO public.users (id, email, full_name)
SELECT u.id, coalesce(u.email, ''), nullif(u.raw_user_meta_data ->> 'full_name', '')
  FROM auth.users u
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- Deleting the auth user deletes the profile, and with it every membership.
ALTER TABLE public.users
  ADD CONSTRAINT users_id_auth_users_fk
  FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2. Append-only tables
-- ---------------------------------------------------------------------------------------

-- Refuses any update, except one that only sets the columns named as trigger arguments to
-- NULL: that is what "ON DELETE SET NULL" does when a referenced user is deleted.
CREATE OR REPLACE FUNCTION app.reject_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  col text;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    col := TG_ARGV[i];
    IF new_row -> col = 'null'::jsonb THEN
      old_row := old_row - col;
      new_row := new_row - col;
    END IF;
  END LOOP;
  IF old_row = new_row THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: rows cannot be changed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_update('actor_user_id');
--> statement-breakpoint
CREATE TRIGGER setting_versions_append_only
  BEFORE UPDATE ON public.setting_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_update('changed_by');
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 3. Privileges follow policies
-- ---------------------------------------------------------------------------------------

-- Lets the two restricted roles into schema public (never relying on the grant to PUBLIC
-- that a stock database happens to have), then for every table in schema public:
--   * enable and force row-level security;
--   * take every privilege away from PUBLIC, anon, authenticated and app_system
--     (Supabase grants ALL on new tables to anon and authenticated by default);
--   * give authenticated and app_system back exactly the commands for which the table has
--     a policy naming that role.
-- A table without policies is therefore unreachable for both restricted roles, and the
-- anonymous role can reach no table at all. Idempotent.
CREATE OR REPLACE FUNCTION app.sync_table_privileges() RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
DECLARE
  tbl record;
  role_name text;
  command text;
  has_anon boolean := EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon');
BEGIN
  GRANT USAGE ON SCHEMA public TO authenticated, app_system;

  FOR tbl IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl.relname);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', tbl.relname);
    IF has_anon THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', tbl.relname);
    END IF;

    FOREACH role_name IN ARRAY ARRAY['authenticated', 'app_system'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tbl.relname, role_name);
      FOREACH command IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF EXISTS (
          SELECT 1
            FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public'
             AND p.tablename = tbl.relname
             AND role_name = ANY (p.roles::text[])
             AND p.cmd IN (command, 'ALL')
        ) THEN
          EXECUTE format('GRANT %s ON TABLE public.%I TO %I', command, tbl.relname, role_name);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Helper functions are for the two restricted roles (granted by name), never for PUBLIC.
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
END
$$;
--> statement-breakpoint

SELECT app.sync_table_privileges();
