import type { IntegrationId } from "@repo/core";

import {
  BUSINESS_ONLY,
  defineCategory,
  GLOBAL_ONLY,
  group,
  setting,
  type SettingDraft,
} from "../define";
import { f, type FieldValue } from "../fields";

/** The CRMs with a field mapping. The generic webhook sends the canonical payload as it is. */
export const CRM_IDS = [
  "hubspot",
  "gohighlevel",
  "jobber",
  "housecall_pro",
  "servicetitan",
] as const satisfies readonly IntegrationId[];
export type CrmId = (typeof CRM_IDS)[number];

export const CRM_LABELS: Readonly<Record<CrmId, string>> = {
  hubspot: "HubSpot",
  gohighlevel: "GoHighLevel",
  jobber: "Jobber",
  housecall_pro: "Housecall Pro",
  servicetitan: "ServiceTitan",
};

/** The `lead.*` events of `@repo/core`, as the names used in settings. */
export const LEAD_EVENT_OPTIONS = [
  ["lead_qualified", "A lead is qualified"],
  ["meeting_requested", "A meeting is requested or booked"],
  ["handoff", "A conversation is handed to a person"],
  ["lead_disqualified", "A lead is disqualified"],
  ["emergency", "An emergency is detected"],
] as const;

/**
 * One row of a field mapping, the stored form of `FieldMappingEntry` in `@repo/core`
 * (`transform: null` there is an absent `transform`).
 */
const fieldMapping = f.list(
  f.object({
    source: {
      label: "Our field",
      help: "A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.",
      field: f.text({ minLength: 1, maxLength: 120, placeholder: "lead.fields.timeline" }),
    },
    target: {
      label: "CRM field",
      help: "The field's name in the CRM, as its API calls it.",
      field: f.text({ minLength: 1, maxLength: 120 }),
    },
    transform: {
      label: "Convert to",
      field: f.nullable(
        f.select([
          ["string", "Text"],
          ["number", "Number"],
          ["boolean", "Yes / no"],
          ["date", "Date"],
          ["phone_e164", "Phone number (+1...)"],
        ]),
        "As it is",
      ),
    },
  }),
  { itemLabel: "mapping", maxItems: 80, unique: "target" },
);

const webhookTarget = f.object(
  {
    name: { label: "Name", field: f.text({ minLength: 1, maxLength: 60 }) },
    url: {
      label: "Address",
      help: "Must start with https://.",
      field: f.text({ format: "url", minLength: 1, maxLength: 1000 }),
    },
    events: { label: "Events", field: f.multiSelect(LEAD_EVENT_OPTIONS, { minItems: 1 }) },
    active: { label: "Active", field: f.boolean() },
  },
  {
    check: (target) =>
      target.url.startsWith("https://")
        ? []
        : [{ path: ["url"], message: "Webhook addresses must start with https://." }],
  },
);

type MappingSettings = {
  readonly [K in CrmId as `integrations.field_mapping.${K}`]: SettingDraft<
    FieldValue<typeof fieldMapping>
  >;
};

function mappingSettings(): MappingSettings {
  const drafts: Record<string, SettingDraft> = {};
  for (const crm of CRM_IDS) {
    drafts[`integrations.field_mapping.${crm}`] = setting({
      label: `${CRM_LABELS[crm]} field mapping`,
      help: `Which of our lead fields go into which ${CRM_LABELS[crm]} fields. Empty uses the standard mapping for ${CRM_LABELS[crm]}; with entries, exactly the listed fields are sent.`,
      field: fieldMapping,
      default: [],
    });
  }
  return drafts as MappingSettings;
}

/**
 * When leads go to a CRM, field mapping and outgoing webhooks. Consumed by the connectors
 * (C14). Accounts and credentials are integration connections, not settings; a webhook's
 * signing secret is stored encrypted with its connection.
 */
export const integrationsSettings = defineCategory("integrations", {
  "integrations.sync_events": setting({
    label: "Send leads to the CRM when",
    help: "The events that create or update the lead in every connected CRM.",
    field: f.multiSelect(LEAD_EVENT_OPTIONS),
    default: ["lead_qualified", "meeting_requested", "handoff"],
  }),
  "integrations.minimum_score": setting({
    label: "Lowest score sent to the CRM",
    help: "Leads below this score stay out of the CRM. Handoffs and emergencies are always sent when their event is switched on.",
    field: f.integer({ min: 0, max: 100, unit: "points" }),
    default: 0,
  }),
  "integrations.update_on_change": setting({
    label: "Keep the CRM record up to date",
    help: "After the first push, later changes to the lead (new answers, a new score, a booking) update the same CRM record.",
    field: f.boolean(),
    default: true,
  }),
  "integrations.duplicates": setting({
    label: "People already in the CRM",
    help: "What happens when the CRM already has a contact with the same phone number or email address.",
    field: f.select([
      ["update_existing", "Update the existing contact"],
      ["always_create", "Always create a new one"],
    ]),
    default: "update_existing",
  }),
  "integrations.include_report": setting({
    label: "Lead report in the CRM",
    help: "The written lead report is added to the CRM record as a note.",
    field: f.boolean(),
    default: true,
  }),
  "integrations.include_transcript": setting({
    label: "Conversation in the CRM",
    help: "The conversation transcript is added to the CRM record as a note. Off by default: the report carries a link to the conversation.",
    field: f.boolean(),
    default: false,
  }),
  "integrations.lead_source": setting({
    label: "Lead source",
    help: "The value written to the CRM's lead-source field.",
    field: f.text({ minLength: 1, maxLength: 80 }),
    default: "AI assistant",
  }),
  "integrations.tags": setting({
    label: "Tags",
    help: "Tags added to the CRM record, in CRMs that have tags.",
    field: f.stringList({ itemLabel: "tag", maxItems: 20, maxLength: 60 }),
    default: ["ai-assistant"],
  }),
  ...group("Field mapping", mappingSettings()),
  ...group("Outgoing webhooks", {
    "integrations.webhooks": setting({
      label: "Webhook targets",
      help: "Addresses that receive a signed HTTPS request for the chosen events of this business. Works with Zapier, Make and your own systems.",
      field: f.list(webhookTarget, { itemLabel: "webhook", maxItems: 10, unique: "name" }),
      default: [],
      scopes: BUSINESS_ONLY,
      sensitive: true,
    }),
    "integrations.agency_webhooks": setting({
      label: "Agency webhook targets",
      help: "Addresses that receive the chosen events of every business, in addition to each business's own targets.",
      field: f.list(webhookTarget, { itemLabel: "webhook", maxItems: 10, unique: "name" }),
      default: [],
      scopes: GLOBAL_ONLY,
      sensitive: true,
    }),
    "integrations.webhook_include_transcript": setting({
      label: "Conversation in webhook payloads",
      help: "Webhook requests carry the conversation transcript in addition to the lead and its report.",
      field: f.boolean(),
      default: false,
    }),
  }),
});
