import { randomUUID } from "node:crypto";

import {
  type ChannelId,
  type ContactId,
  type ConversationId,
  type EventPayload,
  LEAD_EVENTS,
  type LeadEventName,
  type LeadFieldValue,
  type LeadId,
  type LeadStatus,
  type RoutingDecision,
  type TraceId,
} from "@repo/core";
import {
  and,
  attachments,
  type BusinessContext,
  contacts,
  conversations,
  desc,
  eq,
  leadEvents,
  leadFields,
  leadReports,
  leads,
  messages,
  routingDecisions,
  sql,
} from "@repo/db";
import type { AppResolvedSettings } from "@repo/settings";

import { assessLead, type LeadAssessment } from "../assess/assess";
import { buildLeadReport, type LeadReport } from "../report/report";

/**
 * The lead record in PostgreSQL (C5). Everything here runs inside a business's system scope
 * (`forBusiness().run`), under a row lock on the lead, so the handlers of one turn and the
 * turn's commit never interleave on one lead.
 */

export interface StoredDecision {
  readonly sequence: number;
  readonly decision: RoutingDecision;
}

export interface LeadRecord {
  readonly id: LeadId;
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: ChannelId;
  status: LeadStatus;
  readonly fields: Record<string, LeadFieldValue>;
  readonly latestDecision: StoredDecision | null;
  readonly latestReport: { readonly version: number; readonly markdown: string } | null;
  readonly qualifiedAt: Date | null;
  readonly handedOffAt: Date | null;
  /** True when this call created the lead. */
  readonly created: boolean;
}

/** The fields of a lead, by key. */
export async function loadLeadFields(
  ctx: BusinessContext,
  leadId: LeadId,
): Promise<Record<string, LeadFieldValue>> {
  const rows = await ctx.tx
    .select({
      key: leadFields.key,
      value: leadFields.value,
      confidence: leadFields.confidence,
      evidence: leadFields.evidence,
      updatedAt: leadFields.updatedAt,
    })
    .from(leadFields)
    .where(eq(leadFields.leadId, leadId));
  const fields: Record<string, LeadFieldValue> = {};
  for (const row of rows) {
    fields[row.key] = {
      key: row.key,
      value: (row.value ?? null) as LeadFieldValue["value"],
      confidence: row.confidence,
      evidence: row.evidence,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  return fields;
}

/** The newest routing decision of a lead (highest sequence), or null. */
export async function loadLatestDecision(
  ctx: BusinessContext,
  leadId: LeadId,
): Promise<StoredDecision | null> {
  const [row] = await ctx.tx
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.leadId, leadId))
    .orderBy(
      desc(routingDecisions.sequence),
      desc(routingDecisions.decidedAt),
      desc(routingDecisions.createdAt),
    )
    .limit(1);
  if (row === undefined) return null;
  return {
    sequence: row.sequence,
    decision: {
      outcome: row.outcome,
      score: row.score,
      band: row.band,
      reasons: row.reasons,
      decidedAt: row.decidedAt.toISOString(),
      settingsVersion: row.settingsVersion,
    },
  };
}

/**
 * The lead of a conversation, created when it has none, locked for the rest of the
 * transaction. Null when the conversation is not in this business.
 */
export async function lockLead(
  ctx: BusinessContext,
  conversationId: ConversationId,
  options: { readonly create: boolean } = { create: true },
): Promise<LeadRecord | null> {
  const [conversation] = await ctx.tx
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conversation === undefined) return null;
  let created = false;
  if (options.create) {
    const inserted = await ctx.tx
      .insert(leads)
      .values({ ...ctx.tenant, contactId: conversation.contactId, conversationId })
      .onConflictDoNothing({ target: leads.conversationId })
      .returning({ id: leads.id });
    created = inserted.length > 0;
  }
  const [lead] = await ctx.tx
    .select()
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .for("update")
    .limit(1);
  if (lead === undefined) return null;
  const [report] = await ctx.tx
    .select({ version: leadReports.version, markdown: leadReports.markdown })
    .from(leadReports)
    .where(eq(leadReports.leadId, lead.id))
    .orderBy(desc(leadReports.version))
    .limit(1);
  return {
    id: lead.id,
    conversationId,
    contactId: lead.contactId,
    channel: conversation.channel,
    status: lead.status,
    fields: await loadLeadFields(ctx, lead.id),
    latestDecision: await loadLatestDecision(ctx, lead.id),
    latestReport: report ?? null,
    qualifiedAt: lead.qualifiedAt,
    handedOffAt: lead.handedOffAt,
    created,
  };
}

