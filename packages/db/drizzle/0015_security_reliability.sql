-- C17: security and reliability. `stored_uploads` records files stored before their message
-- exists, so the retention job can delete the ones never ingested; attachments get the
-- status "purged" (file deleted by retention, description kept); a job working inside one
-- business no longer reads the profiles of client users of the agency's other businesses;
-- the retention job may delete audit entries older than the agency's retention, through one
-- narrow function, and nothing else may.
CREATE TABLE "stored_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"path" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stored_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_status_check";--> statement-breakpoint
ALTER TABLE "stored_uploads" ADD CONSTRAINT "stored_uploads_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stored_uploads_path_key" ON "stored_uploads" USING btree ("business_id","path");--> statement-breakpoint
CREATE INDEX "stored_uploads_created_idx" ON "stored_uploads" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" in ('pending', 'stored', 'failed', 'skipped', 'purged'));--> statement-breakpoint
CREATE POLICY "stored_uploads_select_user" ON "stored_uploads" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "stored_uploads_select_system" ON "stored_uploads" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "stored_uploads_insert_system" ON "stored_uploads" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "stored_uploads_update_system" ON "stored_uploads" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "stored_uploads_delete_system" ON "stored_uploads" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));
--> statement-breakpoint

-- People a system scope may read: the agency's staff, and the client users of the business
-- it entered (all businesses of the agency only for an agency-wide scope). Before C17 a job
-- inside one business could read the profiles of every client user of the agency.
CREATE OR REPLACE FUNCTION app.scope_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT m.user_id FROM public.agency_memberships m
     WHERE m.agency_id = app.scope_agency_id()
    UNION
    SELECT bm.user_id FROM public.business_memberships bm
     WHERE bm.agency_id = app.scope_agency_id()
       AND (app.scope_business_id() IS NULL OR bm.business_id = app.scope_business_id())
  $$;
--> statement-breakpoint

-- Deletes the audit entries of the agency-wide scope that entered it, older than `cutoff`
-- (C17 retention, `data.audit_log_retention_days`). The table stays append-only for every
-- role: no delete policy exists; only this function, run by app_system inside an agency-wide
-- scope, removes rows, and only of that agency.
CREATE OR REPLACE FUNCTION app.purge_audit_log(cutoff timestamptz) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = ''
  AS $$
  DECLARE
    agency uuid := app.scope_agency_wide_id();
    removed integer;
  BEGIN
    IF agency IS NULL THEN
      RAISE EXCEPTION 'purge_audit_log needs an agency-wide scope'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF cutoff > now() - interval '90 days' THEN
      RAISE EXCEPTION 'audit entries are kept for at least 90 days'
        USING ERRCODE = 'check_violation';
    END IF;
    DELETE FROM public.audit_log a WHERE a.agency_id = agency AND a.created_at < cutoff;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_audit_log(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_audit_log(timestamptz) TO app_system;
