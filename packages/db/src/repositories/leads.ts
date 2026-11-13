import { and, desc, eq, gte, ilike, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type BusinessId,
  CHANNEL_IDS,
  type ChannelId,
  type ConversationId,
  LEAD_STATUSES,
  type LeadId,
  ROUTING_OUTCOMES,
} from "@repo/core";

import type { UserContext } from "../context";
import { businesses, contacts, conversations, leadReports, leads } from "../schema/tables";
import { likePattern } from "./inbox";

/*
 * The lead list and its CSV export for the admin panel and the client portal (C16), as the
 * signed-in user: row-level security decides which businesses' leads are visible. The caller
 * narrows with `businessIds` (the businesses whose client-portal settings allow the screen)
 * and says whether the written reports may be included.
 */

/** A calendar day, `YYYY-MM-DD`, that exists (not 2026-13-45). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const DateText = z.string().refine(isCalendarDay, "Not a calendar day.");

export const LeadFilter = z.object({
  businessId: z.uuid().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  band: z.string().trim().min(1).max(40).optional(),
  outcome: z.enum(ROUTING_OUTCOMES).optional(),
  channel: z.enum(CHANNEL_IDS).optional(),
  minScore: z.number().min(0).max(100).optional(),
  /** Created on or after this day (UTC). */
  from: DateText.optional(),
  /** Created before the end of this day (UTC). */
  to: DateText.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "score"]).default("newest"),
  limit: z.number().int().min(1).max(5000).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export type LeadFilter = z.input<typeof LeadFilter>;

export interface LeadRow {
  readonly id: LeadId;
  readonly businessId: BusinessId;
  readonly businessName: string;
  readonly conversationId: ConversationId;
  readonly channel: ChannelId;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string;
  readonly score: number;
  readonly band: string | null;
  readonly routingOutcome: string | null;
  readonly createdAt: string;
  readonly qualifiedAt: string | null;
  /** The newest report's summary; null when reports are not included or none exists. */
  readonly summary: string | null;
}

export async function listLeads(
  ctx: UserContext,
  input: LeadFilter & {
    readonly businessIds: readonly BusinessId[] | null;
    readonly includeReports: boolean;
  },
): Promise<{ readonly rows: readonly LeadRow[]; readonly more: boolean }> {
  const filter = LeadFilter.parse(input);
  if (input.businessIds !== null && input.businessIds.length === 0)
    return { rows: [], more: false };
  const where: (SQL | undefined)[] = [];
  if (input.businessIds !== null) where.push(inArray(leads.businessId, [...input.businessIds]));
  if (filter.businessId !== undefined) {
    where.push(eq(leads.businessId, filter.businessId as BusinessId));
  }
  if (filter.status !== undefined) where.push(eq(leads.status, filter.status));
  if (filter.band !== undefined) where.push(eq(leads.band, filter.band));
  if (filter.outcome !== undefined) where.push(eq(leads.routingOutcome, filter.outcome));
  if (filter.channel !== undefined) where.push(eq(conversations.channel, filter.channel));
  if (filter.minScore !== undefined) where.push(gte(leads.score, filter.minScore));
  if (filter.from !== undefined) {
    where.push(gte(leads.createdAt, new Date(`${filter.from}T00:00:00.000Z`)));
  }
  if (filter.to !== undefined) {
    const end = new Date(`${filter.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    where.push(lt(leads.createdAt, end));
  }
  if (filter.q !== undefined && filter.q !== "") {
    const pattern = likePattern(filter.q);
    where.push(
      or(
        ilike(contacts.displayName, pattern),
        ilike(contacts.phone, pattern),
        ilike(contacts.email, pattern),
      ),
    );
  }
  const summary = input.includeReports
    ? sql<
        string | null
      >`(select r.summary from ${leadReports} r where r.lead_id = ${leads.id} order by r.version desc limit 1)`
    : sql<null>`null`;
  const rows = await ctx.tx
    .select({
      id: leads.id,
      businessId: leads.businessId,
      businessName: businesses.name,
      conversationId: leads.conversationId,
      channel: conversations.channel,
      contactName: contacts.displayName,
      phone: contacts.phone,
      email: contacts.email,
      status: leads.status,
      score: leads.score,
      band: leads.band,
      routingOutcome: leads.routingOutcome,
      createdAt: leads.createdAt,
      qualifiedAt: leads.qualifiedAt,
      summary,
    })
    .from(leads)
    .innerJoin(businesses, eq(businesses.id, leads.businessId))
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(conversations, eq(conversations.id, leads.conversationId))
    .where(and(...where))
    .orderBy(
      ...(filter.sort === "score" ? [desc(leads.score)] : []),
      desc(leads.createdAt),
      desc(leads.id),
    )
    .limit(filter.limit + 1)
    .offset(filter.offset);
  return {
    more: rows.length > filter.limit,
    rows: rows.slice(0, filter.limit).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
      summary: row.summary ?? null,
    })),
  };
}

/** Characters that make a spreadsheet read a cell as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: quoted when needed, and neutralized when a spreadsheet would run it as a
 * formula (a leading `=`, `+`, `-`, `@`, tab or carriage return gets a `'` in front).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}