/** Writes the given fields of the lead (insert or replace by key). */
export async function writeLeadFields(
  ctx: BusinessContext,
  leadId: LeadId,
  fields: readonly LeadFieldValue[],
): Promise<void> {
  for (const field of fields) {
    await ctx.tx
      .insert(leadFields)
      .values({
        ...ctx.tenant,
        leadId,
        key: field.key,
        value: field.value,
        confidence: field.confidence,
        evidence: field.evidence,
      })
      .onConflictDoUpdate({
        target: [leadFields.leadId, leadFields.key],
        set: {
          value: field.value,
          confidence: field.confidence,
          evidence: field.evidence,
          updatedAt: sql`now()`,
        },
      });
  }
}

/** What the report needs from the conversation: the customer as the channel knows them, photos. */
export async function loadConversationFacts(
  ctx: BusinessContext,
  record: Pick<LeadRecord, "conversationId" | "contactId">,
): Promise<{
  readonly customer: { name: string | null; phone: string | null; email: string | null } | null;
  readonly photoCount: number;
  readonly photos: string[];
}> {
  const [contact] = await ctx.tx
    .select({ name: contacts.displayName, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, record.contactId))
    .limit(1);
  const images = await ctx.tx
    .select({ analysis: attachments.analysis })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(messages.conversationId, record.conversationId),
        eq(messages.direction, "inbound"),
        eq(attachments.kind, "image"),
      ),
    )
    .orderBy(attachments.createdAt, attachments.id);
  return {
    customer: contact ?? null,
    photoCount: images.length,
    photos: images
      .map((row) => row.analysis)
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0),
  };
}

export interface EventContext {
  readonly traceId: TraceId;
  readonly now: Date;
}

type LeadEventExtra<TName extends LeadEventName> = Omit<
  EventPayload<TName>,
  | "eventId"
  | "occurredAt"
  | "traceId"
  | "agencyId"
  | "businessId"
  | "conversationId"
  | "contactId"
  | "leadId"
  | "channel"
  | "score"
  | "band"
>;

/**
 * Puts a lead event in the outbox, once per lead and `dedupeKey`. The payload is checked
 * against the event catalogue before it is stored. Returns true when the row is new.
 */
export async function recordLeadEvent<TName extends LeadEventName>(
  ctx: BusinessContext,
  record: Pick<LeadRecord, "id" | "conversationId" | "contactId" | "channel">,
  scoring: { readonly score: number; readonly band: string },
  event: {
    readonly name: TName;
    readonly dedupeKey: string;
    readonly data: LeadEventExtra<TName>;
  },
  context: EventContext,
): Promise<boolean> {
  const id = randomUUID();
  const payload = LEAD_EVENTS[event.name].parse({
    eventId: id,
    occurredAt: context.now.toISOString(),
    traceId: context.traceId,
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.tenant.businessId,
    conversationId: record.conversationId,
    contactId: record.contactId,
    leadId: record.id,
    channel: record.channel,
    score: scoring.score,
    band: scoring.band,
    ...event.data,
  }) as Record<string, unknown>;
  const inserted = await ctx.tx
    .insert(leadEvents)
    .values({
      id,
      ...ctx.tenant,
      leadId: record.id,
      name: event.name,
      dedupeKey: event.dedupeKey.slice(0, 200),
      payload,
      occurredAt: context.now,
    })
    .onConflictDoNothing({ target: [leadEvents.leadId, leadEvents.dedupeKey] })
    .returning({ id: leadEvents.id });
  return inserted.length > 0;
}

function sameDecision(a: RoutingDecision, b: RoutingDecision): boolean {
  return (
    a.outcome === b.outcome &&
    a.band === b.band &&
    a.score === b.score &&
    JSON.stringify(a.reasons) === JSON.stringify(b.reasons)
  );
}

export interface SavedAssessment {
  readonly assessment: LeadAssessment;
  readonly report: LeadReport;
  /** The decision in force after the save: the new one, or the stored one when none was made. */
  readonly routing: RoutingDecision | null;
  readonly decisionChanged: boolean;
  readonly reportVersion: number;
}

/**
 * Assesses the lead from its record and stores the result: a new routing decision when it
 * differs from the newest, the lead row (score, band, status, timestamps), a new report
 * version when the text changed, and the outbox events for what changed.
 */
