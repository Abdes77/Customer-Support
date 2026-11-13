"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { assignSegmentAction } from "@/app/(admin)/_actions/business";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/form";

export interface SegmentOption {
  readonly id: string;
  readonly name: string;
  readonly activeVersion: number | null;
  readonly generating: boolean;
}

/**
 * Choose the business's segment: an existing one (its playbook is reused) or a new one (its
 * playbook is generated). What will happen is said next to each choice.
 */
export function SegmentPicker({
  businessId,
  segments,
  currentSegmentId,
  nextHref,
}: {
  readonly businessId: string;
  readonly segments: readonly SegmentOption[];
  readonly currentSegmentId: string | null;
  readonly nextHref: string;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<string>(currentSegmentId ?? segments[0]?.id ?? "new");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await assignSegmentAction({
        businessId,
        segment: choice === "new" ? { name } : { id: choice },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`${nextHref}?assigned=${result.value.playbook}` as Route);
    });
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">Segment</legend>
        {segments.map((segment) => (
          <label
            key={segment.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3",
              choice === segment.id ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white",
            )}
          >
            <input
              type="radio"
              name="segment"
              className="mt-1 accent-blue-700"
              checked={choice === segment.id}
              onChange={() => setChoice(segment.id)}
            />
            <span>
              <span className="block font-medium text-slate-900">{segment.name}</span>
              <span className="block text-sm text-slate-600">
                {segment.activeVersion !== null
                  ? `Its playbook (version ${segment.activeVersion}) is reused: no new research needed.`
                  : segment.generating
                    ? "Its playbook is being written right now."
                    : "It has no playbook yet: one will be generated."}
              </span>
            </span>
          </label>
        ))}
        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3",
            choice === "new" ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white",
          )}
        >
          <input
            type="radio"
            name="segment"
            className="mt-1 accent-blue-700"
            checked={choice === "new"}
            onChange={() => setChoice("new")}
          />
          <span className="flex-1">
            <span className="block font-medium text-slate-900">
              A segment the agency has not served yet
            </span>
            <span className="block text-sm text-slate-600">
              A playbook for it is researched and written now, then reused for later businesses.
            </span>
            {choice === "new" && (
              <Input
                className="mt-2"
                aria-label="Name of the new segment"
                placeholder="For example: Pest control"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </span>
        </label>
      </fieldset>
      {error !== null && <Callout tone="danger">{error}</Callout>}
      <Button onClick={submit} disabled={pending || (choice === "new" && name.trim() === "")}>
        {pending ? "Saving…" : "Save and continue"}
      </Button>
    </div>
  );
}
