-- C18: people management. Signed-in users write the membership tables only as an agency
-- admin and never their own row (nobody grants, changes or removes their own access); a
-- trigger keeps at least one agency_admin in every agency, under a lock on the agency so two
-- admins demoting each other at the same time cannot both succeed; the audit log gets an index
-- for counting a person's recent grants (the invitation limit).
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
ALTER POLICY "business_memberships_insert_user" ON "business_memberships" TO authenticated WITH CHECK ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));--> statement-breakpoint
ALTER POLICY "business_memberships_update_user" ON "business_memberships" TO authenticated USING ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid()))) WITH CHECK ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));--> statement-breakpoint
ALTER POLICY "business_memberships_delete_user" ON "business_memberships" TO authenticated USING ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));--> statement-breakpoint
ALTER POLICY "agency_memberships_insert_user" ON "agency_memberships" TO authenticated WITH CHECK ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));--> statement-breakpoint
ALTER POLICY "agency_memberships_update_user" ON "agency_memberships" TO authenticated USING ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid()))) WITH CHECK ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));--> statement-breakpoint
ALTER POLICY "agency_memberships_delete_user" ON "agency_memberships" TO authenticated USING ((agency_id in (select app.admin_agency_ids()) and user_id <> (select auth.uid())));
--> statement-breakpoint

-- Refuses the change that would leave an agency without an agency_admin: deleting the last
-- admin's membership, giving it another role, or moving it to another agency. Applies to every
-- role (signed-in users, the system scope, scripts). Deleting the agency itself, or the user
-- (the platform operator removing an account), cascades through without a check.
CREATE OR REPLACE FUNCTION app.keep_one_agency_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
  BEGIN
    IF OLD.role <> 'agency_admin' THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role = 'agency_admin' AND NEW.agency_id = OLD.agency_id THEN
      RETURN NEW;
    END IF;
    -- One change to an agency's admins at a time. NO KEY UPDATE does not block inserts that
    -- refer to the agency.
    PERFORM 1 FROM public.agencies a WHERE a.id = OLD.agency_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.user_id) THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.agency_memberships m
       WHERE m.agency_id = OLD.agency_id AND m.role = 'agency_admin' AND m.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'An agency must keep at least one agency admin.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'agency_memberships_last_admin',
              TABLE = 'agency_memberships';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.keep_one_agency_admin() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER agency_memberships_keep_one_admin
  BEFORE UPDATE OR DELETE ON public.agency_memberships
  FOR EACH ROW EXECUTE FUNCTION app.keep_one_agency_admin();