export async function assessAndSave(
  ctx: BusinessContext,
  record: LeadRecord,
  settings: AppResolvedSettings,
  context: EventContext,
): Promise<SavedAssessment> {
  const values = settings.values;
  const facts = await loadConversationFacts(ctx, record);
  const assessment = assessLead({
    settings,
    facts: { fields: record.fields, status: record.status, photoCount: facts.photoCount },
    now: context.now.toISOString(),
  });
  const report = buildLeadReport({
    assessment,
    fields: record.fields,
    values,
    customer: facts.customer,
    photos: facts.photos,
  });

  let decisionChanged = false;
  let routing = record.latestDecision?.decision ?? null;
  if (
    assessment.decision !== null &&
    (record.latestDecision === null ||
      !sameDecision(record.latestDecision.decision, assessment.decision))
  ) {
    await ctx.tx.insert(routingDecisions).values({
      ...ctx.tenant,
      leadId: record.id,
      sequence: (record.latestDecision?.sequence ?? 0) + 1,
      outcome: assessment.decision.outcome,
      score: assessment.decision.score,
      band: assessment.decision.band,
      reasons: [...assessment.decision.reasons],
      settingsVersion: assessment.decision.settingsVersion,
      traceId: context.traceId,
      decidedAt: context.now,
    });
    decisionChanged = true;
    routing = assessment.decision;
  }

  const status = assessment.status;
  const decided = assessment.decision;
  const qualifiedNow =
    decided !== null && decided.outcome !== "disqualify" && record.qualifiedAt === null;
  await ctx.tx
    .update(leads)
    .set({
      status,
      score: assessment.score,
      band: assessment.band,
      settingsVersion: settings.version,
      ...(decisionChanged && decided !== null
        ? { routingOutcome: decided.outcome, routingDecidedAt: context.now }
        : {}),
      ...(qualifiedNow ? { qualifiedAt: context.now } : {}),
      ...(status === "disqualified"
        ? {
            disqualifiedAt: sql`coalesce(${leads.disqualifiedAt}, ${context.now.toISOString()}::timestamptz)`,
            disqualifyReason: assessment.disqualifyCode,
          }
        : { disqualifiedAt: null, disqualifyReason: null }),
      ...(status === "handed_off" && record.handedOffAt === null
        ? { handedOffAt: context.now }
        : {}),
    })
    .where(eq(leads.id, record.id));

  let reportVersion = record.latestReport?.version ?? 0;
  if (record.latestReport?.markdown !== report.markdown) {
    reportVersion += 1;
    await ctx.tx.insert(leadReports).values({
      ...ctx.tenant,
      leadId: record.id,
      version: reportVersion,
      summary: report.summary,
      markdown: report.markdown,
      sections: report.sections,
      score: assessment.score,
      band: assessment.band,
      settingsVersion: settings.version,
    });
  }

  // The events of a decision: each one once per lead.
  if (decided !== null) {
    const scoring = { score: assessment.score, band: assessment.band };
    if (decided.outcome !== "disqualify") {
      await recordLeadEvent(
        ctx,
        record,
        scoring,
        { name: "lead.qualified", dedupeKey: "qualified", data: { routing: decided.outcome } },
        context,
      );
    }
    if (decided.outcome === "book_meeting") {
      const provider = values["scheduling.provider"];
      await recordLeadEvent(
        ctx,
        record,
        scoring,
        {
          name: "lead.meeting_requested",
          dedupeKey: "meeting_requested",
          data: {
            bookingMode:
              provider === "calendly"
                ? "calendly_link"
                : provider === "none"
                  ? "manual"
                  : "calendar",
          },
        },
        context,
      );
    }
    if (decided.outcome === "contact_later") {
      await recordLeadEvent(
        ctx,
        record,
        scoring,
        {
          name: "lead.handoff",
          dedupeKey: "handoff:routing",
          data: {
            routing: "contact_later",
            trigger: "routing",
            urgency:
              assessment.emergencyClass !== null || assessment.band === "hot" ? "high" : "normal",
          },
        },
        context,
      );
    }
    if (decided.outcome === "disqualify") {
      await recordLeadEvent(
        ctx,
        record,
        scoring,
        {
          name: "lead.disqualified",
          dedupeKey: "disqualified",
          data: { reasonCode: assessment.disqualifyCode ?? "not_a_fit" },
        },
        context,
      );
    }
  }
  record.status = status;
  return { assessment, report, routing, decisionChanged, reportVersion };
}
