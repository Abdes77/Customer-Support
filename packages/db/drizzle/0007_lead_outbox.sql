CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"emitted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_events_name_check" CHECK ("lead_events"."name" in ('lead.qualified', 'lead.meeting_requested', 'lead.handoff', 'lead.disqualified', 'lead.emergency'))
);
--> statement-breakpoint
ALTER TABLE "lead_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN "sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_lead_dedupe_key" ON "lead_events" USING btree ("lead_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "lead_events_business_pending_idx" ON "lead_events" USING btree ("business_id","created_at") WHERE "lead_events"."emitted_at" is null;--> statement-breakpoint
CREATE INDEX "routing_decisions_lead_sequence_idx" ON "routing_decisions" USING btree ("lead_id","sequence");--> statement-breakpoint
CREATE POLICY "lead_events_select_user" ON "lead_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "lead_events_select_system" ON "lead_events" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_events_insert_system" ON "lead_events" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_events_update_system" ON "lead_events" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_events_delete_system" ON "lead_events" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));