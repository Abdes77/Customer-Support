import type { LeadId, LeadSyncPayload } from "@repo/core";
import {
  asc,
  type BusinessContext,
  bookings,
  businesses,
  contacts,
  conversations,
  desc,
  eq,
  leadFields,
  leadReports,
  leads,
  messages,
} from "@repo/db";

import { asText } from "../mapping";
import { findPostalCode, splitName } from "../payload";
import { INTEGRATION_ROUTES, publicUrl } from "./deps";

/** Most messages a transcript carries, and most characters. */
const TRANSCRIPT_MESSAGES = 200;
const TRANSCRIPT_CHARS = 20_000;
const SPEAKERS: Readonly<Record<string, string>> = {
  customer: "Customer",
  bot: "Assistant",
  human_agent: "Team",
};

/**
 * The canonical payload of a lead, read inside the business's system scope: the lead, its
 * fields (the bot's records win over the contact row for name, phone, email and address),
 * the newest report, the newest booking and, when asked, the transcript. Null when the lead
 * is not in this business.
 */
export async function loadLeadSyncPayload(
  ctx: BusinessContext,
  leadId: LeadId,
  options: {
    readonly appUrl: string;
    readonly trigger: string;
    readonly transcript: boolean;
  },
): Promise<LeadSyncPayload | null> {
  const [row] = await ctx.tx
    .select({
      lead: leads,
      contactName: contacts.displayName,
      contactPhone: contacts.phone,
      contactEmail: contacts.email,
      contactAddress: contacts.address,
      channel: conversations.channel,
      businessName: businesses.name,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(conversations, eq(conversations.id, leads.conversationId))
    .innerJoin(businesses, eq(businesses.id, leads.businessId))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (row === undefined) return null;
  const lead = row.lead;

  const fieldRows = await ctx.tx
    .select({ key: leadFields.key, value: leadFields.value })
    .from(leadFields)
    .where(eq(leadFields.leadId, leadId))
    .orderBy(asc(leadFields.key));
  const fields: Record<string, unknown> = {};
  for (const field of fieldRows) fields[field.key] = field.value ?? null;
  const text = (key: string) => asText(fields[key]);

  const [report] = await ctx.tx
    .select({ summary: leadReports.summary, markdown: leadReports.markdown })
    .from(leadReports)
    .where(eq(leadReports.leadId, leadId))
    .orderBy(desc(leadReports.version))
    .limit(1);

  const [booking] = await ctx.tx
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      timezone: bookings.timezone,
    })
    .from(bookings)
    .where(eq(bookings.leadId, leadId))
    .orderBy(desc(bookings.updatedAt))
    .limit(1);

  let transcript: string | null = null;
  if (options.transcript) {
    const rows = await ctx.tx
      .select({ author: messages.author, text: messages.text, status: messages.status })
      .from(messages)
      .where(eq(messages.conversationId, lead.conversationId))
      .orderBy(desc(messages.sequence))
      .limit(TRANSCRIPT_MESSAGES);
    const lines = rows
      .reverse()
      .filter((message) => message.text !== null && message.status !== "superseded")
      .map((message) => `${SPEAKERS[message.author] ?? "Other"}: ${message.text ?? ""}`);
    let joined = lines.join("\n");
    // Keep the end of a long conversation: it holds the answers that matter.
    if (joined.length > TRANSCRIPT_CHARS) joined = `…${joined.slice(-TRANSCRIPT_CHARS)}`;
    transcript = joined.length > 0 ? joined : null;
  }

  const name = text("contact_name") ?? row.contactName;
  const address = text("job_address") ?? row.contactAddress;
  const { firstName, lastName } = splitName(name);
  return {
    lead: {
      id: lead.id,
      status: lead.status,
      score: lead.score,
      band: lead.band ?? "unscored",
      routing: lead.routingOutcome ?? null,
      fields,
      report: report ?? null,
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
      trigger: options.trigger,
    },
    contact: {
      id: lead.contactId,
      name,
      phone: text("contact_phone") ?? row.contactPhone,
      email: text("contact_email") ?? row.contactEmail,
      address,
      firstName,
      lastName,
      postalCode: findPostalCode(address, text("service_area")),
    },
    business: { id: lead.businessId, name: row.businessName },
    conversation: {
      id: lead.conversationId,
      channel: row.channel,
      url: publicUrl(options.appUrl, INTEGRATION_ROUTES.conversation(lead.conversationId)),
    },
    booking:
      booking === undefined
        ? null
        : {
            id: booking.id,
            status: booking.status,
            startsAt: booking.startsAt?.toISOString() ?? null,
            endsAt: booking.endsAt?.toISOString() ?? null,
            timezone: booking.timezone,
          },
    transcript,
  };
}
