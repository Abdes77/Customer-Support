import type { AppSettings } from "@repo/settings";

import { chainFromSettings } from "./emergency/policy";
import type { AlertTransports } from "./transports/types";

/*
 * Whether a business's emergencies reach a person (C13 review). Both escalation chains start
 * empty, and a deployment without Twilio cannot text or call: an emergency then only raises a
 * critical alert in the admin panel. This says so plainly, for C15's onboarding wizard (the
 * alert contacts step), C17's readiness check and the sweeper's daily in-app warning.
 */

export type ReadinessProblem =
  /** Emergency handling is switched off: nobody is alerted, by design of the business. */
  | "emergency_disabled"
  /** Nobody in the business's chain and nobody in the agency's fallback contacts. */
  | "no_escalation_contacts"
  /** The business's own chain is empty (the agency's fallback contacts are alerted). */
  | "no_business_chain"
  /** Contacts are to be texted or called, but this deployment has no Twilio. */
  | "sms_not_configured"
  | "voice_not_configured"
  | "email_not_configured"
  | "whatsapp_not_configured"
  /** No contact can be reached by any channel this deployment has. */
  | "no_reachable_contact"
  /** Nobody gets the emergency alerts of `alerts.recipients` / `alerts.agency_recipients`. */
  | "no_emergency_alert_recipients";

export interface EmergencyReadiness {
  /** False when an emergency would reach no person outside the admin panel. */
  readonly ready: boolean;
  readonly enabled: boolean;
  /** People in the business's own chain. */
  readonly businessContacts: number;
  /** The agency's fallback contacts. */
  readonly fallbackContacts: number;
  /** Alert recipients who get emergency alerts. */
  readonly alertRecipients: number;
  readonly problems: readonly ReadinessProblem[];
}

type Transports = Pick<AlertTransports, "sms" | "voice" | "email" | "whatsapp">;

/** Pure: the settings of one business and the deployment's transports. */
export function emergencyReadiness(
  values: AppSettings,
  transports: Transports,
): EmergencyReadiness {
  const chain = chainFromSettings(values);
  const businessContacts = chain.filter((contact) => contact.source === "business").length;
  const fallbackContacts = chain.length - businessContacts;
  const recipients = [...values["alerts.recipients"], ...values["alerts.agency_recipients"]].filter(
    (recipient) =>
      values["alerts.events"].includes("emergency") &&
      recipient.active &&
      (recipient.events.length === 0 || recipient.events.includes("emergency")),
  );
  const enabled = values["emergency.enabled"];
  const problems: ReadinessProblem[] = [];
  if (!enabled) problems.push("emergency_disabled");
  if (chain.length === 0) problems.push("no_escalation_contacts");
  else if (businessContacts === 0) problems.push("no_business_chain");
  const wants = new Set(chain.flatMap((contact) => contact.alertBy));
  if (wants.has("sms") && transports.sms === null) problems.push("sms_not_configured");
  if (chain.length > 0 && values["emergency.call_unacknowledged"] && transports.voice === null) {
    problems.push("voice_not_configured");
  }
  if (wants.has("email") && transports.email === null) problems.push("email_not_configured");
  if (wants.has("whatsapp") && transports.whatsapp === null) {
    problems.push("whatsapp_not_configured");
  }
  const reachable = chain.some(
    (contact) =>
      contact.alertBy.some((channel) => transports[channel] !== null) ||
      (values["emergency.call_unacknowledged"] && transports.voice !== null),
  );
  if (chain.length > 0 && !reachable) problems.push("no_reachable_contact");
  if (recipients.length === 0) problems.push("no_emergency_alert_recipients");
  return {
    ready: enabled && reachable,
    enabled,
    businessContacts,
    fallbackContacts,
    alertRecipients: recipients.length,
    problems,
  };
}
