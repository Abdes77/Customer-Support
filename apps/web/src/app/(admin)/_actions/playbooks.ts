"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { SegmentId } from "@repo/core";

import { type ActionResult, actionBusiness, runAction } from "@/server/admin";
import { ActionError } from "@/server/admin/result";
import { getKnowledge } from "@/server/knowledge";

/*
 * Server actions for playbooks (C6's service). Each version is immutable: an edit or a
 * rollback stores a new version. The service checks that the person is staff of the
 * segment's agency; `baseVersion` refuses a save made from a version that is no longer the
 * one in force.
 */

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ActionError("That request could not be read. Reload the page.");
  return parsed.data;
}

export interface SavedVersion {
  readonly version: number;
  readonly created: boolean;
  readonly warnings: readonly string[];
}

const SaveInput = z.strictObject({
  segmentId: SegmentId,
  document: z.json(),
  changeNote: z.string().trim().max(300),
  baseVersion: z.number().int().positive().nullable(),
});

export async function savePlaybookAction(input: unknown): Promise<ActionResult<SavedVersion>> {
  return runAction("playbook.save", async (session) => {
    const data = parse(SaveInput, input);
    const saved = await getKnowledge().playbooks.saveEdit(session.user, {
      segmentId: data.segmentId,
      document: data.document,
      changeNote: data.changeNote === "" ? null : data.changeNote,
      baseVersion: data.baseVersion,
    });
    revalidatePath(`/playbooks/${data.segmentId}`);
    return {
      version: saved.version,
      created: saved.created,
      warnings: saved.warnings.map(
        (issue) => `${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`,
      ),
    };
  });
}

const RollbackInput = z.strictObject({
  segmentId: SegmentId,
  toVersion: z.number().int().positive(),
  baseVersion: z.number().int().positive().nullable(),
});

export async function rollbackPlaybookAction(input: unknown): Promise<ActionResult<number>> {
  return runAction("playbook.rollback", async (session) => {
    const data = parse(RollbackInput, input);
    const saved = await getKnowledge().playbooks.rollback(session.user, data);
    revalidatePath(`/playbooks/${data.segmentId}`);
    return saved.version;
  });
}

export async function regeneratePlaybookAction(input: unknown): Promise<ActionResult<boolean>> {
  return runAction("playbook.regenerate", async (session) => {
    const { segmentId } = parse(z.strictObject({ segmentId: SegmentId }), input);
    const result = await getKnowledge().playbooks.regenerate(session.user, segmentId);
    revalidatePath(`/playbooks/${segmentId}`);
    return result.started;
  });
}

const OverrideInput = z.strictObject({
  businessId: z.string(),
  section: z.string().max(60),
  content: z.json(),
});

export async function setOverrideAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("playbook.override", async (session) => {
    const data = parse(OverrideInput, input);
    const { business } = await actionBusiness(session, data.businessId);
    await getKnowledge().playbooks.setOverride(session.user, {
      businessId: business.id,
      section: data.section,
      content: data.content,
    });
    revalidatePath(`/businesses/${business.id}/playbook`);
    return null;
  });
}

export async function clearOverrideAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("playbook.clear_override", async (session) => {
    const data = parse(
      z.strictObject({ businessId: z.string(), section: z.string().max(60) }),
      input,
    );
    const { business } = await actionBusiness(session, data.businessId);
    await getKnowledge().playbooks.clearOverride(session.user, {
      businessId: business.id,
      section: data.section,
    });
    revalidatePath(`/businesses/${business.id}/playbook`);
    return null;
  });
}
