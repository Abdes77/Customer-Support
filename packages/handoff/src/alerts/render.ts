import type { ChannelId } from "@repo/core";
import {
  type AppSettings,
  CHANNEL_LABELS,
  renderTemplate,
  settingsChannelOf,
} from "@repo/settings";

import type { ConversationFacts } from "../facts";
import { plainBlock, plainLine } from "../text";

/**
 * The text of an alert, written by code from the lead record and the settings. Customer
 * values are made plain (one line, no markup, inert web addresses); the only link is the
 * conversation in the admin panel, which needs a sign-in. Text messages stay short whatever
 * `alerts.detail` says.
 */

export const ALERT_KINDS = [
  "lead_qualified",
  "meeting_requested",
  "handoff",
  "emergency",
  "lead_disqualified",
  "send_failed",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface RenderedAlert {
  readonly sms: string;
  readonly email: { readonly subject: string; readonly text: string };
  /** One line, the parameter of the WhatsApp alert template. */
  readonly whatsapp: string;
}

const HEADLINES: Readonly<Record<AlertKind, string>> = {
  lead_qualified: "New lead",
  meeting_requested: "Lead wants a meeting",
  handoff: "A conversation needs a person",
  emergency: "Emergency",
  lead_disqualified: "Lead not a fit",
  send_failed: "A message could not be delivered",
};

/** Words in front of the business's own text-message template, per kind. */
const PREFIXES: Readonly<Record<AlertKind, string>> = {
  lead_qualified: "",
  meeting_requested: "",
  handoff: "Needs a person: ",
  emergency: "",
  lead_disqualified: "Not a fit: ",
  send_failed: "",
};

const SMS_MAX = 600;

export function channelLabel(channel: ChannelId): string {
  return CHANNEL_LABELS[settingsChannelOf(channel)];
}

export function bandLabel(values: AppSettings, band: string | null): string {
  const labels = values["scoring.band_labels"];
  if (band === "hot" || band === "warm" || band === "cold") return labels[band];
  return "New";
}

export interface AlertVariables {
  readonly business_name: string;
  readonly band: string;
  readonly score: string;
  readonly contact_name: string;
  readonly contact_phone: string;
  readonly service: string;
  readonly channel: string;
  readonly summary: string;
  readonly link: string;
}

/** The template variables of an alert, every customer value plain. */
export function alertVariables(input: {
  readonly facts: ConversationFacts;
  readonly values: AppSettings;
  readonly link: string;
  /** Emergencies always carry the contact details: the team has to call. */
  readonly forceContactDetails?: boolean;
}): AlertVariables {
  const { facts, values } = input;
  const details = input.forceContactDetails === true || values["alerts.include_contact_details"];
  const name = plainLine(facts.contact.name, 60);
  const phone = plainLine(facts.contact.phone, 30);
  return {
    business_name: plainLine(facts.business.name, 80),
    band: bandLabel(values, facts.lead?.band ?? null),
    score: facts.lead === null ? "-" : String(Math.round(facts.lead.score)),
    contact_name: details ? name || "a new contact" : "a customer (open the conversation)",
    contact_phone: details ? phone : "",
    service: plainLine(facts.lead?.service, 80) || "a job",
    channel: channelLabel(facts.channel),
    summary: plainLine(facts.report?.summary, 300),
    link: input.link,
  };
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A lead alert (or a delivery failure) in every channel's form. */
export function renderLeadAlert(input: {
  readonly kind: AlertKind;
  readonly facts: ConversationFacts;
  readonly values: AppSettings;
  readonly link: string;
  /** For `send_failed`: the pipeline's error code. */
  readonly errorCode?: string | null;
}): RenderedAlert {
  const { kind, facts, values } = input;
  const vars = alertVariables(input);
  const headline = HEADLINES[kind];

  if (kind === "send_failed") {
    const reason = plainLine(input.errorCode ?? "send_failed", 60);
    const sms = oneLine(
      `${headline} to ${vars.contact_name} on ${vars.channel} (${reason}) for ${vars.business_name}. ${vars.link}`,
      SMS_MAX,
    );
    return {
      sms,
      whatsapp: sms,
      email: {
        subject: `${headline}: ${vars.contact_name}, ${vars.channel}`,
        text: [
          `${headline} for ${vars.business_name}.`,
          "",
          `Customer: ${vars.contact_name}${vars.contact_phone ? `, ${vars.contact_phone}` : ""}`,
          `Channel: ${vars.channel}`,
          `Reason: ${reason}`,
          "",
          `Open the conversation (sign-in required): ${vars.link}`,
        ].join("\n"),
      },
    };
  }

  const sms = oneLine(
    `${PREFIXES[kind]}${renderTemplate(values["alerts.sms_template"], { ...vars })}`,
    SMS_MAX,
  );
  const subject = renderTemplate(values["alerts.email_subject_template"], { ...vars });
  const fullReport =
    values["alerts.detail"] === "full_report" && facts.report !== null
      ? plainBlock(facts.report.markdown, 8000)
      : null;
  const lines = [
    `${headline} for ${vars.business_name}: ${vars.band} lead, score ${vars.score}, via ${vars.channel}.`,
    "",
    `Customer: ${vars.contact_name}${vars.contact_phone ? `, ${vars.contact_phone}` : ""}`,
    `Job: ${vars.service}`,
    ...(vars.summary ? ["", `Summary: ${vars.summary}`] : []),
    ...(fullReport !== null ? ["", "Lead report:", "", fullReport] : []),
    "",
    `Open the conversation (sign-in required): ${vars.link}`,
    "",
    "Customer-written details are shown as data; links in them are disabled.",
  ];
  return {
    sms,
    whatsapp: sms,
    email: { subject: `${PREFIXES[kind]}${subject}`, text: lines.join("\n") },
  };
}
