CREATE TABLE "playbook_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"trace_id" uuid NOT NULL,
	"version" integer,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_generations_status_check" CHECK ("playbook_generations"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "playbook_generations_reason_check" CHECK ("playbook_generations"."reason" in ('onboarding', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "playbook_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbook_versions" DROP CONSTRAINT "playbook_versions_origin_check";--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "import_key" text;--> statement-breakpoint
ALTER TABLE "playbook_generations" ADD CONSTRAINT "playbook_generations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_generations" ADD CONSTRAINT "playbook_generations_segment_fk" FOREIGN KEY ("segment_id","agency_id") REFERENCES "public"."segments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_generations_segment_idx" ON "playbook_generations" USING btree ("segment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_generations_open_key" ON "playbook_generations" USING btree ("segment_id") WHERE "playbook_generations"."status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_import_key" ON "knowledge_items" USING btree ("business_id","import_key") WHERE "knowledge_items"."import_key" is not null;--> statement-breakpoint
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_origin_check" CHECK ("playbook_versions"."origin" in ('generated', 'manual', 'rollback', 'import', 'starter'));--> statement-breakpoint
DROP POLICY "playbook_versions_delete_user" ON "playbook_versions" CASCADE;--> statement-breakpoint
CREATE POLICY "playbook_generations_select_user" ON "playbook_generations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "playbook_generations_select_system" ON "playbook_generations" AS PERMISSIVE FOR SELECT TO "app_system" USING (agency_id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "playbook_generations_insert_system" ON "playbook_generations" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "playbook_generations_update_system" ON "playbook_generations" AS PERMISSIVE FOR UPDATE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id())) WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "playbook_generations_delete_system" ON "playbook_generations" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));