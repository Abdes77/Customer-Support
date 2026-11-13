"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setStatusAction } from "@/app/(admin)/_actions/business";
import { Button } from "@/components/ui/button";

/** Pauses a live business (the bot stops answering its customers) or resumes it. */
export function StatusButton({
  businessId,
  status,
}: {
  readonly businessId: string;
  readonly status: "active" | "paused";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const next = status === "active" ? "paused" : "active";
  return (
    <div>
      <Button
        variant={status === "active" ? "secondary" : "primary"}
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setStatusAction({ businessId, status: next });
            if (result.ok) {
              setError(null);
              router.refresh();
            } else {
              setError(result.error);
            }
          })
        }
      >
        {status === "active" ? "Pause the business" : "Resume the business"}
      </Button>
      {error !== null && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
