import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  type AgencyId,
  type BusinessId,
  CHANNEL_IDS,
  type ContactId,
  type ChannelId,
  type ConversationId,
  NotFoundError,
  type UserId,
  ValidationError,
} from "@repo/core";

import type { BusinessContext, UserContext } from "../context";
import {
  agencyMemberships,
  attachments,
  bookings,
  businesses,
  contacts,
  conversations,
  internalNotes,
  leadFields,
  leadReports,
  leads,
  messages,
  routingDecisions,
  segments,
  takeoverLocks,
  users,
} from "../schema/tables";
import { recordSystemAudit } from "./audit";

/*
 * The inbox for the admin panel and the client portal (C16).
 *
 * Reads run as the signed-in user (`UserContext`): row-level security decides which
 * businesses, conversations and leads are visible, so a client user only ever gets rows of
 * their own business, and internal notes only reach agency staff. The caller narrows further
 * with `businessIds` (the businesses whose client-portal settings allow the screen).
 *
 * Writes to the pipeline's tables (marking a conversation read, assigning it) take a
 * `BusinessContext`: the server checks the person's role first, then acts in the business's
 * system scope (ARCHITECTURE §3, "Nobody writes the tables the pipeline owns as a user").
 * Internal notes are written as the user: RLS lets agency staff add notes under their own
 * name only.
 */

/** Characters that would make a search pattern match more than the person typed. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SearchText = z
  .string()
  .trim()
  .max(100)
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  .transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, " "))
  .optional();

export const InboxFilter = z.object({
  businessId: z.uuid().optional(),
  channel: z.enum(CHANNEL_IDS).optional(),
  status: z.enum(["open", "closed", "all"]).default("open"),
  unread: z.boolean().default(false),
  assigned: z.enum(["any", "me", "unassigned"]).default("any"),
  takenOver: z.boolean().default(false),
  q: SearchText,
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});
export type InboxFilter = z.input<typeof InboxFilter>;

export interface InboxRow {
  readonly id: ConversationId;
  readonly businessId: BusinessId;
  readonly businessName: string;
  readonly channel: ChannelId;
  readonly status: string;
  readonly subject: string | null;
  readonly contactName: string | null;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly lastMessageText: string | null;
  readonly lastMessageAuthor: string | null;
  readonly leadScore: number | null;
  readonly leadStatus: string | null;
  readonly leadBand: string | null;
  readonly takenOver: boolean;
  readonly takeoverUserId: UserId | null;
  readonly assignedUserId: UserId | null;
  readonly assignedUserName: string | null;
}

export interface InboxPage {
  readonly rows: readonly InboxRow[];
  /** True when there are more rows after this page. */
  readonly more: boolean;
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

/**
 * Conversations the user may see, newest activity first. `businessIds` limits the list to
 * those businesses (null: every business RLS shows the user). An empty list returns nothing.
 */
