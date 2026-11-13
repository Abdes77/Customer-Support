"use server";

import { revalidatePath } from "next/cache";

import { type ActionResult, runAction } from "@/server/admin";
import { getHandoff } from "@/server/handoff";
import { createInboxActions, type InboxActions } from "@/server/inbox";

/*
 * The inbox's server actions (C16). Each runs the cross-site check and the session first
 * (`runAction`), then the action in `@/server/inbox`, which looks the conversation up again
 * as the signed-in person and checks their permissions for its business.
 */

const actions = (): InboxActions => createInboxActions({ handoff: getHandoff() });

function refresh(input: unknown): void {
  const id = (input as { conversationId?: unknown } | null)?.conversationId;
  if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) revalidatePath(`/inbox/${id}`);
}

export async function takeOverAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.take_over", async (session) => {
    const message = await actions().takeOver(session, input);
    refresh(input);
    return message;
  });
}

export async function releaseAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.release", async (session) => {
    const message = await actions().release(session, input);
    refresh(input);
    return message;
  });
}

export async function sendReplyAction(
  input: unknown,
): Promise<ActionResult<{ readonly messageId: string; readonly duplicate: boolean }>> {
  return runAction("inbox.reply", async (session) => {
    const result = await actions().reply(session, input);
    refresh(input);
    return result;
  });
}

export async function typingAction(input: unknown): Promise<ActionResult<boolean>> {
  return runAction("inbox.typing", (session) => actions().typing(session, input));
}

export async function addNoteAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.note_add", async (session) => {
    const message = await actions().addNote(session, input);
    refresh(input);
    return message;
  });
}

export async function deleteNoteAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.note_delete", async (session) => {
    const message = await actions().deleteNote(session, input);
    refresh(input);
    return message;
  });
}

export async function assignAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.assign", async (session) => {
    const message = await actions().assign(session, input);
    refresh(input);
    return message;
  });
}

export async function cancelFollowUpsAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.cancel_follow_ups", async (session) => {
    const message = await actions().cancelFollowUps(session, input);
    refresh(input);
    return message;
  });
}

export async function acknowledgeEscalationAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("inbox.acknowledge", async (session) => {
    const message = await actions().acknowledgeEscalation(session, input);
    refresh(input);
    return message;
  });
}
