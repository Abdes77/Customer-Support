-- Foundation for row-level security (hand-written; see packages/db/src/schema/policies.ts).
--
-- Creates the tenant-scoped role of jobs and webhooks, the schema "app" and the helper
-- functions that the policies of migration 0001 call. The functions refer to tables that
-- 0001 creates, so their bodies are not validated here.
--
-- Requires the Supabase roles and auth.uid(). On a Supabase database they exist; on plain
-- PostgreSQL `pnpm db:migrate` applies the compatibility bootstrap first.

SET LOCAL check_function_bodies = off;
--> statement-breakpoint

-- The role every Database.forBusiness() / forAgency() transaction switches to. It can log
-- in nowhere and owns nothing; row-level security binds it to the tenant held in the
-- transaction-local settings app.agency_id and app.business_id.
DO $$
BEGIN
  CREATE ROLE app_system NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
--> statement-breakpoint

-- The connection role must be able to SET ROLE to both restricted roles.
DO $$
BEGIN
  EXECUTE format('GRANT app_system TO %I', current_user);
  BEGIN
    EXECUTE format('GRANT authenticated TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN
    -- Already a member (Supabase), or not allowed to grant it: `pnpm db:doctor` checks that
    -- SET ROLE authenticated works either way.
    NULL;
  END;
END
$$;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- System scope: which tenant did this transaction enter?
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.scope_agency_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
  AS $$ SELECT nullif(current_setting('app.agency_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.scope_business_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
  AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;
--> statement-breakpoint

-- The agency, but only when the scope covers the whole agency (no business was entered).
CREATE OR REPLACE FUNCTION app.scope_agency_wide_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
  AS $$
    SELECT CASE
      WHEN nullif(current_setting('app.business_id', true), '') IS NULL
      THEN nullif(current_setting('app.agency_id', true), '')::uuid
    END
  $$;
--> statement-breakpoint

-- People who belong to the scope's agency, as staff or as client users of its businesses.
CREATE OR REPLACE FUNCTION app.scope_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT m.user_id FROM public.agency_memberships m
     WHERE m.agency_id = app.scope_agency_id()
    UNION
    SELECT bm.user_id FROM public.business_memberships bm
     WHERE bm.agency_id = app.scope_agency_id()
  $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- User context: what may the signed-in user (auth.uid()) reach?
--
-- SECURITY DEFINER so the lookups read the membership tables without recursing into their
-- own policies. They take no arguments and only ever answer for auth.uid(), so calling them
-- directly reveals nothing a user does not already know.
-- ---------------------------------------------------------------------------------------

-- Agencies where the user is staff (agency_admin or agency_member).
CREATE OR REPLACE FUNCTION app.staff_agency_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT m.agency_id FROM public.agency_memberships m
     WHERE m.user_id = (SELECT auth.uid())
  $$;
--> statement-breakpoint

-- Agencies where the user is an agency_admin.
CREATE OR REPLACE FUNCTION app.admin_agency_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT m.agency_id FROM public.agency_memberships m
     WHERE m.user_id = (SELECT auth.uid()) AND m.role = 'agency_admin'
  $$;
--> statement-breakpoint

-- Businesses the user may enter as a client user: a membership, client logins switched on
-- for the business, and the business not archived.
CREATE OR REPLACE FUNCTION app.client_business_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT bm.business_id
      FROM public.business_memberships bm
      JOIN public.businesses b ON b.id = bm.business_id
     WHERE bm.user_id = (SELECT auth.uid())
       AND b.client_portal_enabled
       AND b.status <> 'archived'
  $$;
--> statement-breakpoint

-- As above, limited to businesses where the user is the client_owner.
CREATE OR REPLACE FUNCTION app.client_owner_business_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT bm.business_id
      FROM public.business_memberships bm
      JOIN public.businesses b ON b.id = bm.business_id
     WHERE bm.user_id = (SELECT auth.uid())
       AND bm.role = 'client_owner'
       AND b.client_portal_enabled
       AND b.status <> 'archived'
  $$;
--> statement-breakpoint

-- Profiles the user may see: their own; for agency staff everyone in their agencies
-- (colleagues and the client users of the agency's businesses); for a client owner the
-- other users of their business.
CREATE OR REPLACE FUNCTION app.visible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT (SELECT auth.uid())
    UNION
    SELECT m.user_id FROM public.agency_memberships m
     WHERE m.agency_id IN (SELECT app.staff_agency_ids())
    UNION
    SELECT bm.user_id FROM public.business_memberships bm
     WHERE bm.agency_id IN (SELECT app.staff_agency_ids())
    UNION
    SELECT bm.user_id FROM public.business_memberships bm
     WHERE bm.business_id IN (SELECT app.client_owner_business_ids())
  $$;
--> statement-breakpoint

-- Functions are executable by PUBLIC by default: narrow that to the roles that need them.
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO authenticated, app_system;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.scope_agency_id(), app.scope_business_id(), app.scope_agency_wide_id(), app.scope_user_ids()
  TO app_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.staff_agency_ids(), app.admin_agency_ids(), app.client_business_ids(),
  app.client_owner_business_ids(), app.visible_user_ids()
  TO authenticated;
--> statement-breakpoint

RESET check_function_bodies;
