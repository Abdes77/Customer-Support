"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { SegmentId, ValidationError } from "@repo/core";
import { createBusiness, setBusinessStatus, updateBusinessProfile } from "@repo/db";

import type { ProfileFormState, ProfileValues } from "@/components/business/profile-form";
import {
  type ActionResult,
  actionBusiness,
  actionSession,
  adminLogger,
  runAction,
} from "@/server/admin";
import { ActionError, toFailure } from "@/server/admin/result";
import { userDatabase } from "@/server/auth";
import { getHandoff } from "@/server/handoff";
import { getKnowledge } from "@/server/knowledge";

/*
 * Server actions for businesses: create, profile, segment, status. Each checks the request's
 * origin and the session first; the business is looked up as the signed-in person (row-level
 * security), so a business id from the form only names what the person may already see.
 */

const PROFILE_FIELDS = [
  "name",
  "timezone",
  "websiteUrl",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
] as const satisfies readonly (keyof ProfileValues)[];

function profileFrom(form: FormData): ProfileValues {
  const values = {} as Record<(typeof PROFILE_FIELDS)[number], string>;
  for (const field of PROFILE_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === "string" ? raw.slice(0, 400) : "";
  }
  return values;
}

function profileFailure(error: unknown, values: ProfileValues, action: string): ProfileFormState {
  if (error instanceof ValidationError) {
    const fieldErrors: Record<string, string> = {};
    const problems = error.details["problems"];
    if (Array.isArray(problems)) {
      for (const problem of problems as { field?: unknown; message?: unknown }[]) {
        if (typeof problem.field === "string" && typeof problem.message === "string") {
          fieldErrors[problem.field] ??= problem.message;
        }
      }
    }
    return { error: "Check the marked fields.", fieldErrors, values };
  }
  const failure = toFailure(error, adminLogger, action);
  return { error: failure.ok ? null : failure.error, fieldErrors: {}, values };
}

/** Creates the business (as agency staff) and opens the wizard's next step. */
export async function createBusinessAction(
  _state: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const values = profileFrom(form);
  let businessId: string;
  try {
    const session = await actionSession();
    // The agency the form was opened for, among the person's own memberships only; with
    // several agencies the form must say which one.
    const requested = form.get("agencyId");
    const agencies = session.access.agencies;
    if (agencies.length === 0) throw new ActionError("Only agency staff can onboard a business.");
    const agency =
      typeof requested === "string" && requested !== ""
        ? agencies.find((candidate) => candidate.agencyId === requested)
        : agencies.length === 1
          ? agencies[0]
          : undefined;
    if (agency === undefined) {
      throw new ActionError("Choose the agency this business belongs to. Reload the page.");
    }
    const created = await userDatabase(session.user).run((ctx) =>
      createBusiness(ctx, { agencyId: agency.agencyId, profile: values }),
    );
    businessId = created.id;
  } catch (error) {
    return profileFailure(error, values, "business.create");
  }
  redirect(`/businesses/${businessId}/onboarding/segment` as Route);
}

/** Saves the profile; in the wizard, goes on to the segment step. */
export async function updateProfileAction(
  _state: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const values = profileFrom(form);
  let next: string;
  try {
    const session = await actionSession();
    const { business } = await actionBusiness(session, form.get("businessId"));
    await userDatabase(session.user).run((ctx) =>
      updateBusinessProfile(ctx, { businessId: business.id, profile: values }),
    );
    next =
      business.status === "onboarding"
        ? `/businesses/${business.id}/onboarding/segment`
        : `/businesses/${business.id}`;
    revalidatePath(`/businesses/${business.id}`, "layout");
  } catch (error) {
    return profileFailure(error, values, "business.update");
  }
  redirect(next as Route);
}

const SegmentChoiceInput = z.strictObject({
  businessId: z.string(),
  segment: z.union([
    z.strictObject({ id: SegmentId }),
    z.strictObject({ name: z.string().trim().min(1, "Name the new segment.").max(120) }),
  ]),
});

