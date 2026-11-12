ALTER TABLE "widget_sessions" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD COLUMN "last_message_at" timestamp with time zone;