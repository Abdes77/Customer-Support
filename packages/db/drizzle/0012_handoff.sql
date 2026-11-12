-- C13: handoff, alerts and the emergency chain. Escalations get their policy snapshot, the
-- next moment the chain acts, who acknowledged and how, and at most one active chain per
-- conversation; alerts point at their escalation and keep only hashes of their
-- acknowledgement secrets; a takeover lock may let the bot's own handoff message out.
ALTER TABLE "takeover_locks" ADD COLUMN "exempt_through_seq" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "escalation_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ack_token_hash" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ack_code_hash" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "trace_id" uuid;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "next_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "acknowledged_via" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "acknowledged_user_id" uuid;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_id_business_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_escalation_fk" FOREIGN KEY ("escalation_id","business_id") REFERENCES "public"."escalations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acknowledged_user_id_users_id_fk" FOREIGN KEY ("acknowledged_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_escalation_idx" ON "alerts" USING btree ("escalation_id");--> statement-breakpoint
CREATE INDEX "alerts_ack_recipient_idx" ON "alerts" USING btree ("recipient") WHERE "alerts"."ack_code_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_active_conversation_key" ON "escalations" USING btree ("conversation_id") WHERE "escalations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "escalations_next_action_idx" ON "escalations" USING btree ("next_action_at") WHERE "escalations"."status" = 'active';--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acknowledged_via_check" CHECK ("escalations"."acknowledged_via" is null or "escalations"."acknowledged_via" in ('link', 'sms', 'voice', 'admin_panel'));