import type { ChannelId, ContactId, ConversationId, LeadId } from "@repo/core";
import {
  and,
  type BusinessContext,
  businesses,
  contacts,
  conversations,
  desc,
  eq,
  leadFields,
  leadReports,
  leads,
} from "@repo/db";

import { isValidTimeZone } from "./time";

/**
 * What alerts, follow-ups and the quiet-hours gate read about a conversation, inside the
 * business's system scope. Customer-written values come back as stored; whoever puts them in
 * an alert makes them plain (`plainLine`).
 */
export interface ConversationFacts {
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: ChannelId;
  readonly status: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lastInboundAt: Date | null;
  readonly business: { readonly name: string; readonly timeZone: string };
  readonly contact: {
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly timeZone: string | null;
    readonly optedOutAt: Date | null;
    readonly isBlocked: boolean;
  };
  readonly lead: {
    readonly id: LeadId;
    readonly status: string;
    readonly routingOutcome: string | null;
    readonly score: number;
    readonly band: string | null;
    /** The service the customer asked about, as the bot recorded it. */
    readonly service: string | null;
  } | null;
  readonly report: { readonly summary: string; readonly markdown: string } | null;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(asText).filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

export async function loadConversationFacts(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<ConversationFacts | null> {
  const [row] = await ctx.tx
    .select({
      contactId: conversations.contactId,
      channel: conversations.channel,
      status: conversations.status,
      metadata: conversations.metadata,
      lastInboundAt: conversations.lastInboundAt,
      contactName: contacts.displayName,
      contactPhone: contacts.phone,
      contactEmail: contacts.email,
      contactTimeZone: contacts.timezone,
      optedOutAt: contacts.optedOutAt,
      isBlocked: contacts.isBlocked,
      businessName: businesses.name,
      businessTimeZone: businesses.timezone,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(businesses, eq(businesses.id, conversations.businessId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (row === undefined) return null;

  const [lead] = await ctx.tx
    .select({
      id: leads.id,
      status: leads.status,
      routingOutcome: leads.routingOutcome,
      score: leads.score,
      band: leads.band,
    })
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .limit(1);

  let service: string | null = null;
  let contactName: string | null = null;
  let contactPhone: string | null = null;
  let report: ConversationFacts["report"] = null;
  if (lead !== undefined) {
    const fields = await ctx.tx
      .select({ key: leadFields.key, value: leadFields.value })
      .from(leadFields)
      .where(eq(leadFields.leadId, lead.id));
    const byKey = new Map(fields.map((field) => [field.key, asText(field.value)]));
    service = byKey.get("service_type") ?? byKey.get("job_type") ?? null;
    contactName = byKey.get("contact_name") ?? null;
    contactPhone = byKey.get("contact_phone") ?? null;
    const [latest] = await ctx.tx
      .select({ summary: leadReports.summary, markdown: leadReports.markdown })
      .from(leadReports)
      .where(and(eq(leadReports.leadId, lead.id)))
      .orderBy(desc(leadReports.version))
      .limit(1);
    report = latest ?? null;
  }

  return {
    conversationId,
    contactId: row.contactId,
    channel: row.channel,
    status: row.status,
    metadata: row.metadata,
    lastInboundAt: row.lastInboundAt,
    business: {
      name: row.businessName,
      timeZone: isValidTimeZone(row.businessTimeZone) ? row.businessTimeZone : "America/New_York",
    },
    contact: {
      name: contactName ?? row.contactName,
      phone: row.contactPhone ?? contactPhone,
      email: row.contactEmail,
      timeZone: row.contactTimeZone,
      optedOutAt: row.optedOutAt,
      isBlocked: row.isBlocked,
    },
    lead:
      lead === undefined
        ? null
        : {
            id: lead.id,
            status: lead.status,
            routingOutcome: lead.routingOutcome,
            score: Number(lead.score),
            band: lead.band,
            service,
          },
    report,
  };
}