export interface AssignResult {
  readonly segmentName: string;
  readonly playbook: "reused" | "generating";
  readonly version: number | null;
}

/** Puts the business into a segment: the playbook is reused or generated (C6). */
export async function assignSegmentAction(input: unknown): Promise<ActionResult<AssignResult>> {
  return runAction("business.assign_segment", async (session) => {
    const parsed = SegmentChoiceInput.safeParse(input);
    if (!parsed.success) {
      throw new ActionError(parsed.error.issues[0]?.message ?? "Choose a segment.");
    }
    const { business } = await actionBusiness(session, parsed.data.businessId);
    const result = await getKnowledge().playbooks.assignSegment(session.user, {
      businessId: business.id,
      segment: parsed.data.segment,
    });
    revalidatePath(`/businesses/${business.id}`, "layout");
    return {
      segmentName: result.segment.name,
      playbook: result.playbook.status,
      version: result.playbook.status === "reused" ? result.playbook.version : null,
    };
  });
}

export interface ActivateState {
  readonly error: string | null;
}

/**
 * Finishes onboarding. When an emergency at the business would reach nobody, activation
 * needs the explicit acknowledgement from the form; the readiness is read again here, not
 * taken from the page.
 */
export async function activateBusinessAction(
  _state: ActivateState,
  form: FormData,
): Promise<ActivateState> {
  let businessId: string;
  try {
    const session = await actionSession();
    const { business, tenant } = await actionBusiness(session, form.get("businessId"));
    if (business.status === "archived") {
      return { error: "This business is archived and cannot be activated here." };
    }
    const readiness = await getHandoff().readiness(tenant);
    if (readiness.enabled && !readiness.ready && form.get("acknowledgeNotReady") !== "yes") {
      return {
        error:
          "Emergencies at this business would reach nobody. Add escalation contacts first, or confirm below that you understand.",
      };
    }
    await userDatabase(session.user).run((ctx) =>
      setBusinessStatus(ctx, { businessId: business.id, status: "active" }),
    );
    adminLogger.info("admin.business.activated", {
      businessId: business.id,
      emergencyReady: readiness.ready,
    });
    businessId = business.id;
    revalidatePath(`/businesses/${business.id}`, "layout");
  } catch (error) {
    const failure = toFailure(error, adminLogger, "business.activate");
    return { error: failure.ok ? null : failure.error };
  }
  redirect(`/businesses/${businessId}?activated=1` as Route);
}

const StatusInput = z.strictObject({
  businessId: z.string(),
  status: z.enum(["active", "paused"]),
  acknowledgeNotReady: z.boolean().optional(),
});

/**
 * Pauses or resumes a live business (archiving is not offered in the panel yet). A business
 * in onboarding is activated only through the wizard's finish step; resuming one whose
 * emergencies would reach nobody needs the same acknowledgement, checked here again.
 */
export async function setStatusAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("business.status", async (session) => {
    const parsed = StatusInput.safeParse(input);
    if (!parsed.success) throw new ActionError("Unknown status.");
    const { business, tenant } = await actionBusiness(session, parsed.data.businessId);
    if (parsed.data.status === "active" && business.status !== "active") {
      if (business.status !== "paused") {
        throw new ActionError("Finish onboarding to activate this business.");
      }
      const readiness = await getHandoff().readiness(tenant);
      if (readiness.enabled && !readiness.ready && parsed.data.acknowledgeNotReady !== true) {
        throw new ActionError(
          "Emergencies at this business would reach nobody. Add escalation contacts first, or confirm that you understand.",
        );
      }
    }
    await userDatabase(session.user).run((ctx) =>
      setBusinessStatus(ctx, { businessId: business.id, status: parsed.data.status }),
    );
    revalidatePath(`/businesses/${business.id}`, "layout");
    return null;
  });
}
