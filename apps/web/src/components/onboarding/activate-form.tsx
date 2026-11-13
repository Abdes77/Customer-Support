"use client";

import { useActionState, useState } from "react";

import { activateBusinessAction, type ActivateState } from "@/app/(admin)/_actions/business";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/form";

/**
 * Finishes onboarding. When emergencies would reach nobody, the person must say so in so
 * many words before the business goes live; the server checks the readiness again.
 */
export function ActivateForm({
  businessId,
  emergencyReady,
}: {
  readonly businessId: string;
  readonly emergencyReady: boolean;
}) {
  const [state, action, pending] = useActionState<ActivateState, FormData>(activateBusinessAction, {
    error: null,
  });
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="businessId" value={businessId} />
      {!emergencyReady && (
        <label className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950">
          <Checkbox
            name="acknowledgeNotReady"
            value="yes"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand that an emergency at this business (a gas smell, a fire, a flood) would
            currently reach <strong>nobody</strong> by text or phone, and I will add escalation
            contacts.
          </span>
        </label>
      )}
      {state.error !== null && <Callout tone="danger">{state.error}</Callout>}
      <Button type="submit" disabled={pending || (!emergencyReady && !acknowledged)}>
        {pending ? "Activating…" : "Activate the business"}
      </Button>
    </form>
  );
}