export async function listInbox(
  ctx: UserContext,
  input: InboxFilter & { readonly businessIds: readonly BusinessId[] | null },
): Promise<InboxPage> {
  const filter = InboxFilter.parse(input);
  if (input.businessIds !== null && input.businessIds.length === 0) {
    return { rows: [], more: false };
  }
  const where: (SQL | undefined)[] = [];
  if (input.businessIds !== null) {
    where.push(inArray(conversations.businessId, [...input.businessIds]));
  }
  if (filter.businessId !== undefined) {
    where.push(eq(conversations.businessId, filter.businessId as BusinessId));
  }
  if (filter.channel !== undefined) where.push(eq(conversations.channel, filter.channel));
  if (filter.status !== "all") where.push(eq(conversations.status, filter.status));
  if (filter.unread) where.push(sql`${conversations.unreadCount} > 0`);
  if (filter.assigned === "me") where.push(eq(conversations.assignedUserId, ctx.user.id));
  if (filter.assigned === "unassigned") where.push(isNull(conversations.assignedUserId));
  if (filter.takenOver) where.push(isNotNull(takeoverLocks.id));
  if (filter.q !== undefined && filter.q !== "") {
    const pattern = likePattern(filter.q);
    where.push(
      or(
        ilike(contacts.displayName, pattern),
        ilike(contacts.phone, pattern),
        ilike(contacts.email, pattern),
        ilike(conversations.subject, pattern),
        sql`exists (select 1 from ${messages} m where m.conversation_id = ${conversations.id} and m.text ilike ${pattern})`,
      ),
    );
  }

  const assignee = sql<
    string | null
  >`(select coalesce(u.full_name, u.email) from ${users} u where u.id = ${conversations.assignedUserId})`;
  const last = sql<{ text: string | null; author: string } | null>`(
    select json_build_object('text', left(m.text, 200), 'author', m.author)
    from ${messages} m
    where m.conversation_id = ${conversations.id} and m.status <> 'superseded'
    order by m.sequence desc limit 1)`;

  const rows = await ctx.tx
    .select({
      id: conversations.id,
      businessId: conversations.businessId,
      businessName: businesses.name,
      channel: conversations.channel,
      status: conversations.status,
      subject: conversations.subject,
      contactName: contacts.displayName,
      unreadCount: conversations.unreadCount,
      lastMessageAt: conversations.lastMessageAt,
      last,
      leadScore: leads.score,
      leadStatus: leads.status,
      leadBand: leads.band,
      takeoverId: takeoverLocks.id,
      takeoverUserId: takeoverLocks.userId,
      assignedUserId: conversations.assignedUserId,
      assignedUserName: assignee,
    })
    .from(conversations)
    .innerJoin(businesses, eq(businesses.id, conversations.businessId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(leads, eq(leads.conversationId, conversations.id))
    .leftJoin(
      takeoverLocks,
      and(eq(takeoverLocks.conversationId, conversations.id), isNull(takeoverLocks.releasedAt)),
    )
    .where(and(...where))
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
    .limit(filter.limit + 1)
    .offset(filter.offset);

  return {
    more: rows.length > filter.limit,
    rows: rows.slice(0, filter.limit).map((row) => {
      // Drizzle hands raw JSON from `sql` back as text.
      const last = (typeof row.last === "string" ? JSON.parse(row.last) : row.last) as {
        text: string | null;
        author: string;
      } | null;
      return {
        id: row.id,
        businessId: row.businessId,
        businessName: row.businessName,
        channel: row.channel,
        status: row.status,
        subject: row.subject,
        contactName: row.contactName,
        unreadCount: row.unreadCount,
        lastMessageAt: iso(row.lastMessageAt),
        lastMessageText: last?.text ?? null,
        lastMessageAuthor: last?.author ?? null,
        leadScore: row.leadScore,
        leadStatus: row.leadStatus,
        leadBand: row.leadBand,
        takenOver: row.takeoverId !== null,
        takeoverUserId: row.takeoverUserId,
        assignedUserId: row.assignedUserId,
        assignedUserName: row.assignedUserName,
      };
    }),
  };
}

export interface ConversationAttachmentView {
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly sizeBytes: number | null;
  /** True when the file is in storage and can be opened. */
  readonly stored: boolean;
  readonly analysis: string | null;
}

export interface ConversationMessageView {
  readonly id: string;
  readonly sequence: number;
  readonly direction: "inbound" | "outbound";
  readonly author: string;
  readonly authorUserName: string | null;
  readonly kind: string;
  readonly text: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly errorMessage: string | null;
  readonly attachments: readonly ConversationAttachmentView[];
}

export interface LeadFieldView {
  readonly key: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly evidence: string | null;
}

export interface LeadView {
  readonly id: string;
  readonly status: string;
  readonly score: number;
  readonly band: string | null;
  readonly routingOutcome: string | null;
  readonly routingDecidedAt: string | null;
  readonly disqualifyReason: string | null;
  readonly fields: readonly LeadFieldView[];
  /** The newest written report; null when the caller may not read reports. */
  readonly report: {
    readonly version: number;
    readonly summary: string;
    readonly markdown: string;
    readonly createdAt: string;
  } | null;
  readonly routing: readonly {
    readonly outcome: string;
    readonly score: number;
    readonly band: string;
    readonly reasons: readonly string[];
    readonly decidedAt: string;
  }[];
}

export interface ConversationDetail {
  readonly id: ConversationId;
  readonly businessId: BusinessId;
  readonly agencyId: string;
  readonly businessName: string;
  readonly channel: ChannelId;
  readonly status: string;
  readonly subject: string | null;
  readonly closedReason: string | null;
  readonly unreadCount: number;
  readonly createdAt: string;
  readonly lastInboundAt: string | null;
  readonly assignedUserId: UserId | null;
  readonly assignedUserName: string | null;
  readonly contact: {
    readonly id: string;
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly address: string | null;
    readonly optedOut: boolean;
  };
  readonly takeover: {
    readonly active: boolean;
    readonly source: string | null;
    readonly userId: UserId | null;
    readonly userName: string | null;
    readonly startedAt: string | null;
    readonly lastActivityAt: string | null;
  };
  readonly messages: readonly ConversationMessageView[];
  readonly lead: LeadView | null;
  readonly bookings: readonly {
    readonly id: string;
    readonly status: string;
    readonly provider: string;
    readonly startsAt: string | null;
    readonly title: string | null;
    readonly location: string | null;
  }[];
  /** Agency staff only (row-level security); empty for everyone else. */
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly authorUserId: UserId | null;
    readonly authorName: string | null;
    readonly createdAt: string;
  }[];
}

const MESSAGE_LIMIT = 500;

/**
 * One conversation as the user may see it, or null when RLS hides it (another agency,
 * another client, client logins off) or it does not exist: the caller says "not found"
 * either way. `include` leaves out what the caller's permissions do not allow.
 */
export async function getConversationDetail(
  ctx: UserContext,
  conversationId: string,
  include: {
    /** The written report, and the reasons of each routing decision (the report's "why"). */
    readonly reports: boolean;
    readonly notes: boolean;
    /** The lead panel (score, criteria, routing); null lead when false. Default true. */
    readonly lead?: boolean;
  },
): Promise<ConversationDetail | null> {
  const id = z.uuid().safeParse(conversationId);
  if (!id.success) return null;
  const cid = id.data as ConversationId;
  const [row] = await ctx.tx
    .select({
      conversation: conversations,
      businessName: businesses.name,
      contact: contacts,
      assignedUserName: sql<
        string | null
      >`(select coalesce(u.full_name, u.email) from ${users} u where u.id = ${conversations.assignedUserId})`,
    })
    .from(conversations)
    .innerJoin(businesses, eq(businesses.id, conversations.businessId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, cid))
    .limit(1);
  if (row === undefined) return null;
  const c = row.conversation;

  const [lock] = await ctx.tx
    .select({
      source: takeoverLocks.source,
      userId: takeoverLocks.userId,
      startedAt: takeoverLocks.startedAt,
      lastActivityAt: takeoverLocks.lastActivityAt,
      userName: sql<
        string | null
      >`(select coalesce(u.full_name, u.email) from ${users} u where u.id = ${takeoverLocks.userId})`,
    })
    .from(takeoverLocks)
    .where(and(eq(takeoverLocks.conversationId, cid), isNull(takeoverLocks.releasedAt)))
    .limit(1);

  const messageRows = (
    await ctx.tx
      .select({
        id: messages.id,
        sequence: messages.sequence,
        direction: messages.direction,
        author: messages.author,
        authorUserName: sql<
          string | null
        >`(select coalesce(u.full_name, u.email) from ${users} u where u.id = ${messages.authorUserId})`,
        kind: messages.kind,
        text: messages.text,
        status: messages.status,
        createdAt: messages.createdAt,
        sentAt: messages.sentAt,
        errorMessage: messages.errorMessage,
      })
      .from(messages)
      .where(eq(messages.conversationId, cid))
      .orderBy(desc(messages.sequence))
      .limit(MESSAGE_LIMIT)
  ).reverse();
  const messageIds = messageRows.map((message) => message.id);
  const attachmentRows =
    messageIds.length === 0
      ? []
      : await ctx.tx
          .select({
            id: attachments.id,
            messageId: attachments.messageId,
            kind: attachments.kind,
            mimeType: attachments.mimeType,
            fileName: attachments.fileName,
            sizeBytes: attachments.sizeBytes,
            status: attachments.status,
            storagePath: attachments.storagePath,
            analysis: attachments.analysis,
          })
          .from(attachments)
          .where(inArray(attachments.messageId, messageIds))
          .orderBy(asc(attachments.createdAt));

  const [lead] =
    include.lead === false
      ? []
      : await ctx.tx.select().from(leads).where(eq(leads.conversationId, cid)).limit(1);
  let leadView: LeadView | null = null;
  if (lead !== undefined) {
    const fields = await ctx.tx
      .select()
      .from(leadFields)
      .where(eq(leadFields.leadId, lead.id))
      .orderBy(asc(leadFields.key));
    const [report] = include.reports
      ? await ctx.tx
          .select()
          .from(leadReports)
          .where(eq(leadReports.leadId, lead.id))
          .orderBy(desc(leadReports.version))
          .limit(1)
      : [];
    const routing = await ctx.tx
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.leadId, lead.id))
      .orderBy(desc(routingDecisions.sequence), desc(routingDecisions.decidedAt))
      .limit(10);
    leadView = {
      id: lead.id,
      status: lead.status,
      score: lead.score,
      band: lead.band,
      routingOutcome: lead.routingOutcome,
      routingDecidedAt: iso(lead.routingDecidedAt),
      disqualifyReason: lead.disqualifyReason,
      fields: fields.map((field) => ({
        key: field.key,
        value: field.value,
        confidence: field.confidence,
        evidence: field.evidence,
      })),
      report:
        report === undefined
          ? null
          : {
              version: report.version,
              summary: report.summary,
              markdown: report.markdown,
              createdAt: report.createdAt.toISOString(),
            },
      routing: routing.map((decision) => ({
        outcome: decision.outcome,
        score: decision.score,
        band: decision.band,
        // The reasons are the report's "why": only for those who may read reports.
        reasons: include.reports ? decision.reasons : [],
        decidedAt: decision.decidedAt.toISOString(),
      })),
    };
  }

  const bookingRows =
    include.lead === false
      ? []
      : await ctx.tx
          .select()
          .from(bookings)
          .where(eq(bookings.conversationId, cid))
          .orderBy(desc(bookings.createdAt))
          .limit(10);

  const noteRows = include.notes
    ? await ctx.tx
        .select({
          id: internalNotes.id,
          body: internalNotes.body,
          authorUserId: internalNotes.authorUserId,
          createdAt: internalNotes.createdAt,
          authorName: sql<
            string | null
          >`(select coalesce(u.full_name, u.email) from ${users} u where u.id = ${internalNotes.authorUserId})`,
        })
        .from(internalNotes)
        .where(eq(internalNotes.conversationId, cid))
        .orderBy(asc(internalNotes.createdAt))
    : [];

  return {
    id: c.id,
    businessId: c.businessId,
    agencyId: c.agencyId,
    businessName: row.businessName,
    channel: c.channel,
    status: c.status,
    subject: c.subject,
    closedReason: c.closedReason,
    unreadCount: c.unreadCount,
    createdAt: c.createdAt.toISOString(),
    lastInboundAt: iso(c.lastInboundAt),
    assignedUserId: c.assignedUserId,
    assignedUserName: row.assignedUserName,
    contact: {
      id: row.contact.id,
      name: row.contact.displayName,
      phone: row.contact.phone,
      email: row.contact.email,
      address: row.contact.address,
      optedOut: row.contact.optedOutAt !== null,
    },
    takeover: {
      active: lock !== undefined,
      source: lock?.source ?? null,
      userId: lock?.userId ?? null,
      userName: lock?.userName ?? null,
      startedAt: iso(lock?.startedAt),
      lastActivityAt: iso(lock?.lastActivityAt),
    },
    messages: messageRows.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      direction: message.direction,
      author: message.author,
      authorUserName: message.authorUserName,
      kind: message.kind,
      text: message.text,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
      sentAt: iso(message.sentAt),
      errorMessage: message.direction === "outbound" ? message.errorMessage : null,
      attachments: attachmentRows
        .filter((attachment) => attachment.messageId === message.id)
        .map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes,
          stored: attachment.status === "stored" && attachment.storagePath !== null,
          analysis: attachment.analysis,
        })),
    })),
    lead: leadView,
    bookings: bookingRows.map((booking) => ({
      id: booking.id,
      status: booking.status,
      provider: booking.provider,
      startsAt: iso(booking.startsAt),
      title: booking.title,
      location: booking.location,
    })),
    notes: noteRows.map((note) => ({
      id: note.id,
      body: note.body,
      authorUserId: note.authorUserId,
      authorName: note.authorName,
      createdAt: note.createdAt.toISOString(),
    })),
  };
}

