import { z } from "zod";

import type { ConversationId, UserId } from "@repo/core";
import {
  addInternalNote,
  assignConversation,
  type BusinessTenant,
  deleteInternalNote,
  findVisibleConversation,
  getDatabase,
} from "@repo/db";
import type { HandoffService } from "@repo/handoff";

import { ActionError } from "@/server/admin/result";
import { type SessionAccess, userDatabase } from "@/server/auth";
import { businessPermissions, type PortalPermissions } from "@/server/portal";

/*
 * The inbox's server actions (C16), as functions of the session and the services, so tests
 * run them without Next.js. The `"use server"` wrappers in `src/app/(admin)/_actions/inbox.ts`
 * add the cross-site check and the session (`runAction`).
 *
 * Every action names a conversation by id only. The conversation is looked up again as the
 * signed-in person (row-level security: another agency's or another client's conversation is
 * "not found"), its business's permissions are worked out on the server, and only then does
 * the action reach the business's system scope through the owning service.
 */

const NOT_FOUND = "That conversation was not found.";

export const ConversationRef = z.strictObject({ conversationId: z.uuid() });
export const ReplyInput = z.strictObject({
  conversationId: z.uuid(),
  text: z.string().max(4000, "The reply is too long (4,000 characters at most)."),
  /** One per draft in the reply box: a double click or a retry sends the reply once. */
  key: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
});
export const NoteInput = z.strictObject({
  conversationId: z.uuid(),
  body: z.string().max(4000, "Keep a note to 4,000 characters."),
});
export const NoteRef = z.strictObject({ conversationId: z.uuid(), noteId: z.uuid() });
export const AssignInput = z.strictObject({
  conversationId: z.uuid(),
  assigneeId: z.uuid().nullable(),
});
export const EscalationRef = z.strictObject({ conversationId: z.uuid(), escalationId: z.uuid() });

export interface ConversationAccess {
  readonly conversationId: ConversationId;
  readonly tenant: BusinessTenant;
  readonly permissions: PortalPermissions;
}

/** The conversation as the person may reach it, or an error that says "not found". */
export async function conversationAccess(
  session: SessionAccess,
  conversationId: unknown,
): Promise<ConversationAccess> {
  const found = await userDatabase(session.user).run((ctx) =>
    findVisibleConversation(ctx, conversationId),
  );
  if (found === null) throw new ActionError(NOT_FOUND);
  const tenant = { agencyId: found.agencyId, businessId: found.businessId };
  const permissions = await businessPermissions(session, tenant);
  if (!permissions.viewConversations) throw new ActionError(NOT_FOUND);
  return { conversationId: found.id, tenant, permissions };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ActionError(parsed.error.issues[0]?.message ?? "That request was not valid.");
  }
  return parsed.data;
}

function requireReply(access: ConversationAccess): void {
  if (!access.permissions.reply) {
    throw new ActionError("You cannot take over or reply in this business's conversations.");
  }
}

function requireStaff(access: ConversationAccess): void {
  if (!access.permissions.staff) throw new ActionError("Only agency staff can do that.");
}

export interface InboxDeps {
  readonly handoff: HandoffService;
}

