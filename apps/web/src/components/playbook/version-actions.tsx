"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { regeneratePlaybookAction, rollbackPlaybookAction } from "@/app/(admin)/_actions/playbooks";
import { Button } from "@/components/ui/button";

/** Makes an earlier version the one in force again (as a new version, a copy of it). */
export function RollbackButton({
  segmentId,
  toVersion,
  baseVersion,
}: {
  readonly segmentId: string;
  readonly toVersion: number;
  readonly baseVersion: number | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await rollbackPlaybookAction({ segmentId, toVersion, baseVersion });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/playbooks/${segmentId}?saved=${result.value}` as Route);
            router.refresh();
          })
        }
      >
        Roll back to this version
      </Button>
      {error !== null && (
        <span role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

/** Researches and writes the playbook again (a new version when it succeeds). */
export function RegenerateButton({
  segmentId,
  disabled,
}: {
  readonly segmentId: string;
  readonly disabled?: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || disabled === true}
        onClick={() =>
          startTransition(async () => {
            const result = await regeneratePlaybookAction({ segmentId });
            setMessage(
              result.ok
                ? result.value
                  ? "Generation started."
                  : "A generation is already under way."
                : result.error,
            );
            router.refresh();
          })
        }
      >
        Regenerate
      </Button>
      {message !== null && (
        <span role="status" className="mt-1 text-xs text-slate-700">
          {message}
        </span>
      )}
    </span>
  );
}
