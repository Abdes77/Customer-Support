"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PLAYBOOK_SECTION_LABELS, type PlaybookSection } from "@repo/core";

import { clearOverrideAction, setOverrideAction } from "@/app/(admin)/_actions/playbooks";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

import { SectionEditor } from "./section-editor";

/**
 * One section of a business's playbook: the segment's, or the business's own replacement.
 * Starting an override copies the segment's section as the first draft.
 */
export function OverrideEditor({
  businessId,
  section,
  segmentContent,
  ownContent,
}: {
  readonly businessId: string;
  readonly section: PlaybookSection;
  readonly segmentContent: readonly unknown[];
  readonly ownContent: readonly unknown[] | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (
    action: () => Promise<{
      ok: boolean;
      error?: string;
      problems?: readonly { path: readonly (string | number)[]; message: string }[];
    }>,
  ) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        const details = (result.problems ?? []).map((problem) => problem.message).join(" ");
        setError(`${result.error ?? "That did not work."} ${details}`.trim());
        return;
      }
      setDraft(null);
      router.refresh();
    });
  };

  if (draft !== null) {
    return (
      <div className="space-y-3">
        <SectionEditor section={section} value={draft} onChange={setDraft} disabled={pending} />
        {error !== null && <Callout tone="danger">{error}</Callout>}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => setOverrideAction({ businessId, section, content: draft }))}
          >
            Save this business&apos;s {PLAYBOOK_SECTION_LABELS[section].toLowerCase()}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => setDraft(structuredClone([...(ownContent ?? segmentContent)]))}
      >
        {ownContent === null ? "Use this business's own version" : "Edit"}
      </Button>
      {ownContent !== null && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => clearOverrideAction({ businessId, section }))}
        >
          Use the segment&apos;s again
        </Button>
      )}
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}