export function createInboxActions(deps: InboxDeps) {
  return {
    async takeOver(session: SessionAccess, input: unknown): Promise<string> {
      const { conversationId } = parse(ConversationRef, input);
      const access = await conversationAccess(session, conversationId);
      requireReply(access);
      const result = await deps.handoff.takeOver({
        tenant: access.tenant,
        conversationId: access.conversationId,
        userId: session.user.id,
      });
      if (result.heldByOther === true) {
        throw new ActionError("Someone else holds this conversation. Ask them to release it.");
      }
      return "You hold the conversation. The bot stays silent until you release it.";
    },

    async release(session: SessionAccess, input: unknown): Promise<string> {
      const { conversationId } = parse(ConversationRef, input);
      const access = await conversationAccess(session, conversationId);
      requireReply(access);
      const state = await deps.handoff.takeoverState(access.tenant, access.conversationId);
      // Staff may release any takeover; a client user only their own.
      if (state.active && !access.permissions.staff && state.userId !== session.user.id) {
        throw new ActionError("Only the person holding the conversation can release it.");
      }
      const { released } = await deps.handoff.release({
        tenant: access.tenant,
        conversationId: access.conversationId,
        userId: session.user.id,
      });
      return released ? "The bot has the conversation again." : "The bot already had it.";
    },

    async reply(
      session: SessionAccess,
      input: unknown,
    ): Promise<{ readonly messageId: string; readonly duplicate: boolean }> {
      const parsed = parse(ReplyInput, input);
      const access = await conversationAccess(session, parsed.conversationId);
      requireReply(access);
      try {
        const result = await deps.handoff.sendManualReply({
          tenant: access.tenant,
          conversationId: access.conversationId,
          userId: session.user.id,
          text: parsed.text,
          requireHolder: true,
          idempotencyKey: `${session.user.id}:${parsed.key}`,
        });
        return { messageId: result.messageId, duplicate: result.duplicate === true };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Take the conversation over")) {
          throw new ActionError(error.message);
        }
        throw error;
      }
    },

    /** The person is typing: the idle release waits (nothing happens without a takeover). */
    async typing(session: SessionAccess, input: unknown): Promise<boolean> {
      const { conversationId } = parse(ConversationRef, input);
      const access = await conversationAccess(session, conversationId);
      requireReply(access);
      const state = await deps.handoff.takeoverState(access.tenant, access.conversationId);
      if (!state.active || state.userId !== session.user.id) return false;
      const { active } = await deps.handoff.noteActivity({
        tenant: access.tenant,
        conversationId: access.conversationId,
        userId: session.user.id,
      });
      return active;
    },

    async addNote(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(NoteInput, input);
      const access = await conversationAccess(session, parsed.conversationId);
      requireStaff(access);
      if (parsed.body.trim() === "") throw new ActionError("Write the note first.");
      await userDatabase(session.user).run((ctx) =>
        addInternalNote(ctx, {
          ...access.tenant,
          conversationId: access.conversationId,
          body: parsed.body,
        }),
      );
      return "Note added.";
    },

    async deleteNote(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(NoteRef, input);
      const access = await conversationAccess(session, parsed.conversationId);
      requireStaff(access);
      const deleted = await userDatabase(session.user).run((ctx) =>
        deleteInternalNote(ctx, parsed.noteId),
      );
      if (!deleted) throw new ActionError("You can delete only your own notes.");
      return "Note deleted.";
    },

    async assign(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(AssignInput, input);
      const access = await conversationAccess(session, parsed.conversationId);
      requireStaff(access);
      await getDatabase()
        .forBusiness(access.tenant.businessId, { agencyId: access.tenant.agencyId })
        .run((ctx) =>
          assignConversation(ctx, {
            conversationId: access.conversationId,
            assigneeId: parsed.assigneeId as UserId | null,
            actorUserId: session.user.id,
          }),
        );
      return parsed.assigneeId === null ? "Unassigned." : "Assigned.";
    },

    async cancelFollowUps(session: SessionAccess, input: unknown): Promise<string> {
      const { conversationId } = parse(ConversationRef, input);
      const access = await conversationAccess(session, conversationId);
      requireStaff(access);
      const { cancelled } = await deps.handoff.cancelFollowUps({
        tenant: access.tenant,
        conversationId: access.conversationId,
        userId: session.user.id,
      });
      return cancelled === 0 ? "No follow-up was planned." : "Follow-ups stopped.";
    },

    async acknowledgeEscalation(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(EscalationRef, input);
      const access = await conversationAccess(session, parsed.conversationId);
      requireStaff(access);
      const mine = await deps.handoff.listEscalations(access.tenant, { limit: 200 });
      if (
        !mine.some(
          (item) =>
            item.id === parsed.escalationId && item.conversationId === access.conversationId,
        )
      ) {
        throw new ActionError("That emergency was not found.");
      }
      const result = await deps.handoff.acknowledgeEscalation({
        tenant: access.tenant,
        escalationId: parsed.escalationId,
        userId: session.user.id,
        userLabel: session.user.email ?? "A signed-in person",
      });
      return result.kind === "acknowledged"
        ? "Emergency acknowledged: the chain has stopped."
        : "This emergency was already acknowledged or has ended.";
    },
  };
}

export type InboxActions = ReturnType<typeof createInboxActions>;
