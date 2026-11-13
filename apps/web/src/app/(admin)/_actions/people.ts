"use server";

import { revalidatePath } from "next/cache";

import { type ActionResult, runAction } from "@/server/admin";
import { type AddResult, createPeopleActions, type PeopleActions } from "@/server/people";
import { inviterForDeployment } from "@/server/people/inviter";

/*
 * People management (C18). Each action runs the cross-site check and the session first
 * (`runAction`), then the action in `@/server/people`, which resolves the agency or business
 * again from the session and checks who may do what.
 */

function actions(): PeopleActions {
  const inviter = inviterForDeployment();
  return "unavailable" in inviter
    ? createPeopleActions({ inviter: null, unavailable: inviter.unavailable })
    : createPeopleActions({ inviter });
}

function refresh(input: unknown): void {
  const businessId = (input as { businessId?: unknown } | null)?.businessId;
  if (typeof businessId === "string" && /^[0-9a-f-]{36}$/.test(businessId)) {
    revalidatePath(`/businesses/${businessId}/people`);
  } else {
    revalidatePath("/people");
  }
}

export async function addAgencyPersonAction(input: unknown): Promise<ActionResult<AddResult>> {
  return runAction("people.agency.add", async (session) => {
    const result = await actions().addAgencyPerson(session, input);
    refresh(input);
    return result;
  });
}

export async function changeAgencyRoleAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("people.agency.role", async (session) => {
    const message = await actions().changeAgencyRole(session, input);
    refresh(input);
    return message;
  });
}

export async function removeAgencyPersonAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("people.agency.remove", async (session) => {
    const message = await actions().removeAgencyPerson(session, input);
    refresh(input);
    return message;
  });
}

export async function addBusinessPersonAction(input: unknown): Promise<ActionResult<AddResult>> {
  return runAction("people.business.add", async (session) => {
    const result = await actions().addBusinessPerson(session, input);
    refresh(input);
    return result;
  });
}

export async function changeBusinessRoleAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("people.business.role", async (session) => {
    const message = await actions().changeBusinessRole(session, input);
    refresh(input);
    return message;
  });
}

export async function removeBusinessPersonAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("people.business.remove", async (session) => {
    const message = await actions().removeBusinessPerson(session, input);
    refresh(input);
    return message;
  });
}
