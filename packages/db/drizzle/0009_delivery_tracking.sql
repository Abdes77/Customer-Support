CREATE TABLE "message_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"external_message_id" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_parts_status_check" CHECK ("message_parts"."status" in ('sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "message_parts_part_index_check" CHECK ("message_parts"."part_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pending_delivery_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_delivery_statuses_status_check" CHECK ("pending_delivery_statuses"."status" in ('sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "pending_delivery_statuses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_message_fk" FOREIGN KEY ("message_id","business_id") REFERENCES "public"."messages"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_delivery_statuses" ADD CONSTRAINT "pending_delivery_statuses_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_delivery_statuses" ADD CONSTRAINT "pending_delivery_statuses_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_parts_external_key" ON "message_parts" USING btree ("channel_connection_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_parts_message_part_key" ON "message_parts" USING btree ("message_id","part_index");--> statement-breakpoint
CREATE INDEX "message_parts_business_idx" ON "message_parts" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_delivery_statuses_key" ON "pending_delivery_statuses" USING btree ("channel_connection_id","external_message_id","status");--> statement-breakpoint
CREATE INDEX "pending_delivery_statuses_created_idx" ON "pending_delivery_statuses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pending_delivery_statuses_business_idx" ON "pending_delivery_statuses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "channel_connections_business_account_idx" ON "channel_connections" USING btree ("channel",("config" ->> 'businessAccountId'));--> statement-breakpoint
CREATE POLICY "message_parts_select_user" ON "message_parts" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "message_parts_select_system" ON "message_parts" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_parts_insert_system" ON "message_parts" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_parts_update_system" ON "message_parts" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_parts_delete_system" ON "message_parts" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "pending_delivery_statuses_select_user" ON "pending_delivery_statuses" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "pending_delivery_statuses_select_system" ON "pending_delivery_statuses" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "pending_delivery_statuses_insert_system" ON "pending_delivery_statuses" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "pending_delivery_statuses_update_system" ON "pending_delivery_statuses" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "pending_delivery_statuses_delete_system" ON "pending_delivery_statuses" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));