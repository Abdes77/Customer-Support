"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "@repo/core";

import {
  createFactAction,
  factOperationAction,
  updateFactAction,
} from "@/app/(admin)/_actions/knowledge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";

import { CATEGORY_LABELS, sourceText } from "./categories";

/*
 * The knowledge editor: a business's facts by category. Staff add, edit, pin, confirm,
 * archive and delete; a client user reads. Everything is shown as text.
 */

export interface FactView {
  readonly id: string;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly content: string;
  readonly source: string | null;
  readonly pinned: boolean;
  readonly status: "active" | "archived";
  readonly handEdited: boolean;
  readonly stale: boolean;
  readonly updatedAt: string;
}

interface Draft {
  category: KnowledgeCategory;
  title: string;
  content: string;
  pinned: boolean;
}

const EMPTY: Draft = { category: "services", title: "", content: "", pinned: false };

function FactForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly initial: Draft;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly onSubmit: (draft: Draft) => void;
  readonly onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <Field label="Category">
        <Select
          value={draft.category}
          onChange={(event) =>
            setDraft({ ...draft, category: event.target.value as KnowledgeCategory })
          }
          aria-label="Category"
        >
          {KNOWLEDGE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title">
        <Input
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          aria-label="Title"
          placeholder="For example: Roof replacement"
        />
      </Field>
      <Field label="What the bot may say" className="sm:col-span-2">
        <Textarea
          value={draft.content}
          maxLength={4000}
          rows={3}
          required
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          aria-label="Fact text"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
        <Checkbox
          checked={draft.pinned}
          onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
        />
        Pinned: in every reply, whatever the customer asks about
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending || draft.content.trim() === ""}>
          {submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function KnowledgeEditor({
  businessId,
  facts,
  editable,
}: {
  readonly businessId: string;
  readonly facts: readonly FactView[];
  readonly editable: boolean;
}) {
  const router = useRouter();
  const [category, setCategory] = useState<KnowledgeCategory | "all">("all");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That did not work.");
        return;
      }
      after?.();
      router.refresh();
    });
  };

  const shown = facts.filter(
    (fact) => fact.status === status && (category === "all" || fact.category === category),
  );
  const counts = new Map<string, number>();
  for (const fact of facts)
    if (fact.status === status) counts.set(fact.category, (counts.get(fact.category) ?? 0) + 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          aria-label="Category"
          value={category}
          onChange={(event) => setCategory(event.target.value as KnowledgeCategory | "all")}
          className="sm:w-64"
        >
          <option value="all">All categories</option>
          {KNOWLEDGE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {CATEGORY_LABELS[value]} ({counts.get(value) ?? 0})
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as "active" | "archived")}
          className="sm:w-48"
        >
          <option value="active">In use</option>
          <option value="archived">Archived</option>
        </Select>
        {editable && !adding && (
          <Button className="sm:ml-auto" onClick={() => setAdding(true)}>
            Add a fact
          </Button>
        )}
      </div>

      {error !== null && <Callout tone="danger">{error}</Callout>}

      {adding && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4">
          <p className="mb-3 font-medium text-slate-900">New fact</p>
          <FactForm
            initial={{ ...EMPTY, category: category === "all" ? "services" : category }}
            submitLabel="Add"
            pending={pending}
            onCancel={() => setAdding(false)}
            onSubmit={(draft) =>
              run(
                () => createFactAction({ businessId, item: draft }),
                () => setAdding(false),
              )
            }
          />
        </div>
      )}

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-600">
          {status === "active" ? "No facts here yet." : "Nothing archived."}
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Facts">
          {shown.map((fact) => (
            <li
              key={fact.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid="fact"
            >
              {editing === fact.id ? (
                <FactForm
                  initial={{
                    category: fact.category,
                    title: fact.title,
                    content: fact.content,
                    pinned: fact.pinned,
                  }}
                  submitLabel="Save"
                  pending={pending}
                  onCancel={() => setEditing(null)}
                  onSubmit={(draft) =>
                    run(
                      () => updateFactAction({ businessId, id: fact.id, patch: draft }),
                      () => setEditing(null),
                    )
                  }
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge>{CATEGORY_LABELS[fact.category]}</Badge>
                    {fact.pinned && <Badge tone="blue">Pinned</Badge>}
                    {fact.stale && <Badge tone="amber">Due for review</Badge>}
                    {fact.handEdited && <Badge tone="violet">Edited by hand</Badge>}
                  </div>
                  {fact.title !== "" && (
                    <p className="mt-2 font-medium break-words text-slate-900">{fact.title}</p>
                  )}
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-700">
                    {fact.content}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    {sourceText(fact.source)} · updated {fact.updatedAt.slice(0, 10)}
                  </p>
                  {editable && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {fact.status === "active" ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            onClick={() => setEditing(fact.id)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() =>
                              run(() =>
                                updateFactAction({
                                  businessId,
                                  id: fact.id,
                                  patch: { pinned: !fact.pinned },
                                }),
                              )
                            }
                          >
                            {fact.pinned ? "Unpin" : "Pin"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() =>
                              run(() =>
                                factOperationAction({
                                  businessId,
                                  id: fact.id,
                                  operation: "confirm",
                                }),
                              )
                            }
                          >
                            Still true
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() =>
                              run(() =>
                                factOperationAction({
                                  businessId,
                                  id: fact.id,
                                  operation: "archive",
                                }),
                              )
                            }
                          >
                            Archive
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() =>
                            run(() =>
                              factOperationAction({
                                businessId,
                                id: fact.id,
                                operation: "restore",
                              }),
                            )
                          }
                        >
                          Restore
                        </Button>
                      )}
                      {confirmDelete === fact.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={pending}
                            onClick={() =>
                              run(
                                () =>
                                  factOperationAction({
                                    businessId,
                                    id: fact.id,
                                    operation: "remove",
                                  }),
                                () => setConfirmDelete(null),
                              )
                            }
                          >
                            Delete for good
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setConfirmDelete(fact.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
