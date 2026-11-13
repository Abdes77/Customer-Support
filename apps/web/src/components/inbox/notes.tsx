"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addNoteAction, assignAction, deleteNoteAction } from "@/app/(admin)/_actions/inbox";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/form";

/** Internal notes on a conversation: agency staff only, never shown to customers or clients. */
export function NotesPanel({
  conversationId,
  notes,
  currentUserId,
  isAdmin,
}: {
  readonly conversationId: string;
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly authorUserId: string | null;
    readonly authorName: string | null;
    readonly createdAt: string;
    readonly when: string;
  }[];
  readonly currentUserId: string;
  readonly isAdmin: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    startTransition(async () => {
      try {
        const result = await fn();
        if (result.ok) {
          setError(null);
          after?.();
          router.refresh();
        } else {
          setError(result.error ?? "That did not work.");
        }
      } catch {
        setError("That could not be sent. Try again.");
      }
    });

  return (
    <div className="space-y-3">
      {notes.length === 0 ? (
        <p className="text-sm text-slate-500">No notes yet.</p>
      ) : (
        <ul className="space-y-2" aria-label="Internal notes">
          {notes.map((note) => (
            <li key={note.id} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-sm break-words whitespace-pre-wrap text-slate-900">{note.body}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span>{note.authorName ?? "Former staff member"}</span>
                <span>· {note.when}</span>
                {(note.authorUserId === currentUserId || isAdmin) && (
                  <button
                    type="button"
                    className="ml-auto text-red-700 hover:underline"
                    disabled={pending}
                    onClick={() => run(() => deleteNoteAction({ conversationId, noteId: note.id }))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim() === "") return;
          run(
            () => addNoteAction({ conversationId, body }),
            () => setBody(""),
          );
        }}
      >
        <label htmlFor="note" className="sr-only">
          New internal note
        </label>
        <Textarea
          id="note"
          rows={2}
          maxLength={4000}
          value={body}
          placeholder="A note for the team (customers and clients never see it)"
          onChange={(event) => setBody(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={pending || body.trim() === ""}
        >
          Add note
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** Who on the agency's team owns the conversation. */
export function AssignForm({
  conversationId,
  assignedUserId,
  staff,
}: {
  readonly conversationId: string;
  readonly assignedUserId: string | null;
  readonly staff: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-1">
      <label htmlFor="assignee" className="text-sm font-medium text-slate-800">
        Assigned to
      </label>
      <Select
        id="assignee"
        value={assignedUserId ?? ""}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value;
          startTransition(async () => {
            try {
              const result = await assignAction({
                conversationId,
                assigneeId: value === "" ? null : value,
              });
              if (result.ok) {
                setError(null);
                router.refresh();
              } else setError(result.error);
            } catch {
              setError("That could not be sent. Try again.");
            }
          });
        }}
      >
        <option value="">Nobody</option>
        {staff.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </Select>
      {error !== null && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
