-- C14: CRM and webhook connectors. The record a CRM holds per lead (its row lock serializes
-- pushes), the delivery journal's retry columns, one connection row per webhook target, and
-- agency-wide secrets (the signing secrets of agency webhook targets), system scope only.
CREATE TABLE "agency_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"integration_connection_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"external_id" text,
	"external_url" text,
	"external_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_payload_hash" text,
	"last_pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_events" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "integration_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_events" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_events" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_secrets" ADD CONSTRAINT "agency_secrets_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_records" ADD CONSTRAINT "integration_records_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_records" ADD CONSTRAINT "integration_records_integration_connection_fk" FOREIGN KEY ("integration_connection_id","business_id") REFERENCES "public"."integration_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_records" ADD CONSTRAINT "integration_records_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_secrets_agency_purpose_name_key" ON "agency_secrets" USING btree ("agency_id","purpose","name");--> statement-breakpoint
CREATE INDEX "agency_secrets_key_idx" ON "agency_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_records_connection_lead_key" ON "integration_records" USING btree ("integration_connection_id","lead_id");--> statement-breakpoint
CREATE INDEX "integration_records_business_idx" ON "integration_records" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "integration_records_lead_idx" ON "integration_records" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_webhook_target_key" ON "integration_connections" USING btree ("business_id","external_account_id") WHERE "integration_connections"."provider" = 'webhook';--> statement-breakpoint
CREATE INDEX "integration_events_pending_idx" ON "integration_events" USING btree ("business_id","next_attempt_at") WHERE "integration_events"."status" = 'pending';--> statement-breakpoint
CREATE POLICY "agency_secrets_select_system" ON "agency_secrets" AS PERMISSIVE FOR SELECT TO "app_system" USING (agency_id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "agency_secrets_insert_system" ON "agency_secrets" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "agency_secrets_update_system" ON "agency_secrets" AS PERMISSIVE FOR UPDATE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id())) WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "agency_secrets_delete_system" ON "agency_secrets" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "integration_records_select_user" ON "integration_records" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "integration_records_select_system" ON "integration_records" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_records_insert_system" ON "integration_records" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_records_update_system" ON "integration_records" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_records_delete_system" ON "integration_records" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));