CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"run_id" text NOT NULL,
	"trace_id" uuid NOT NULL,
	"through_seq" integer NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"skip_reason" text,
	"engine_outcome" text,
	"prompt_version" text,
	"settings_version" text,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turns_trigger_check" CHECK ("conversation_turns"."trigger" in ('inbound_message', 'follow_up', 'takeover_released')),
	CONSTRAINT "conversation_turns_status_check" CHECK ("conversation_turns"."status" in ('running', 'replied', 'no_reply', 'superseded', 'skipped', 'refused', 'failed')),
	CONSTRAINT "conversation_turns_ordinal_check" CHECK ("conversation_turns"."ordinal" > 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handled_through_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_ordinal_key" ON "conversation_turns" USING btree ("conversation_id","ordinal");--> statement-breakpoint
CREATE INDEX "conversation_turns_run_idx" ON "conversation_turns" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "conversation_turns_business_started_idx" ON "conversation_turns" USING btree ("business_id","started_at");--> statement-breakpoint
CREATE INDEX "conversation_turns_running_idx" ON "conversation_turns" USING btree ("conversation_id") WHERE "conversation_turns"."status" = 'running';--> statement-breakpoint
CREATE POLICY "conversation_turns_select_user" ON "conversation_turns" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "conversation_turns_select_system" ON "conversation_turns" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversation_turns_insert_system" ON "conversation_turns" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversation_turns_update_system" ON "conversation_turns" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversation_turns_delete_system" ON "conversation_turns" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));