import type { EmergencyReadiness, ReadinessProblem } from "@repo/handoff";

import { Callout } from "@/components/ui/callout";

const PROBLEMS: Readonly<Record<ReadinessProblem, string>> = {
  emergency_disabled:
    "Emergency handling is switched off for this business: nobody is alerted about emergencies.",
  no_escalation_contacts:
    "Nobody is in the escalation chain, and the agency has no fallback contacts: an emergency reaches nobody.",
  no_business_chain:
    "The business has no escalation chain of its own: only the agency's fallback contacts are alerted.",
  sms_not_configured:
    "Contacts are to be texted, but this deployment cannot send text messages (Twilio is not set up).",
  voice_not_configured:
    "Unacknowledged alerts are to be followed by a phone call, but this deployment cannot call (Twilio is not set up).",
  email_not_configured: "Contacts are to be emailed, but this deployment cannot send email alerts.",
  whatsapp_not_configured:
    "Contacts are to be messaged on WhatsApp, but this deployment cannot send WhatsApp alerts.",
  no_reachable_contact:
    "No contact in the chain can be reached by any way this deployment can alert: an emergency reaches nobody.",
  no_emergency_alert_recipients: "No alert recipient is set to receive emergency alerts.",
};

/**
 * Whether an emergency at the business reaches a person (C13's `readiness`). "Not ready" is
 * the loudest thing on the page: a business must never look ready while its emergencies
 * would reach nobody.
 */
export function ReadinessPanel({ readiness }: { readonly readiness: EmergencyReadiness }) {
  const counts = `${readiness.businessContacts} in the business's chain, ${readiness.fallbackContacts} agency fallback ${readiness.fallbackContacts === 1 ? "contact" : "contacts"}, ${readiness.alertRecipients} emergency alert ${readiness.alertRecipients === 1 ? "recipient" : "recipients"}.`;
  if (!readiness.enabled) {
    return (
      <Callout tone="warning" title="Emergency handling is off" testId="readiness">
        <p>{PROBLEMS.emergency_disabled}</p>
      </Callout>
    );
  }
  if (!readiness.ready) {
    return (
      <Callout
        tone="danger"
        title="Not ready: an emergency at this business would reach nobody"
        testId="readiness"
      >
        <ul className="list-disc space-y-0.5 pl-5">
          {readiness.problems.map((problem) => (
            <li key={problem}>{PROBLEMS[problem]}</li>
          ))}
        </ul>
        <p className="pt-1">{counts}</p>
        <p>
          Add at least one person to the escalation chain below, reachable by a way this deployment
          can send.
        </p>
      </Callout>
    );
  }
  return (
    <Callout
      tone={readiness.problems.length > 0 ? "warning" : "success"}
      title="Ready: emergencies reach a person"
      testId="readiness"
    >
      {readiness.problems.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {readiness.problems.map((problem) => (
            <li key={problem}>{PROBLEMS[problem]}</li>
          ))}
        </ul>
      )}
      <p>{counts}</p>
    </Callout>
  );
}
