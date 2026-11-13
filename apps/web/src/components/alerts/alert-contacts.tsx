import Link from "next/link";

import { sendTestAlertAction } from "@/app/(admin)/_actions/alerts";
import { SettingsPanel } from "@/components/settings/settings-panel";
import type { BusinessPage } from "@/server/admin";
import { getHandoff } from "@/server/handoff";

import { ReadinessPanel } from "./readiness-panel";

/** The alert and emergency settings of one business, in the order they matter. */
export const ALERT_CONTACT_KEYS = [
  "emergency.escalation_chain",
  "alerts.recipients",
  "emergency.enabled",
  "emergency.acknowledge_minutes",
  "emergency.call_unacknowledged",
  "alerts.events",
] as const;

/**
 * Alert contacts: the emergency readiness first, then the escalation chain and the alert
 * recipients (private settings: shown masked, added and removed one by one, never sent to
 * the browser in full), each with a test alert.
 */
export async function AlertContacts({ page }: { readonly page: BusinessPage }) {
  const readiness = await getHandoff().readiness(page.tenant);
  return (
    <div className="space-y-4">
      <ReadinessPanel readiness={readiness} />
      {page.staff && (
        <p className="text-sm text-slate-600">
          The agency&apos;s fallback contacts, alerted when nobody in a business&apos;s chain
          answers, are in the{" "}
          <Link href="/settings" className="font-medium text-blue-700 underline">
            agency settings
          </Link>{" "}
          under Emergencies.
        </p>
      )}
      <SettingsPanel
        session={page}
        target={{ scope: "business", businessId: page.business.id }}
        onlyKeys={ALERT_CONTACT_KEYS}
        actions={{ testEntry: sendTestAlertAction }}
      />
    </div>
  );
}
