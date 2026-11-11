/**
 * Closed vocabularies owned by the data layer. Vocabularies that cross package boundaries
 * (roles, channels, lead statuses, knowledge categories, ...) live in @repo/core and are
 * reused here. Changing an array changes a CHECK constraint: run `pnpm db:generate`.
 */

export const BUSINESS_STATUSES = ["onboarding", "active", "paused", "archived"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const PLAYBOOK_ORIGINS = ["generated", "manual", "rollback", "import"] as const;
export type PlaybookOrigin = (typeof PLAYBOOK_ORIGINS)[number];

export const KNOWLEDGE_ITEM_STATUSES = ["active", "archived"] as const;
export type KnowledgeItemStatus = (typeof KNOWLEDGE_ITEM_STATUSES)[number];

export const IMPORT_RUN_KINDS = ["csv", "api", "website_crawl"] as const;
export type ImportRunKind = (typeof IMPORT_RUN_KINDS)[number];

export const IMPORT_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
] as const;
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];

export const SETTING_OPERATIONS = ["set", "reset"] as const;
export type SettingOperation = (typeof SETTING_OPERATIONS)[number];

/** Shared by channel connections and integration connections. */
export const CONNECTION_STATUSES = ["pending", "active", "error", "revoked", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const MESSAGE_TEMPLATE_STATUSES = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "paused",
  "disabled",
] as const;
export type MessageTemplateStatus = (typeof MESSAGE_TEMPLATE_STATUSES)[number];

export const CONVERSATION_STATUSES = ["open", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * "received" is the only status of an inbound message. The rest is the life of an outbound
 * message (ARCHITECTURE §8): queued, sending, sent, delivered, read, failed, superseded.
 */
export const MESSAGE_STATUSES = [
  "received",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "superseded",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const ATTACHMENT_STATUSES = ["pending", "stored", "failed", "skipped"] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export const TAKEOVER_SOURCES = ["admin_panel", "provider_inbox", "rule"] as const;
export type TakeoverSource = (typeof TAKEOVER_SOURCES)[number];

export const TAKEOVER_RELEASE_REASONS = ["manual", "idle_timeout"] as const;
export type TakeoverReleaseReason = (typeof TAKEOVER_RELEASE_REASONS)[number];

export const MODEL_CALL_MODES = ["live", "dry_run"] as const;
export type ModelCallMode = (typeof MODEL_CALL_MODES)[number];

export const INTEGRATION_EVENT_STATUSES = ["pending", "succeeded", "failed", "skipped"] as const;
export type IntegrationEventStatus = (typeof INTEGRATION_EVENT_STATUSES)[number];

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "rescheduled",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const SCHEDULED_JOB_STATUSES = [
  "scheduled",
  "running",
  "done",
  "cancelled",
  "failed",
  "skipped",
] as const;
export type ScheduledJobStatus = (typeof SCHEDULED_JOB_STATUSES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "failed",
  "acknowledged",
  "suppressed",
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ESCALATION_STATUSES = ["active", "acknowledged", "exhausted", "cancelled"] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const DEAD_LETTER_STATUSES = ["open", "retried", "resolved", "ignored"] as const;
export type DeadLetterStatus = (typeof DEAD_LETTER_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = ["user", "system", "api_key"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
