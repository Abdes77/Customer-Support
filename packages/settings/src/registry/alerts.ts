import { BUSINESS_ONLY, defineCategory, GLOBAL_ONLY, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

/** What can trigger an alert. The first five are the `lead.*` events of `@repo/core`. */
export const ALERT_EVENTS = [
  "lead_qualified",
  "meeting_requested",
  "handoff",
  "emergency",
  "lead_disqualified",
  "send_failed",
] as const;

const ALERT_EVENT_OPTIONS = [
  ["lead_qualified", "A lead is qualified"],
  ["meeting_requested", "A meeting is requested or booked"],
  ["handoff", "A conversation is handed to a person"],
  ["emergency", "An emergency is detected"],
  ["lead_disqualified", "A lead is disqualified"],
  ["send_failed", "A message could not be delivered"],
] as const;

const recipient = f.object(
  {
    name: { label: "Name", field: f.text({ minLength: 1, maxLength: 80 }) },
    email: { label: "Email", field: f.text({ format: "email" }) },
    phone: {
      label: "Mobile number",
      help: "For text messages and WhatsApp.",
      field: f.text({ format: "phone" }),
    },
    channels: {
      label: "Alert by",
      field: f.multiSelect(
        [
          ["email", "Email"],
          ["sms", "Text message"],
          ["whatsapp", "WhatsApp"],
        ],
        { minItems: 1 },
      ),
    },
    events: {
      label: "Alert about",
      help: 'Empty: everything that is switched on under "Events that send alerts".',
      field: f.multiSelect(ALERT_EVENT_OPTIONS),
    },
    active: { label: "Active", field: f.boolean() },
  },
  {
    check: (value) => {
      const problems = [];
      if (value.channels.includes("email") && value.email === "") {
        problems.push({ path: ["email"], message: "Add an email address, or remove email." });
      }
      if (
        (value.channels.includes("sms") || value.channels.includes("whatsapp")) &&
        value.phone === ""
      ) {
        problems.push({
          path: ["phone"],
          message: "Add a mobile number, or remove text message and WhatsApp.",
        });
      }
      return problems;
    },
  },
);

/** Who is told about leads, and how. Consumed by alerts (C13). */
export const alertsSettings = defineCategory("alerts", {
  "alerts.events": setting({
    label: "Events that send alerts",
    help: "Which events alert the recipients below. Emergencies have their own escalation chain as well.",
    field: f.multiSelect(ALERT_EVENT_OPTIONS),
    default: ["lead_qualified", "meeting_requested", "handoff", "emergency"],
  }),
  "alerts.recipients": setting({
    label: "Alert recipients",
    help: "The people at the business who are alerted, and how each one is reached.",
    field: f.list(recipient, { itemLabel: "recipient", maxItems: 20, unique: "name" }),
    default: [],
    scopes: BUSINESS_ONLY,
    clientEditable: true,
    sensitive: true,
  }),
  "alerts.agency_recipients": setting({
    label: "Agency recipients",
    help: "Agency staff who are alerted for every business, in addition to each business's own recipients.",
    field: f.list(recipient, { itemLabel: "recipient", maxItems: 20, unique: "name" }),
    default: [],
    scopes: GLOBAL_ONLY,
    sensitive: true,
  }),
  "alerts.minimum_score": setting({
    label: "Lowest score that alerts",
    help: "Qualified-lead alerts are sent only for leads with at least this score. Handoffs and emergencies always alert.",
    field: f.integer({ min: 0, max: 100, unit: "points" }),
    default: 0,
  }),
  "alerts.detail": setting({
    label: "Detail in alerts",
    help: "How much of the lead an alert carries. Text messages always stay short.",
    field: f.select([
      ["summary", "Summary", "Who, what job, where, score and the next step."],
      ["full_report", "Full lead report", "Email alerts include the whole report."],
    ]),
    default: "summary",
  }),
  "alerts.include_contact_details": setting({
    label: "Customer's contact details in alerts",
    help: "Alerts include the customer's name and phone number. When off, recipients open the conversation to see them.",
    field: f.boolean(),
    default: true,
  }),
  "alerts.sms_template": setting({
    label: "Text-message alert",
    help: "The text sent by SMS and WhatsApp for lead alerts.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 400,
      variables: variables(
        "business_name",
        "band",
        "score",
        "contact_name",
        "contact_phone",
        "service",
        "channel",
        "summary",
        "link",
      ),
    }),
    default:
      "{{band}} lead for {{business_name}} ({{score}}): {{contact_name}}, {{service}}, via {{channel}}. {{link}}",
  }),
  "alerts.email_subject_template": setting({
    label: "Email alert subject",
    help: "The subject line of email alerts.",
    field: f.text({
      minLength: 1,
      maxLength: 200,
      variables: variables("business_name", "band", "score", "contact_name", "service", "channel"),
    }),
    default: "{{band}} lead: {{contact_name}}, {{service}}",
  }),
  "alerts.hold_overnight": setting({
    label: "Hold alerts overnight",
    help: "Alerts about qualified and disqualified leads that arise in this window, in the business's time zone, are sent when it ends. Handoffs, emergencies and delivery failures are never held.",
    field: f.dailyWindow({ enabled: "Hold overnight", start: "Hold from", end: "Send at" }),
    default: { enabled: false, start: "21:00", end: "07:00" },
    clientEditable: true,
  }),
});
