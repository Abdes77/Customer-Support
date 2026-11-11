import { defineCategory, GLOBAL_ONLY, setting } from "../define";
import { f } from "../fields";

/**
 * How long data is kept. Consumed by the retention job (C17). "Keep" means kept until the
 * business is deleted.
 */
export const dataSettings = defineCategory("data", {
  "data.conversation_retention_days": setting({
    label: "Keep conversations for",
    help: "Conversations and their messages are deleted this long after the conversation was closed.",
    field: f.nullable(f.integer({ min: 30, max: 3650, unit: "days" }), "Keep"),
    default: 730,
  }),
  "data.attachment_retention_days": setting({
    label: "Keep photos and files for",
    help: "Photos and files customers sent are deleted this long after they arrived. Their descriptions stay in the lead report.",
    field: f.nullable(f.integer({ min: 7, max: 3650, unit: "days" }), "Keep"),
    default: 365,
  }),
  "data.lead_retention_days": setting({
    label: "Keep leads for",
    help: "Leads, their scores and reports are deleted this long after the last change.",
    field: f.nullable(f.integer({ min: 30, max: 3650, unit: "days" }), "Keep"),
    default: null,
  }),
  "data.model_call_retention_days": setting({
    label: "Keep model records for",
    help: "The full inputs and outputs of model calls are deleted after this long. Token counts and costs are kept.",
    field: f.integer({ min: 1, max: 730, unit: "days" }),
    default: 90,
  }),
  "data.store_model_io": setting({
    label: "Store model inputs and outputs",
    help: "Every model call is stored with its full request and response, for audits and for improving the bot. When off, only token counts, timing and cost are stored.",
    field: f.boolean(),
    default: true,
  }),
  "data.audit_log_retention_days": setting({
    label: "Keep the audit log for",
    help: "Audit entries older than this are deleted.",
    field: f.nullable(f.integer({ min: 90, max: 3650, unit: "days" }), "Keep"),
    default: 1095,
    scopes: GLOBAL_ONLY,
  }),
});
