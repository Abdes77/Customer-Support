"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  PLAYBOOK_SECTION_LABELS,
  PLAYBOOK_SECTIONS,
  type PlaybookDocument,
  type PlaybookSection,
} from "@repo/core";

import { savePlaybookAction } from "@/app/(admin)/_actions/playbooks";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/components/ui/cn";
import { Field, Input } from "@/components/ui/form";

import { SectionEditor } from "./section-editor";

/**
 * Edits a segment's playbook. Saving stores a new version (versions never change) and makes
 * it the one in force; it is refused if someone saved another version meanwhile.
 */
export function PlaybookEditor({
  segmentId,
  baseVersion,
  document,
}: {
  readonly segmentId: string;
  readonly baseVersion: number | null;
  readonly document: PlaybookDocument;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<PlaybookSection, unknown[]>>(() =>
    structuredClone(document),
  );
  const [section, setSection] = useState<PlaybookSection>("commonJobs");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    setProblems([]);
    startTransition(async () => {
      const result = await savePlaybookAction({
        segmentId,
        document: draft,
        changeNote: note,
        baseVersion,
      });
      if (!result.ok) {
        setError(result.error);
        setProblems(
          (result.problems ?? []).map(
            (problem) =>
              `${problem.path.join(".")}${problem.path.length > 0 ? ": " : ""}${problem.message}`,
          ),
        );
        return;
      }
      router.push(`/playbooks/${segmentId}?saved=${result.value.version}` as Route);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <nav aria-label="Playbook sections" className="lg:w-64 lg:shrink-0">
          <select
            aria-label="Section"
            className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base lg:hidden"
            value={section}
            onChange={(event) => setSection(event.target.value as PlaybookSection)}
          >
            {PLAYBOOK_SECTIONS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {PLAYBOOK_SECTION_LABELS[candidate]} ({draft[candidate].length})
              </option>
            ))}
          </select>
          <ul className="hidden flex-col gap-0.5 lg:flex">
            {PLAYBOOK_SECTIONS.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  onClick={() => setSection(candidate)}
                  aria-current={candidate === section ? "true" : undefined}
                  className={cn(
                    "flex w-full justify-between rounded-md px-3 py-1.5 text-left text-sm",
                    candidate === section
                      ? "bg-blue-50 font-medium text-blue-800"
                      : "text-slate-700 hover:bg-slate-100",
                  )}
                >
                  {PLAYBOOK_SECTION_LABELS[candidate]}
                  <span className="text-slate-400">{draft[candidate].length}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">
            {PLAYBOOK_SECTION_LABELS[section]}
          </h2>
          {section === "priceNorms" && (
            <p className="mb-3 text-sm text-slate-600">
              Dollar figures belong here only. The bot sees them only when the pricing settings
              allow it.
            </p>
          )}
          <SectionEditor
            section={section}
            value={draft[section]}
            disabled={pending}
            onChange={(value) => setDraft({ ...draft, [section]: value })}
          />
        </div>
      </div>
      <div className="space-y-3 border-t border-slate-200 pt-4">
        {error !== null && (
          <Callout tone="danger" title={error}>
            {problems.length > 0 && (
              <ul className="list-disc pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}
        <Field label="What changed (kept with the version)">
          <Input
            value={note}
            maxLength={300}
            onChange={(event) => setNote(event.target.value)}
            placeholder="For example: added storm-season questions"
          />
        </Field>
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save as a new version"}
        </Button>
      </div>
    </div>
  );
}
