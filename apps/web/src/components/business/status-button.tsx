"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setStatusAction } from "@/app/(admin)/_actions/business";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";

/**
 * Pauses a live business (the bot stops answering its customers) or resumes it. Resuming a
 * business whose emergencies would reach nobody needs the same acknowledgement as the
 * wizard's finish step; the server checks the readiness again.
 */
export function StatusButton({
  businessId,
  status,
  emergencyReady = true,
}: {
  readonly businessId: string;
  readonly status: "active" | "paused";
  readonly emergencyReady?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();
  const next = status === "active" ? "paused" : "active";
  const needsAcknowledgement = next === "active" && !emergencyReady;
  return (
    <div className="space-y-3">
      {needsAcknowledgement && (
        <label className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950">
          <Checkbox
            className="mt-0.5"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand that an emergency at this business would currently reach{" "}
            <strong>nobody</strong> by text or phone.
          </span>
        </label>
      )}
      <Button
        variant={status === "active" ? "secondary" : "primary"}
        size="sm"
        disabled={pending || (needsAcknowledgement && !acknowledged)}
        onClick={() =>
          startTransition(async () => {
            try {
              const result = await setStatusAction({
                businessId,
                status: next,
                ...(needsAcknowledgement ? { acknowledgeNotReady: acknowledged } : {}),
              });
              if (result.ok) {
                setError(null);
                router.refresh();
              } else {
                setError(result.error);
              }
            } catch {
              setError("The change could not be sent. Check your connection and try again.");
            }
          })
        }
      >
        {status === "active" ? "Pause the business" : "Resume the business"}
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
