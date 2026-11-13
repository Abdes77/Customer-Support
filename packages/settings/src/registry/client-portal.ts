import { BUSINESS_ONLY, defineCategory, setting } from "../define";
import { f } from "../fields";

/** Who among a business's own users may do something. */
const WHO = [
  ["nobody", "Nobody", "Only agency staff."],
  ["owner", "The owner"],
  ["owner_and_staff", "The owner and their staff"],
] as const;
export type ClientPermission = (typeof WHO)[number][0];

/**
 * What the business's own users (client owner, client staff) may see and do. Enforced in
 * server code (C16) on top of row-level security. None of these can be changed by a client
 * user.
 */
export const clientPortalSettings = defineCategory("client_portal", {
  "client_portal.enabled": setting({
    label: "Client logins",
    help: "The business's own users can sign in to a limited view of their business. When off, their logins show nothing. This is the master switch; the settings below narrow what they get.",
    field: f.boolean(),
    default: false,
    scopes: BUSINESS_ONLY,
  }),
  "client_portal.view_conversations": setting({
    label: "See conversations",
    help: "Who may read the business's conversations.",
    field: f.select(WHO),
    default: "owner_and_staff",
  }),
  "client_portal.reply_and_take_over": setting({
    label: "Take over and reply",
    help: "Who may take a conversation over from the bot and answer customers themselves.",
    field: f.select(WHO),
    default: "nobody",
  }),
  "client_portal.view_leads": setting({
    label: "See leads",
    help: "Who may see the lead list with scores.",
    field: f.select(WHO),
    default: "owner_and_staff",
  }),
  "client_portal.view_lead_reports": setting({
    label: "See lead reports",
    help: "Who may read the written lead reports, which include red flags and candid notes.",
    field: f.select(WHO),
    default: "owner",
  }),
  "client_portal.export_leads": setting({
    label: "Export leads",
    help: "Who may download the lead list as a file.",
    field: f.select(WHO),
    default: "owner",
  }),
  "client_portal.view_analytics": setting({
    label: "See analytics",
    help: "Who may see the business's analytics.",
    field: f.select(WHO),
    default: "owner",
  }),
  "client_portal.edit_knowledge": setting({
    label: "Edit knowledge",
    help: "Who may edit the business's knowledge: services, hours, warranties and the rest.",
    field: f.select(WHO),
    default: "nobody",
  }),
  "client_portal.edit_settings": setting({
    label: "Edit settings",
    help: 'Who may change the settings that are marked "client may edit", such as business hours, alert recipients and the bot\'s name. Every other setting stays with the agency.',
    field: f.select(WHO),
    default: "owner",
  }),
  "client_portal.owner_manages_staff": setting({
    label: "Owner manages staff logins",
    help: "The business owner may add, change and remove the logins of their own staff (client staff only: never another owner, never themselves). When off, only agency admins manage the business's logins.",
    field: f.boolean(),
    default: false,
  }),
});
