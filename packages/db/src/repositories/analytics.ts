import { sql } from "drizzle-orm";
import { z } from "zod";

import type { BusinessId, ChannelId } from "@repo/core";

import type { UserContext } from "../context";

/*
 * Analytics for the admin panel and the client portal (C16), computed from the stored rows as
 * the signed-in user: row-level security decides which conversations count, so a client user
 * gets their own business's numbers only. The caller narrows further with `businessIds`.
 *
 * The unit is a conversation started in the period. Per conversation:
 * - first-response time: from the customer's first message to the first reply of ours that
 *   went out (sent, delivered or read) after it;
 * - the furthest step it reached, in order: started (the customer wrote), answered (we
 *   replied), engaged (the customer wrote again after our first reply), qualified (its lead
 *   was qualified at some point), booked (a meeting is on: confirmed, rescheduled or done).
 *   A conversation "drops off" at the step after its furthest one; the drop-off step is where
 *   the most conversations stop.
 */

export const FUNNEL_STEPS = ["started", "answered", "engaged", "qualified", "booked"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const AnalyticsRange = z.object({
  /** Conversations started at or after this instant. */
  from: z.date(),
  /** ... and before this one. */
  to: z.date(),
});

export interface ConversationFact {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly businessName: string;
  readonly segmentId: string | null;
  readonly segmentName: string | null;
  readonly channel: ChannelId;
  readonly firstResponseSeconds: number | null;
  readonly step: FunnelStep;
  readonly qualified: boolean;
  readonly booked: boolean;
}

export interface AnalyticsSummary {
  readonly conversations: number;
  /** Conversations we answered (a reply went out after the customer's first message). */
  readonly answered: number;
  readonly firstResponseMedianSeconds: number | null;
  readonly firstResponseMeanSeconds: number | null;
  readonly qualified: number;
  /** qualified / conversations, 0 to 1; null without conversations. */
  readonly qualificationRate: number | null;
  readonly bookedMeetings: number;
  /** How many conversations reached each step (cumulative). */
  readonly reached: Readonly<Record<FunnelStep, number>>;
  /** How many stopped at each step (their furthest). */
  readonly stoppedAt: Readonly<Record<FunnelStep, number>>;
  /** The step after which the most conversations were lost; null when none were. */
  readonly dropOffStep: { readonly after: FunnelStep; readonly lost: number } | null;
}

export interface AnalyticsReport {
  readonly total: AnalyticsSummary;
  readonly byBusiness: readonly (AnalyticsSummary & {
    readonly key: string;
    readonly label: string;
  })[];
  readonly byChannel: readonly (AnalyticsSummary & {
    readonly key: string;
    readonly label: string;
  })[];
  readonly bySegment: readonly (AnalyticsSummary & {
    readonly key: string;
    readonly label: string;
  })[];
}

/** The per-conversation facts of the period, as the user may see them. */
export async function loadConversationFacts(
  ctx: UserContext,
  input: {
    readonly from: Date;
    readonly to: Date;
    readonly businessIds: readonly BusinessId[] | null;
  },
): Promise<ConversationFact[]> {
  const range = AnalyticsRange.parse({ from: input.from, to: input.to });
  if (input.businessIds !== null && input.businessIds.length === 0) return [];
  const ids = input.businessIds === null ? null : [...input.businessIds];
  const rows = await ctx.tx.execute<{
    id: string;
    business_id: string;
    business_name: string;
    segment_id: string | null;
    segment_name: string | null;
    channel: string;
    first_in: Date | string | null;
    first_out: Date | string | null;
    engaged: boolean;
    qualified: boolean;
    booked: boolean;
  }>(sql`
    select
      c.id, c.business_id, b.name as business_name, b.segment_id, s.name as segment_name, c.channel,
      fi.at as first_in,
      fo.at as first_out,
      exists (
        select 1 from messages m
        where m.conversation_id = c.id and m.direction = 'inbound'
          and fo.at is not null and coalesce(m.sent_at, m.created_at) > fo.at
      ) as engaged,
      exists (
        select 1 from leads l where l.conversation_id = c.id and l.qualified_at is not null
      ) as qualified,
      exists (
        select 1 from bookings k
        where k.conversation_id = c.id and k.status in ('confirmed', 'rescheduled', 'completed')
      ) as booked
    from conversations c
    join businesses b on b.id = c.business_id
    left join segments s on s.id = b.segment_id
    left join lateral (
      select min(coalesce(m.sent_at, m.created_at)) as at from messages m
      where m.conversation_id = c.id and m.direction = 'inbound'
    ) fi on true
    left join lateral (
      select min(coalesce(m.sent_at, m.created_at)) as at from messages m
      where m.conversation_id = c.id and m.direction = 'outbound'
        and m.status in ('sent', 'delivered', 'read')
        and fi.at is not null and coalesce(m.sent_at, m.created_at) >= fi.at
    ) fo on true
    where c.created_at >= ${range.from.toISOString()}::timestamptz
      and c.created_at < ${range.to.toISOString()}::timestamptz
      ${
        ids === null
          ? sql``
          : sql`and c.business_id in (${sql.join(
              ids.map((value) => sql`${value}::uuid`),
              sql`, `,
            )})`
      }
    order by c.created_at
  `);
  return rows.map((row) => {
    const firstIn = row.first_in === null ? null : new Date(row.first_in);
    const firstOut = row.first_out === null ? null : new Date(row.first_out);
    const step: FunnelStep = row.booked
      ? "booked"
      : row.qualified
        ? "qualified"
        : row.engaged
          ? "engaged"
          : firstOut !== null
            ? "answered"
            : "started";
    return {
      id: row.id,
      businessId: row.business_id as BusinessId,
      businessName: row.business_name,
      segmentId: row.segment_id,
      segmentName: row.segment_name,
      channel: row.channel as ChannelId,
      firstResponseSeconds:
        firstIn === null || firstOut === null
          ? null
          : Math.max(0, Math.round((firstOut.getTime() - firstIn.getTime()) / 1000)),
      step,
      qualified: row.qualified,
      booked: row.booked,
    };
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Pure: the summary of a set of conversation facts. */
export function summarize(facts: readonly ConversationFact[]): AnalyticsSummary {
  const times = facts.flatMap((fact) =>
    fact.firstResponseSeconds === null ? [] : [fact.firstResponseSeconds],
  );
  const index = (step: FunnelStep) => FUNNEL_STEPS.indexOf(step);
  const reached = {} as Record<FunnelStep, number>;
  const stoppedAt = {} as Record<FunnelStep, number>;
  for (const step of FUNNEL_STEPS) {
    reached[step] = facts.filter((fact) => index(fact.step) >= index(step)).length;
    stoppedAt[step] = facts.filter((fact) => fact.step === step).length;
  }
  let dropOffStep: AnalyticsSummary["dropOffStep"] = null;
  for (const step of FUNNEL_STEPS.slice(0, -1)) {
    const lost = stoppedAt[step];
    if (lost > 0 && (dropOffStep === null || lost > dropOffStep.lost))
      dropOffStep = { after: step, lost };
  }
  const qualified = facts.filter((fact) => fact.qualified).length;
  return {
    conversations: facts.length,
    answered: reached.answered,
    firstResponseMedianSeconds: median(times),
    firstResponseMeanSeconds:
      times.length === 0
        ? null
        : Math.round(times.reduce((sum, value) => sum + value, 0) / times.length),
    qualified,
    qualificationRate: facts.length === 0 ? null : qualified / facts.length,
    bookedMeetings: facts.filter((fact) => fact.booked).length,
    reached,
    stoppedAt,
    dropOffStep,
  };
}

function groupBy(
  facts: readonly ConversationFact[],
  key: (fact: ConversationFact) => string,
  label: (fact: ConversationFact) => string,
): (AnalyticsSummary & { readonly key: string; readonly label: string })[] {
  const groups = new Map<string, ConversationFact[]>();
  for (const fact of facts) {
    const list = groups.get(key(fact)) ?? [];
    list.push(fact);
    groups.set(key(fact), list);
  }
  return [...groups.entries()]
    .map(([groupKey, list]) => ({ key: groupKey, label: label(list[0]!), ...summarize(list) }))
    .sort((a, b) => b.conversations - a.conversations || a.label.localeCompare(b.label));
}

/** The report: totals and the same numbers by business, channel and segment. */
export async function computeAnalytics(
  ctx: UserContext,
  input: {
    readonly from: Date;
    readonly to: Date;
    readonly businessIds: readonly BusinessId[] | null;
  },
): Promise<AnalyticsReport> {
  const facts = await loadConversationFacts(ctx, input);
  return {
    total: summarize(facts),
    byBusiness: groupBy(
      facts,
      (fact) => fact.businessId,
      (fact) => fact.businessName,
    ),
    byChannel: groupBy(
      facts,
      (fact) => fact.channel,
      (fact) => fact.channel,
    ),
    bySegment: groupBy(
      facts,
      (fact) => fact.segmentId ?? "none",
      (fact) => fact.segmentName ?? (fact.segmentId === null ? "No segment" : "Segment"),
    ),
  };
}