/**
 * The tenant of a conversation the user may see (RLS), or null: what every inbox action
 * resolves first, before it checks the person's permissions for that business.
 */
export async function findVisibleConversation(
  ctx: UserContext,
  conversationId: unknown,
): Promise<{
  readonly id: ConversationId;
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  readonly contactId: ContactId;
} | null> {
  const id = z.uuid().safeParse(conversationId);
  if (!id.success) return null;
  const [row] = await ctx.tx
    .select({
      id: conversations.id,
      agencyId: conversations.agencyId,
      businessId: conversations.businessId,
      contactId: conversations.contactId,
    })
    .from(conversations)
    .where(eq(conversations.id, id.data as ConversationId))
    .limit(1);
  return row ?? null;
}

/**
 * Where an attachment is stored, as the user may see it (RLS on `attachments`), for the
 * route that serves it. Null when hidden, missing or not stored.
 */
export async function findVisibleAttachment(
  ctx: UserContext,
  attachmentId: string,
): Promise<{
  readonly id: string;
  readonly agencyId: string;
  readonly businessId: BusinessId;
  readonly conversationId: ConversationId;
  readonly storagePath: string;
  readonly mimeType: string | null;
  readonly fileName: string | null;
} | null> {
  const id = z.uuid().safeParse(attachmentId);
  if (!id.success) return null;
  const [row] = await ctx.tx
    .select({
      id: attachments.id,
      agencyId: attachments.agencyId,
      businessId: attachments.businessId,
      conversationId: messages.conversationId,
      storagePath: attachments.storagePath,
      status: attachments.status,
      mimeType: attachments.mimeType,
      fileName: attachments.fileName,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(eq(attachments.id, id.data))
    .limit(1);
  const storagePath = row?.status === "stored" ? row.storagePath : null;
  if (row === undefined || storagePath === null) return null;
  return { ...row, storagePath };
}

/** Agency staff a conversation can be assigned to, with their names (as the user). */
export async function listAgencyStaff(
  ctx: UserContext,
  agencyId: string,
): Promise<readonly { readonly id: UserId; readonly name: string; readonly role: string }[]> {
  const rows = await ctx.tx
    .select({
      id: agencyMemberships.userId,
      role: agencyMemberships.role,
      fullName: users.fullName,
      email: users.email,
    })
    .from(agencyMemberships)
    .innerJoin(users, eq(users.id, agencyMemberships.userId))
    .where(eq(agencyMemberships.agencyId, agencyId as never))
    .orderBy(asc(users.fullName), asc(users.email));
  return rows.map((row) => ({ id: row.id, name: row.fullName ?? row.email, role: row.role }));
}

/** Someone opened the conversation: it is read for everybody (a shared inbox). */
export async function markConversationRead(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<void> {
  await ctx.tx
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.unreadCount} > 0`));
}

/**
 * Assigns the conversation to one of the agency's staff, or to nobody. The server checks
 * that the person assigning is staff; the assignee must be staff of this business's agency.
 */
export async function assignConversation(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly assigneeId: UserId | null;
    readonly actorUserId: UserId;
  },
): Promise<void> {
  if (input.assigneeId !== null) {
    const [member] = await ctx.tx
      .select({ id: agencyMemberships.id })
      .from(agencyMemberships)
      .where(
        and(
          eq(agencyMemberships.agencyId, ctx.tenant.agencyId),
          eq(agencyMemberships.userId, input.assigneeId),
        ),
      )
      .limit(1);
    if (member === undefined) {
      throw new ValidationError("A conversation can be assigned to the agency's staff only.");
    }
  }
  const [before] = await ctx.tx
    .select({ assignedUserId: conversations.assignedUserId })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update")
    .limit(1);
  if (before === undefined) throw new NotFoundError("The conversation was not found.");
  if (before.assignedUserId === input.assigneeId) return;
  await ctx.tx
    .update(conversations)
    .set({ assignedUserId: input.assigneeId })
    .where(eq(conversations.id, input.conversationId));
  await recordSystemAudit(
    ctx,
    { type: "user", userId: input.actorUserId },
    {
      action: "conversation.assign",
      targetType: "conversation",
      targetId: input.conversationId,
      summary: input.assigneeId === null ? "Conversation unassigned." : "Conversation assigned.",
      before: { assignedUserId: before.assignedUserId },
      after: { assignedUserId: input.assigneeId },
    },
  );
}

export const NoteBody = z
  .string()
  .trim()
  .min(1, "Write the note first.")
  .max(4000, "Keep a note to 4,000 characters.");

/**
 * Adds an internal note as the signed-in user. RLS lets agency staff of the business's
 * agency insert notes under their own name only; the conversation must be in the business.
 */
export async function addInternalNote(
  ctx: UserContext,
  input: {
    readonly agencyId: string;
    readonly businessId: BusinessId;
    readonly conversationId: ConversationId;
    readonly body: string;
  },
): Promise<{ readonly id: string }> {
  const body = NoteBody.parse(input.body);
  const [row] = await ctx.tx
    .insert(internalNotes)
    .values({
      agencyId: input.agencyId as never,
      businessId: input.businessId,
      conversationId: input.conversationId,
      authorUserId: ctx.user.id,
      body,
    })
    .returning({ id: internalNotes.id });
  return { id: row!.id };
}

/**
 * Deletes a note: its author, or an agency admin (RLS decides). With `conversationId`, only a
 * note of that conversation (the one the person was checked against).
 */
export async function deleteInternalNote(
  ctx: UserContext,
  noteId: string,
  conversationId?: ConversationId,
): Promise<boolean> {
  const id = z.uuid().safeParse(noteId);
  if (!id.success) return false;
  const rows = await ctx.tx
    .delete(internalNotes)
    .where(
      and(
        eq(internalNotes.id, id.data),
        conversationId === undefined ? undefined : eq(internalNotes.conversationId, conversationId),
      ),
    )
    .returning({ id: internalNotes.id });
  return rows.length > 0;
}

/** Segment names by business, for the filters of lists and analytics (as the user). */
export async function listVisibleSegments(
  ctx: UserContext,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return ctx.tx
    .select({ id: segments.id, name: segments.name })
    .from(segments)
    .orderBy(asc(segments.name));
}
