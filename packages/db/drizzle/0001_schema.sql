CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_memberships_role_check" CHECK ("business_memberships"."role" in ('client_owner', 'client_staff'))
);
--> statement-breakpoint
ALTER TABLE "business_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"segment_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"client_portal_enabled" boolean DEFAULT false NOT NULL,
	"website_url" text,
	"phone" text,
	"email" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_id_agency_key" UNIQUE("id","agency_id"),
	CONSTRAINT "businesses_status_check" CHECK ("businesses"."status" in ('onboarding', 'active', 'paused', 'archived')),
	CONSTRAINT "businesses_active_segment_check" CHECK ("businesses"."status" <> 'active' or "businesses"."segment_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_connection_secrets" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_connection_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "channel_connections_channel_check" CHECK ("channel_connections"."channel" in ('whatsapp', 'instagram', 'messenger', 'widget', 'email', 'test')),
	CONSTRAINT "channel_connections_status_check" CHECK ("channel_connections"."status" in ('pending', 'active', 'error', 'revoked', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en_US' NOT NULL,
	"category" text,
	"purpose" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"external_template_id" text,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reason" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_status_check" CHECK ("message_templates"."status" in ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text,
	"file_name" text,
	"size_bytes" bigint,
	"source" jsonb,
	"storage_bucket" text,
	"storage_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"analysis" text,
	"analyzed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_kind_check" CHECK ("attachments"."kind" in ('image', 'audio', 'video', 'file')),
	CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" in ('pending', 'stored', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_channel_check" CHECK ("contact_identities"."channel" in ('whatsapp', 'instagram', 'messenger', 'widget', 'email', 'test'))
);
--> statement-breakpoint
ALTER TABLE "contact_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"display_name" text,
	"phone" text,
	"email" text,
	"address" text,
	"timezone" text,
	"opted_out_at" timestamp with time zone,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_business_key" UNIQUE("id","business_id")
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_thread_id" text,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"message_seq" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"turn_lease_owner" text,
	"turn_lease_expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" in ('whatsapp', 'instagram', 'messenger', 'widget', 'email', 'test')),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "internal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"author" text NOT NULL,
	"author_user_id" uuid,
	"kind" text DEFAULT 'text' NOT NULL,
	"text" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_message_id" text,
	"reply_to_external_message_id" text,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"trace_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"enqueued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_author_check" CHECK ("messages"."author" in ('customer', 'bot', 'human_agent')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'superseded')),
	CONSTRAINT "messages_direction_author_check" CHECK (("messages"."direction" = 'inbound' and "messages"."author" = 'customer' and "messages"."status" = 'received') or ("messages"."direction" = 'outbound' and "messages"."author" <> 'customer' and "messages"."status" <> 'received'))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "takeover_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "takeover_locks_source_check" CHECK ("takeover_locks"."source" in ('admin_panel', 'provider_inbox', 'rule')),
	CONSTRAINT "takeover_locks_release_reason_check" CHECK ("takeover_locks"."release_reason" is null or "takeover_locks"."release_reason" in ('manual', 'idle_timeout'))
);
--> statement-breakpoint
ALTER TABLE "takeover_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "widget_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"visitor_id" text NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"origin" text,
	"user_agent" text,
	"ip_hash" text,
	"last_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widget_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"lead_id" uuid,
	"integration_connection_id" uuid,
	"provider" text NOT NULL,
	"external_event_id" text,
	"external_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"timezone" text,
	"title" text,
	"location" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" in ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'))
);
--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_connection_secrets" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text,
	"external_account_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "integration_connections_status_check" CHECK ("integration_connections"."status" in ('pending', 'active', 'error', 'revoked', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"integration_connection_id" uuid NOT NULL,
	"lead_id" uuid,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"external_url" text,
	"error_code" text,
	"error_message" text,
	"retryable" boolean,
	"request" jsonb,
	"response" jsonb,
	"duration_ms" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_events_status_check" CHECK ("integration_events"."status" in ('pending', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "integration_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_playbook_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"section" text NOT NULL,
	"content" jsonb NOT NULL,
	"base_version" integer,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_playbook_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_name" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_id_agency_key" UNIQUE("id","agency_id"),
	CONSTRAINT "import_runs_kind_check" CHECK ("import_runs"."kind" in ('csv', 'api', 'website_crawl')),
	CONSTRAINT "import_runs_status_check" CHECK ("import_runs"."status" in ('pending', 'running', 'succeeded', 'partial', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"source" text,
	"import_run_id" uuid,
	"is_core" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("knowledge_items"."title", '') || ' ' || coalesce("knowledge_items"."content", ''))) STORED,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_items_category_check" CHECK ("knowledge_items"."category" in ('services', 'service_area', 'hours', 'licenses', 'warranties', 'financing', 'team', 'brands', 'reviews', 'differentiators', 'pricing', 'policies', 'faq', 'other')),
	CONSTRAINT "knowledge_items_status_check" CHECK ("knowledge_items"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lead_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"confidence" real NOT NULL,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_fields_confidence_check" CHECK ("lead_fields"."confidence" >= 0 and "lead_fields"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "lead_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lead_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"summary" text NOT NULL,
	"markdown" text NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"band" text,
	"settings_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"band" text,
	"routing_outcome" text,
	"routing_decided_at" timestamp with time zone,
	"settings_version" text,
	"qualified_at" timestamp with time zone,
	"disqualified_at" timestamp with time zone,
	"disqualify_reason" text,
	"handed_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "leads_status_check" CHECK ("leads"."status" in ('new', 'qualifying', 'qualified', 'meeting_requested', 'meeting_booked', 'handed_off', 'disqualified')),
	CONSTRAINT "leads_score_check" CHECK ("leads"."score" >= 0 and "leads"."score" <= 100),
	CONSTRAINT "leads_routing_outcome_check" CHECK ("leads"."routing_outcome" is null or "leads"."routing_outcome" in ('book_meeting', 'contact_later', 'disqualify'))
);
--> statement-breakpoint
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"score" real NOT NULL,
	"band" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings_version" text NOT NULL,
	"trace_id" uuid,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_decisions_outcome_check" CHECK ("routing_decisions"."outcome" in ('book_meeting', 'contact_later', 'disqualify'))
);
--> statement-breakpoint
ALTER TABLE "routing_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid,
	"trace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"prompt_version" text NOT NULL,
	"settings_version" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"latency_ms" integer NOT NULL,
	"stop_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint,
	"request_id" text,
	"request" jsonb,
	"response" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_calls_mode_check" CHECK ("model_calls"."mode" in ('live', 'dry_run'))
);
--> statement-breakpoint
ALTER TABLE "model_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid,
	"lead_id" uuid,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_message_id" text,
	"error" text,
	"dedupe_key" text,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_severity_check" CHECK ("alerts"."severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" in ('pending', 'sent', 'delivered', 'failed', 'acknowledged', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('user', 'system', 'api_key'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid,
	"business_id" uuid,
	"source" text NOT NULL,
	"event_name" text,
	"event_id" text,
	"trace_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"error_code" text,
	"error_message" text NOT NULL,
	"retryable" boolean,
	"attempts" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letters_status_check" CHECK ("dead_letters"."status" in ('open', 'retried', 'resolved', 'ignored')),
	CONSTRAINT "dead_letters_tenant_check" CHECK ("dead_letters"."business_id" is null or "dead_letters"."agency_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "dead_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid,
	"lead_id" uuid,
	"emergency_class" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalations_status_check" CHECK ("escalations"."status" in ('active', 'acknowledged', 'exhausted', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "escalations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid,
	"lead_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_job_id" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_status_check" CHECK ("scheduled_jobs"."status" in ('scheduled', 'running', 'done', 'cancelled', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"subject" text DEFAULT 'business' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_seconds" integer NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "playbook_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"document" jsonb NOT NULL,
	"change_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_versions_version_check" CHECK ("playbook_versions"."version" > 0),
	CONSTRAINT "playbook_versions_origin_check" CHECK ("playbook_versions"."origin" in ('generated', 'manual', 'rollback', 'import'))
);
--> statement-breakpoint
ALTER TABLE "playbook_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_id_agency_key" UNIQUE("id","agency_id")
);
--> statement-breakpoint
ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "setting_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"segment_id" uuid,
	"business_id" uuid,
	"key" text NOT NULL,
	"value" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_values_scope_check" CHECK ("setting_values"."scope" in ('global', 'segment', 'business')),
	CONSTRAINT "setting_values_scope_target_check" CHECK ((scope = 'global' and segment_id is null and business_id is null) or (scope = 'segment' and segment_id is not null and business_id is null) or (scope = 'business' and segment_id is null and business_id is not null))
);
--> statement-breakpoint
ALTER TABLE "setting_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "setting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"segment_id" uuid,
	"business_id" uuid,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"operation" text NOT NULL,
	"value" jsonb,
	"previous_value" jsonb,
	"changed_by" uuid,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_versions_scope_check" CHECK ("setting_versions"."scope" in ('global', 'segment', 'business')),
	CONSTRAINT "setting_versions_scope_target_check" CHECK ((scope = 'global' and segment_id is null and business_id is null) or (scope = 'segment' and segment_id is not null and business_id is null) or (scope = 'business' and segment_id is null and business_id is not null)),
	CONSTRAINT "setting_versions_operation_check" CHECK ("setting_versions"."operation" in ('set', 'reset'))
);
--> statement-breakpoint
ALTER TABLE "setting_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agency_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_memberships_role_check" CHECK ("agency_memberships"."role" in ('agency_admin', 'agency_member'))
);
--> statement-breakpoint
ALTER TABLE "agency_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_segment_fk" FOREIGN KEY ("segment_id","agency_id") REFERENCES "public"."segments"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connection_secrets" ADD CONSTRAINT "channel_connection_secrets_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connection_secrets" ADD CONSTRAINT "channel_connection_secrets_connection_fk" FOREIGN KEY ("connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_fk" FOREIGN KEY ("message_id","business_id") REFERENCES "public"."messages"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeover_locks" ADD CONSTRAINT "takeover_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeover_locks" ADD CONSTRAINT "takeover_locks_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeover_locks" ADD CONSTRAINT "takeover_locks_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeover_locks" ADD CONSTRAINT "takeover_locks_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_channel_connection_fk" FOREIGN KEY ("channel_connection_id","business_id") REFERENCES "public"."channel_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_integration_connection_fk" FOREIGN KEY ("integration_connection_id","business_id") REFERENCES "public"."integration_connections"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_secrets" ADD CONSTRAINT "integration_connection_secrets_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_secrets" ADD CONSTRAINT "integration_connection_secrets_connection_fk" FOREIGN KEY ("connection_id","business_id") REFERENCES "public"."integration_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_integration_connection_fk" FOREIGN KEY ("integration_connection_id","business_id") REFERENCES "public"."integration_connections"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_playbook_overrides" ADD CONSTRAINT "business_playbook_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_playbook_overrides" ADD CONSTRAINT "business_playbook_overrides_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_import_run_fk" FOREIGN KEY ("import_run_id","agency_id") REFERENCES "public"."import_runs"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_fields" ADD CONSTRAINT "lead_fields_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_fields" ADD CONSTRAINT "lead_fields_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_reports" ADD CONSTRAINT "lead_reports_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_reports" ADD CONSTRAINT "lead_reports_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_conversation_fk" FOREIGN KEY ("conversation_id","business_id") REFERENCES "public"."conversations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_lead_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_segment_fk" FOREIGN KEY ("segment_id","agency_id") REFERENCES "public"."segments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_segment_fk" FOREIGN KEY ("segment_id","agency_id") REFERENCES "public"."segments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_versions" ADD CONSTRAINT "setting_versions_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_versions" ADD CONSTRAINT "setting_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_versions" ADD CONSTRAINT "setting_versions_tenant_fk" FOREIGN KEY ("business_id","agency_id") REFERENCES "public"."businesses"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_versions" ADD CONSTRAINT "setting_versions_segment_fk" FOREIGN KEY ("segment_id","agency_id") REFERENCES "public"."segments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_memberships" ADD CONSTRAINT "agency_memberships_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_memberships" ADD CONSTRAINT "agency_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_agency_idx" ON "api_keys" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_memberships_business_user_key" ON "business_memberships" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "business_memberships_user_idx" ON "business_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_agency_slug_key" ON "businesses" USING btree ("agency_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_agency_external_ref_key" ON "businesses" USING btree ("agency_id","external_ref");--> statement-breakpoint
CREATE INDEX "channel_connection_secrets_business_idx" ON "channel_connection_secrets" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "channel_connection_secrets_key_idx" ON "channel_connection_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_account_key" ON "channel_connections" USING btree ("channel","external_account_id");--> statement-breakpoint
CREATE INDEX "channel_connections_business_idx" ON "channel_connections" USING btree ("business_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_name_key" ON "message_templates" USING btree ("channel_connection_id","name","language");--> statement-breakpoint
CREATE INDEX "message_templates_business_idx" ON "message_templates" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_business_idx" ON "attachments" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identities_external_key" ON "contact_identities" USING btree ("business_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "contact_identities_contact_idx" ON "contact_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contacts_business_phone_idx" ON "contacts" USING btree ("business_id","phone");--> statement-breakpoint
CREATE INDEX "contacts_business_email_idx" ON "contacts" USING btree ("business_id",lower("email"));--> statement-breakpoint
CREATE INDEX "contacts_business_created_idx" ON "contacts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_thread_key" ON "conversations" USING btree ("channel_connection_id","contact_id",coalesce("external_thread_id", '')) WHERE "conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "conversations_business_last_message_idx" ON "conversations" USING btree ("business_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_assigned_user_idx" ON "conversations" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "internal_notes_conversation_idx" ON "internal_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_external_key" ON "messages" USING btree ("channel_connection_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_sequence_key" ON "messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "messages_business_created_idx" ON "messages" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_trace_idx" ON "messages" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "messages_unenqueued_idx" ON "messages" USING btree ("created_at") WHERE "messages"."direction" = 'inbound' and "messages"."enqueued_at" is null;--> statement-breakpoint
CREATE INDEX "messages_outbox_idx" ON "messages" USING btree ("conversation_id","sequence") WHERE "messages"."status" in ('queued', 'sending');--> statement-breakpoint
CREATE UNIQUE INDEX "takeover_locks_active_key" ON "takeover_locks" USING btree ("conversation_id") WHERE "takeover_locks"."released_at" is null;--> statement-breakpoint
CREATE INDEX "takeover_locks_business_idx" ON "takeover_locks" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "widget_sessions_visitor_key" ON "widget_sessions" USING btree ("channel_connection_id","visitor_id");--> statement-breakpoint
CREATE INDEX "widget_sessions_business_idx" ON "widget_sessions" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_external_event_key" ON "bookings" USING btree ("integration_connection_id","external_event_id");--> statement-breakpoint
CREATE INDEX "bookings_business_starts_idx" ON "bookings" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_lead_idx" ON "bookings" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "bookings_conversation_idx" ON "bookings" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "integration_connection_secrets_business_idx" ON "integration_connection_secrets" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "integration_connection_secrets_key_idx" ON "integration_connection_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "integration_connections_business_idx" ON "integration_connections" USING btree ("business_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_idempotency_key" ON "integration_events" USING btree ("integration_connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_events_business_occurred_idx" ON "integration_events" USING btree ("business_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_events_lead_idx" ON "integration_events" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_playbook_overrides_section_key" ON "business_playbook_overrides" USING btree ("business_id","section");--> statement-breakpoint
CREATE INDEX "import_runs_agency_created_idx" ON "import_runs" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "import_runs_business_idx" ON "import_runs" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "knowledge_items_business_category_idx" ON "knowledge_items" USING btree ("business_id","category","position");--> statement-breakpoint
CREATE INDEX "knowledge_items_search_idx" ON "knowledge_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_fields_lead_key" ON "lead_fields" USING btree ("lead_id","key");--> statement-breakpoint
CREATE INDEX "lead_fields_business_idx" ON "lead_fields" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_reports_lead_version_key" ON "lead_reports" USING btree ("lead_id","version");--> statement-breakpoint
CREATE INDEX "lead_reports_business_idx" ON "lead_reports" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_conversation_key" ON "leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "leads_business_status_idx" ON "leads" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "leads_business_created_idx" ON "leads" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "routing_decisions_lead_idx" ON "routing_decisions" USING btree ("lead_id","decided_at");--> statement-breakpoint
CREATE INDEX "routing_decisions_business_idx" ON "routing_decisions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "model_calls_business_started_idx" ON "model_calls" USING btree ("business_id","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_conversation_idx" ON "model_calls" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_trace_idx" ON "model_calls" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_key" ON "alerts" USING btree ("business_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_business_created_idx" ON "alerts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_agency_created_idx" ON "audit_log" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_business_created_idx" ON "audit_log" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "dead_letters_agency_created_idx" ON "dead_letters" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "dead_letters_business_idx" ON "dead_letters" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "dead_letters_status_idx" ON "dead_letters" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "escalations_business_status_idx" ON "escalations" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "escalations_conversation_idx" ON "escalations" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_jobs_dedupe_key" ON "scheduled_jobs" USING btree ("business_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_conversation_idx" ON "scheduled_jobs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_window_key" ON "usage_counters" USING btree ("business_id","metric","subject","window_start","window_seconds");--> statement-breakpoint
CREATE INDEX "usage_counters_window_idx" ON "usage_counters" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_versions_segment_version_key" ON "playbook_versions" USING btree ("segment_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_versions_active_key" ON "playbook_versions" USING btree ("segment_id") WHERE "playbook_versions"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "segments_agency_slug_key" ON "segments" USING btree ("agency_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "setting_values_global_key" ON "setting_values" USING btree ("agency_id","key") WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_values_segment_key" ON "setting_values" USING btree ("segment_id","key") WHERE scope = 'segment';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_values_business_key" ON "setting_values" USING btree ("business_id","key") WHERE scope = 'business';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_versions_global_key" ON "setting_versions" USING btree ("agency_id","key","version") WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_versions_segment_key" ON "setting_versions" USING btree ("segment_id","key","version") WHERE scope = 'segment';--> statement-breakpoint
CREATE UNIQUE INDEX "setting_versions_business_key" ON "setting_versions" USING btree ("business_id","key","version") WHERE scope = 'business';--> statement-breakpoint
CREATE INDEX "setting_versions_agency_created_idx" ON "setting_versions" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_slug_key" ON "agencies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_memberships_agency_user_key" ON "agency_memberships" USING btree ("agency_id","user_id");--> statement-breakpoint
CREATE INDEX "agency_memberships_user_idx" ON "agency_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE POLICY "api_keys_select_user" ON "api_keys" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "api_keys_insert_user" ON "api_keys" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "api_keys_update_user" ON "api_keys" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.admin_agency_ids())) WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "api_keys_delete_user" ON "api_keys" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "api_keys_select_system" ON "api_keys" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "api_keys_insert_system" ON "api_keys" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "api_keys_update_system" ON "api_keys" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id())))) WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "api_keys_delete_system" ON "api_keys" AS PERMISSIVE FOR DELETE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "business_memberships_select_user" ON "business_memberships" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or user_id = (select auth.uid()) or business_id in (select app.client_owner_business_ids())));--> statement-breakpoint
CREATE POLICY "business_memberships_insert_user" ON "business_memberships" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_memberships_update_user" ON "business_memberships" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.admin_agency_ids())) WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_memberships_delete_user" ON "business_memberships" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_memberships_select_system" ON "business_memberships" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_memberships_insert_system" ON "business_memberships" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_memberships_update_system" ON "business_memberships" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_memberships_delete_system" ON "business_memberships" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "businesses_select_user" ON "businesses" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "businesses_insert_user" ON "businesses" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "businesses_update_user" ON "businesses" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "businesses_delete_user" ON "businesses" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "businesses_select_system" ON "businesses" AS PERMISSIVE FOR SELECT TO "app_system" USING ((id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "businesses_insert_system" ON "businesses" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "businesses_update_system" ON "businesses" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "businesses_delete_system" ON "businesses" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "channel_connection_secrets_select_system" ON "channel_connection_secrets" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connection_secrets_insert_system" ON "channel_connection_secrets" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connection_secrets_update_system" ON "channel_connection_secrets" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connection_secrets_delete_system" ON "channel_connection_secrets" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connections_select_user" ON "channel_connections" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "channel_connections_select_system" ON "channel_connections" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connections_insert_system" ON "channel_connections" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connections_update_system" ON "channel_connections" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "channel_connections_delete_system" ON "channel_connections" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_templates_select_user" ON "message_templates" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "message_templates_insert_user" ON "message_templates" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "message_templates_update_user" ON "message_templates" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "message_templates_delete_user" ON "message_templates" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "message_templates_select_system" ON "message_templates" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_templates_insert_system" ON "message_templates" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_templates_update_system" ON "message_templates" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "message_templates_delete_system" ON "message_templates" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "attachments_select_user" ON "attachments" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "attachments_select_system" ON "attachments" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "attachments_insert_system" ON "attachments" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "attachments_update_system" ON "attachments" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "attachments_delete_system" ON "attachments" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contact_identities_select_user" ON "contact_identities" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "contact_identities_select_system" ON "contact_identities" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contact_identities_insert_system" ON "contact_identities" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contact_identities_update_system" ON "contact_identities" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contact_identities_delete_system" ON "contact_identities" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contacts_select_user" ON "contacts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "contacts_select_system" ON "contacts" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contacts_insert_system" ON "contacts" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contacts_update_system" ON "contacts" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "contacts_delete_system" ON "contacts" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversations_select_user" ON "conversations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "conversations_select_system" ON "conversations" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversations_insert_system" ON "conversations" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversations_update_system" ON "conversations" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "conversations_delete_system" ON "conversations" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "internal_notes_select_user" ON "internal_notes" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "internal_notes_insert_user" ON "internal_notes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((agency_id in (select app.staff_agency_ids()) and author_user_id = (select auth.uid())));--> statement-breakpoint
CREATE POLICY "internal_notes_update_user" ON "internal_notes" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) and author_user_id = (select auth.uid()))) WITH CHECK ((agency_id in (select app.staff_agency_ids()) and author_user_id = (select auth.uid())));--> statement-breakpoint
CREATE POLICY "internal_notes_delete_user" ON "internal_notes" AS PERMISSIVE FOR DELETE TO "authenticated" USING (((agency_id in (select app.staff_agency_ids()) and author_user_id = (select auth.uid())) or agency_id in (select app.admin_agency_ids())));--> statement-breakpoint
CREATE POLICY "internal_notes_select_system" ON "internal_notes" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "internal_notes_insert_system" ON "internal_notes" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "internal_notes_update_system" ON "internal_notes" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "internal_notes_delete_system" ON "internal_notes" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "messages_select_user" ON "messages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "messages_select_system" ON "messages" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "messages_insert_system" ON "messages" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "messages_update_system" ON "messages" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "messages_delete_system" ON "messages" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "takeover_locks_select_user" ON "takeover_locks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "takeover_locks_select_system" ON "takeover_locks" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "takeover_locks_insert_system" ON "takeover_locks" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "takeover_locks_update_system" ON "takeover_locks" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "takeover_locks_delete_system" ON "takeover_locks" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "widget_sessions_select_user" ON "widget_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "widget_sessions_select_system" ON "widget_sessions" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "widget_sessions_insert_system" ON "widget_sessions" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "widget_sessions_update_system" ON "widget_sessions" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "widget_sessions_delete_system" ON "widget_sessions" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "bookings_select_user" ON "bookings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "bookings_select_system" ON "bookings" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "bookings_insert_system" ON "bookings" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "bookings_update_system" ON "bookings" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "bookings_delete_system" ON "bookings" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connection_secrets_select_system" ON "integration_connection_secrets" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connection_secrets_insert_system" ON "integration_connection_secrets" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connection_secrets_update_system" ON "integration_connection_secrets" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connection_secrets_delete_system" ON "integration_connection_secrets" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connections_select_user" ON "integration_connections" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "integration_connections_select_system" ON "integration_connections" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connections_insert_system" ON "integration_connections" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connections_update_system" ON "integration_connections" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_connections_delete_system" ON "integration_connections" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_events_select_user" ON "integration_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "integration_events_select_system" ON "integration_events" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_events_insert_system" ON "integration_events" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_events_update_system" ON "integration_events" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "integration_events_delete_system" ON "integration_events" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_select_user" ON "business_playbook_overrides" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_insert_user" ON "business_playbook_overrides" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_update_user" ON "business_playbook_overrides" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_delete_user" ON "business_playbook_overrides" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_select_system" ON "business_playbook_overrides" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_insert_system" ON "business_playbook_overrides" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_update_system" ON "business_playbook_overrides" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "business_playbook_overrides_delete_system" ON "business_playbook_overrides" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "import_runs_select_user" ON "import_runs" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "import_runs_insert_user" ON "import_runs" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "import_runs_update_user" ON "import_runs" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "import_runs_select_system" ON "import_runs" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "import_runs_insert_system" ON "import_runs" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "import_runs_update_system" ON "import_runs" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id())))) WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "import_runs_delete_system" ON "import_runs" AS PERMISSIVE FOR DELETE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "knowledge_items_select_user" ON "knowledge_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "knowledge_items_insert_user" ON "knowledge_items" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "knowledge_items_update_user" ON "knowledge_items" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "knowledge_items_delete_user" ON "knowledge_items" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "knowledge_items_select_system" ON "knowledge_items" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "knowledge_items_insert_system" ON "knowledge_items" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "knowledge_items_update_system" ON "knowledge_items" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "knowledge_items_delete_system" ON "knowledge_items" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_fields_select_user" ON "lead_fields" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "lead_fields_select_system" ON "lead_fields" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_fields_insert_system" ON "lead_fields" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_fields_update_system" ON "lead_fields" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_fields_delete_system" ON "lead_fields" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_reports_select_user" ON "lead_reports" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "lead_reports_select_system" ON "lead_reports" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_reports_insert_system" ON "lead_reports" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_reports_update_system" ON "lead_reports" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "lead_reports_delete_system" ON "lead_reports" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "leads_select_user" ON "leads" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "leads_select_system" ON "leads" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "leads_insert_system" ON "leads" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "leads_update_system" ON "leads" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "leads_delete_system" ON "leads" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "routing_decisions_select_user" ON "routing_decisions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((agency_id in (select app.staff_agency_ids()) or business_id in (select app.client_business_ids())));--> statement-breakpoint
CREATE POLICY "routing_decisions_select_system" ON "routing_decisions" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "routing_decisions_insert_system" ON "routing_decisions" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "routing_decisions_update_system" ON "routing_decisions" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "routing_decisions_delete_system" ON "routing_decisions" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "model_calls_select_user" ON "model_calls" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "model_calls_select_system" ON "model_calls" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "model_calls_insert_system" ON "model_calls" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "model_calls_update_system" ON "model_calls" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "model_calls_delete_system" ON "model_calls" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "alerts_select_user" ON "alerts" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "alerts_select_system" ON "alerts" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "alerts_insert_system" ON "alerts" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "alerts_update_system" ON "alerts" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "alerts_delete_system" ON "alerts" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "audit_log_select_user" ON "audit_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "audit_log_insert_user" ON "audit_log" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((agency_id in (select app.staff_agency_ids()) and actor_type = 'user' and actor_user_id = (select auth.uid())));--> statement-breakpoint
CREATE POLICY "audit_log_select_system" ON "audit_log" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "audit_log_insert_system" ON "audit_log" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "dead_letters_select_user" ON "dead_letters" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "dead_letters_select_system" ON "dead_letters" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "dead_letters_insert_system" ON "dead_letters" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "dead_letters_update_system" ON "dead_letters" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id())))) WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "dead_letters_delete_system" ON "dead_letters" AS PERMISSIVE FOR DELETE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "escalations_select_user" ON "escalations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "escalations_select_system" ON "escalations" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "escalations_insert_system" ON "escalations" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "escalations_update_system" ON "escalations" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "escalations_delete_system" ON "escalations" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "scheduled_jobs_select_user" ON "scheduled_jobs" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "scheduled_jobs_select_system" ON "scheduled_jobs" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "scheduled_jobs_insert_system" ON "scheduled_jobs" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "scheduled_jobs_update_system" ON "scheduled_jobs" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "scheduled_jobs_delete_system" ON "scheduled_jobs" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "usage_counters_select_user" ON "usage_counters" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "usage_counters_select_system" ON "usage_counters" AS PERMISSIVE FOR SELECT TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "usage_counters_insert_system" ON "usage_counters" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "usage_counters_update_system" ON "usage_counters" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))) WITH CHECK ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "usage_counters_delete_system" ON "usage_counters" AS PERMISSIVE FOR DELETE TO "app_system" USING ((business_id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id())));--> statement-breakpoint
CREATE POLICY "playbook_versions_select_user" ON "playbook_versions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "playbook_versions_insert_user" ON "playbook_versions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "playbook_versions_update_user" ON "playbook_versions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "playbook_versions_delete_user" ON "playbook_versions" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "playbook_versions_select_system" ON "playbook_versions" AS PERMISSIVE FOR SELECT TO "app_system" USING (agency_id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "playbook_versions_insert_system" ON "playbook_versions" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "playbook_versions_update_system" ON "playbook_versions" AS PERMISSIVE FOR UPDATE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id())) WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "playbook_versions_delete_system" ON "playbook_versions" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "segments_select_user" ON "segments" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "segments_insert_user" ON "segments" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "segments_update_user" ON "segments" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.staff_agency_ids())) WITH CHECK (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "segments_delete_user" ON "segments" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "segments_select_system" ON "segments" AS PERMISSIVE FOR SELECT TO "app_system" USING (agency_id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "segments_insert_system" ON "segments" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "segments_update_system" ON "segments" AS PERMISSIVE FOR UPDATE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id())) WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "segments_delete_system" ON "segments" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "setting_values_select_user" ON "setting_values" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "setting_values_insert_user" ON "setting_values" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((scope = 'business' and agency_id in (select app.staff_agency_ids())) or agency_id in (select app.admin_agency_ids())));--> statement-breakpoint
CREATE POLICY "setting_values_update_user" ON "setting_values" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (((scope = 'business' and agency_id in (select app.staff_agency_ids())) or agency_id in (select app.admin_agency_ids()))) WITH CHECK (((scope = 'business' and agency_id in (select app.staff_agency_ids())) or agency_id in (select app.admin_agency_ids())));--> statement-breakpoint
CREATE POLICY "setting_values_delete_user" ON "setting_values" AS PERMISSIVE FOR DELETE TO "authenticated" USING (((scope = 'business' and agency_id in (select app.staff_agency_ids())) or agency_id in (select app.admin_agency_ids())));--> statement-breakpoint
CREATE POLICY "setting_values_select_system" ON "setting_values" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "setting_values_insert_system" ON "setting_values" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "setting_values_update_system" ON "setting_values" AS PERMISSIVE FOR UPDATE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id())))) WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "setting_values_delete_system" ON "setting_values" AS PERMISSIVE FOR DELETE TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "setting_versions_select_user" ON "setting_versions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "setting_versions_insert_user" ON "setting_versions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((scope = 'business' and agency_id in (select app.staff_agency_ids())) or agency_id in (select app.admin_agency_ids())));--> statement-breakpoint
CREATE POLICY "setting_versions_select_system" ON "setting_versions" AS PERMISSIVE FOR SELECT TO "app_system" USING ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "setting_versions_insert_system" ON "setting_versions" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK ((agency_id = (select app.scope_agency_id()) and ((select app.scope_business_id()) is null or business_id = (select app.scope_business_id()))));--> statement-breakpoint
CREATE POLICY "agencies_select_user" ON "agencies" AS PERMISSIVE FOR SELECT TO "authenticated" USING (id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "agencies_update_user" ON "agencies" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (id in (select app.admin_agency_ids())) WITH CHECK (id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "agencies_select_system" ON "agencies" AS PERMISSIVE FOR SELECT TO "app_system" USING (id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "agencies_update_system" ON "agencies" AS PERMISSIVE FOR UPDATE TO "app_system" USING (id = (select app.scope_agency_wide_id())) WITH CHECK (id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "agency_memberships_select_user" ON "agency_memberships" AS PERMISSIVE FOR SELECT TO "authenticated" USING (agency_id in (select app.staff_agency_ids()));--> statement-breakpoint
CREATE POLICY "agency_memberships_insert_user" ON "agency_memberships" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "agency_memberships_update_user" ON "agency_memberships" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (agency_id in (select app.admin_agency_ids())) WITH CHECK (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "agency_memberships_delete_user" ON "agency_memberships" AS PERMISSIVE FOR DELETE TO "authenticated" USING (agency_id in (select app.admin_agency_ids()));--> statement-breakpoint
CREATE POLICY "agency_memberships_select_system" ON "agency_memberships" AS PERMISSIVE FOR SELECT TO "app_system" USING (agency_id = (select app.scope_agency_id()));--> statement-breakpoint
CREATE POLICY "agency_memberships_insert_system" ON "agency_memberships" AS PERMISSIVE FOR INSERT TO "app_system" WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "agency_memberships_update_system" ON "agency_memberships" AS PERMISSIVE FOR UPDATE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id())) WITH CHECK (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "agency_memberships_delete_system" ON "agency_memberships" AS PERMISSIVE FOR DELETE TO "app_system" USING (agency_id = (select app.scope_agency_wide_id()));--> statement-breakpoint
CREATE POLICY "users_select_user" ON "users" AS PERMISSIVE FOR SELECT TO "authenticated" USING (id in (select app.visible_user_ids()));--> statement-breakpoint
CREATE POLICY "users_select_system" ON "users" AS PERMISSIVE FOR SELECT TO "app_system" USING (id in (select app.scope_user_ids()));