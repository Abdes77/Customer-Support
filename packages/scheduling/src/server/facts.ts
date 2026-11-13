import type { ContactId, ConversationId, LeadId } from "@repo/core";
import {
  and,
  type BusinessContext,
  businesses,
  contacts,
  conversations,
  desc,
  eq,
  isNull,
  leadFields,
  leadReports,
  leads,
  takeoverLocks,
} from "@repo/db";

import { isValidTimeZone } from "../time";

/**
 * What scheduling needs to know about a conversation, read inside the business's system
 * scope: the lead's routing, the customer's details (from the lead fields the bot recorded,
 * else the contact), the latest lead report and the time zones. Customer-written values are
 * returned as stored; whoever puts them anywhere treats them as data.
 */
export interface ConversationFacts {
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: string;
  readonly business: { readonly name: string; readonly timeZone: string };
  readonly lead: {
    readonly id: LeadId;
    readonly status: string;
    readonly routingOutcome: string | null;
    readonly score: number;
    readonly band: string | null;
  } | null;
  readonly customer: {
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly address: string | null;
    /** The service the customer asked about, as recorded. */
    readonly service: string | null;
    /** The location for travel rules: the job address, else the service-area answer. */
    readonly location: string | null;
    /** The customer's time zone when known, else the business's. */
    readonly timeZone: string;
  };
  readonly report: { readonly markdown: string; readonly summary: string } | null;
  /** A person holds the conversation (invariant I5): the bot books, moves and cancels nothing. */
  readonly takeover: boolean;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return (
      value
        .map(asText)
        .filter((item) => item !== null)
        .join(", ") || null
    );
  if (typeof value === "object") {
    const parts = Object.values(value as Record<string, unknown>)
      .map(asText)
      .filter((item) => item !== null);
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
      contactName: contacts.displayName,
      contactPhone: contacts.phone,
      contactEmail: contacts.email,
      contactAddress: contacts.address,
      contactTimeZone: contacts.timezone,
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

  const fields = new Map<string, string>();
  let report: ConversationFacts["report"] = null;
  if (lead !== undefined) {
    const rows = await ctx.tx
      .select({ key: leadFields.key, value: leadFields.value })
      .from(leadFields)
      .where(eq(leadFields.leadId, lead.id));
    for (const field of rows) {
      const text = asText(field.value);
      if (text !== null) fields.set(field.key, text);
    }
    const [latest] = await ctx.tx
      .select({ markdown: leadReports.markdown, summary: leadReports.summary })
      .from(leadReports)
      .where(eq(leadReports.leadId, lead.id))
      .orderBy(desc(leadReports.version))
      .limit(1);
    report = latest ?? null;
  }

  const [lock] = await ctx.tx
    .select({ id: takeoverLocks.id })
    .from(takeoverLocks)
    .where(and(eq(takeoverLocks.conversationId, conversationId), isNull(takeoverLocks.releasedAt)))
    .limit(1);

  const businessTimeZone = isValidTimeZone(row.businessTimeZone)
    ? row.businessTimeZone
    : "America/New_York";
  const address = fields.get("job_address") ?? row.contactAddress ?? null;
  return {
    conversationId,
    contactId: row.contactId,
    channel: row.channel,
    business: { name: row.businessName, timeZone: businessTimeZone },
    lead: lead ?? null,
    customer: {
      name: fields.get("contact_name") ?? row.contactName ?? null,
      phone: fields.get("contact_phone") ?? row.contactPhone ?? null,
      email: fields.get("contact_email") ?? row.contactEmail ?? null,
      address,
      service: fields.get("service_type") ?? null,
      location: address ?? fields.get("service_area") ?? null,
      timeZone:
        row.contactTimeZone !== null && isValidTimeZone(row.contactTimeZone)
          ? row.contactTimeZone
          : businessTimeZone,
    },
    report,
    takeover: lock !== undefined,
  };
}
