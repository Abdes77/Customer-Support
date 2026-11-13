"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  addAgencyPersonAction,
  addBusinessPersonAction,
  changeAgencyRoleAction,
  changeBusinessRoleAction,
  removeAgencyPersonAction,
  removeBusinessPersonAction,
} from "@/app/(admin)/_actions/people";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form";

export interface PersonRow {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly since: string;
}

export type PeopleScope =
  | { readonly kind: "agency"; readonly agencyId: string }
  | { readonly kind: "business"; readonly businessId: string };

type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Who has access, and (for a person who may manage it) the add form and the per-person role
 * and remove controls. Everything is decided again on the server; this only draws what the
 * page said the person may do. A person never gets controls for their own row.
 */
export function PeopleManager({
  scope,
  people,
  currentUserId,
  roleLabels,
  grantableRoles,
  removableRoles,
  changeRoles,
}: {
  readonly scope: PeopleScope;
  readonly people: readonly PersonRow[];
  readonly currentUserId: string;
  readonly roleLabels: Readonly<Record<string, string>>;
  /** Roles this person may give. Empty: read only. */
  readonly grantableRoles: readonly string[];
  /** Roles of the people this person may remove. */
  readonly removableRoles: readonly string[];
  readonly changeRoles: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(grantableRoles[grantableRoles.length - 1] ?? "");
  const [notice, setNotice] = useState<{ text: string; link: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref =
    scope.kind === "agency" ? { agencyId: scope.agencyId } : { businessId: scope.businessId };

  function run<T>(call: () => Promise<Result<T>>, done: (value: T) => void) {
    startTransition(async () => {
      try {
        const result = await call();
        if (result.ok) {
          setError(null);
          done(result.value);
          router.refresh();
        } else {
          setNotice(null);
          setError(result.error);
        }
      } catch {
        setError("That could not be sent. Try again.");
      }
    });
  }

  const add = () =>
    run(
      () =>
        scope.kind === "agency"
          ? addAgencyPersonAction({ ...ref, email, role })
          : addBusinessPersonAction({ ...ref, email, role }),
      (value) => {
        setEmail("");
        setNotice({ text: value.message, link: value.link });
      },
    );
  const change = (userId: string, next: string) =>
    run(
      () =>
        scope.kind === "agency"
          ? changeAgencyRoleAction({ ...ref, userId, role: next })
          : changeBusinessRoleAction({ ...ref, userId, role: next }),
      (message) => setNotice({ text: message, link: null }),
    );
  const remove = (userId: string) =>
    run(
      () =>
        scope.kind === "agency"
          ? removeAgencyPersonAction({ ...ref, userId })
          : removeBusinessPersonAction({ ...ref, userId }),
      (message) => {
        setConfirming(null);
        setNotice({ text: message, link: null });
      },
    );

  return (
    <div className="space-y-4">
      {grantableRoles.length > 0 && (
        <form
          aria-label="Add a person"
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim() !== "") add();
          }}
        >
          <p className="font-medium text-slate-900">Add a person</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="person-email">Email</Label>
              <Input
                id="person-email"
                type="email"
                autoComplete="off"
                inputMode="email"
                maxLength={254}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:w-48">
              <Label htmlFor="person-role">Role</Label>
              <Select
                id="person-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {grantableRoles.map((option) => (
                  <option key={option} value={option}>
                    {roleLabels[option] ?? option}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" disabled={pending || email.trim() === ""}>
              Add and invite
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            They get an email with a sign-in link. Someone who already has an account gets a sign-in
            link instead of an invitation.
          </p>
        </form>
      )}

      {notice !== null && (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950"
        >
          <p className="break-words">{notice.text}</p>
          {notice.link !== null && (
            <p className="mt-1 break-all">
              <a
                href={notice.link}
                data-testid="local-invite-link"
                className="font-medium text-blue-700 underline"
              >
                Sign-in link for them
              </a>
            </p>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {people.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="font-medium text-slate-800">Nobody has access yet.</p>
        </div>
      ) : (
        <ul
          aria-label="People with access"
          className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          {people.map((person) => {
            const self = person.userId === currentUserId;
            const mayChange = changeRoles && !self && grantableRoles.length > 0;
            const mayRemove = !self && removableRoles.includes(person.role);
            return (
              <li
                key={person.userId}
                data-testid="person-row"
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-all text-slate-900">
                    {person.email}
                    {self && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
                  </p>
                  <p className="text-xs text-slate-500">Since {person.since}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  {mayChange ? (
                    <>
                      <label htmlFor={`role-${person.userId}`} className="sr-only">
                        Role of {person.email}
                      </label>
                      <Select
                        id={`role-${person.userId}`}
                        className="w-full sm:w-44"
                        value={person.role}
                        disabled={pending}
                        onChange={(event) => change(person.userId, event.target.value)}
                      >
                        {grantableRoles.map((option) => (
                          <option key={option} value={option}>
                            {roleLabels[option] ?? option}
                          </option>
                        ))}
                      </Select>
                    </>
                  ) : (
                    <Badge>{roleLabels[person.role] ?? person.role}</Badge>
                  )}
                  {mayRemove &&
                    (confirming === person.userId ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={pending}
                          onClick={() => remove(person.userId)}
                        >
                          Confirm removal
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending}
                        onClick={() => setConfirming(person.userId)}
                      >
                        Remove
                      </Button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
