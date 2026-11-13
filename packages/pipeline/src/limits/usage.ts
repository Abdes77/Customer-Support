import { localMoment, zonedInstant } from "@repo/ai";
import type { ContactId, ConversationId, TurnTrigger } from "@repo/core";
import { type BusinessContext, businesses, eq, sql } from "@repo/db";
import type { AppSettings } from "@repo/settings";

/**
 * What the limits guard measures (C17), all from rows the pipeline already writes: inbound
 * customer messages, the bot's outbound messages and `model_calls.cost_micro_usd`. Model
 * calls of a turn that escalated an emergency (an `escalations` row with the turn's trace)
 * never count: life-safety answers are outside every cap.
 *
 * Windows: "per hour" is the last 60 minutes; "per day" and "per month" are the business's
 * calendar day and month in its own time zone (the settings say "until the next day"); the
 * agency-wide cap counts the UTC day, since an agency spans time zones.
 */

export const LIMIT_KEYS = [
  "contact_messages_per_hour",
  "contact_replies_per_day",
  "business_replies_per_day",
  "contact_daily_spend",
  "business_daily_spend",
  "business_monthly_spend",
  "agency_daily_spend",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Limits that count one customer; the others count the business or the agency. */
export const CONTACT_LIMITS: ReadonlySet<LimitKey> = new Set([
  "contact_messages_per_hour",
  "contact_replies_per_day",
  "contact_daily_spend",
]);

export interface LimitUsage {
  readonly contactMessagesLastHour: number;
  readonly contactRepliesToday: number;
  readonly businessRepliesToday: number;
  /** Millionths of a dollar. */
  readonly contactSpendToday: number;
  readonly businessSpendToday: number;
  readonly businessSpendThisMonth: number;
  /** Null when no agency-wide cap is set (nothing was measured). */
  readonly agencySpendToday: number | null;
}

export type LimitValues = Pick<
  AppSettings,
  | "limits.contact_messages_per_hour"
  | "limits.contact_replies_per_day"
  | "limits.business_replies_per_day"
  | "limits.contact_daily_spend_usd"
  | "limits.business_daily_spend_usd"
  | "limits.business_monthly_spend_usd"
  | "limits.agency_daily_spend_usd"
>;

const MICRO = 1_000_000;

/**
 * The first limit the usage has reached, or null. Pure. The per-hour message limit counts
 * what the customer wrote, so it applies to a turn their message started only; a follow-up
 * the bot starts itself is never stopped by it.
 */
export function exceededLimit(
  usage: LimitUsage,
  values: LimitValues,
  trigger: TurnTrigger,
): LimitKey | null {
  if (
    trigger === "inbound_message" &&
    usage.contactMessagesLastHour > values["limits.contact_messages_per_hour"]
  ) {
    return "contact_messages_per_hour";
  }
  if (usage.contactRepliesToday >= values["limits.contact_replies_per_day"]) {
    return "contact_replies_per_day";
  }
  const businessReplies = values["limits.business_replies_per_day"];
  if (businessReplies !== null && usage.businessRepliesToday >= businessReplies) {
    return "business_replies_per_day";
  }
  const reached = (spent: number, capUsd: number | null) =>
    capUsd !== null && spent >= Math.round(capUsd * MICRO);
  if (reached(usage.contactSpendToday, values["limits.contact_daily_spend_usd"])) {
    return "contact_daily_spend";
  }
  if (reached(usage.businessSpendToday, values["limits.business_daily_spend_usd"])) {
    return "business_daily_spend";
  }
  if (reached(usage.businessSpendThisMonth, values["limits.business_monthly_spend_usd"])) {
    return "business_monthly_spend";
  }
  if (
    usage.agencySpendToday !== null &&
    reached(usage.agencySpendToday, values["limits.agency_daily_spend_usd"])
  ) {
    return "agency_daily_spend";
  }
  return null;
}

/** Midnight of `now`'s calendar day in `timeZone`. */
export function startOfDay(now: Date, timeZone: string): Date {
  return zonedInstant(localMoment(now, timeZone).date, "00:00", timeZone);
}

/** Midnight of the first day of `now`'s calendar month in `timeZone`. */
export function startOfMonth(now: Date, timeZone: string): Date {
  const date = localMoment(now, timeZone).date;
  return zonedInstant(`${date.slice(0, 8)}01`, "00:00", timeZone);
}

export async function businessTimeZone(ctx: BusinessContext): Promise<string> {
  const [row] = await ctx.tx
    .select({ timeZone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, ctx.tenant.businessId))
    .limit(1);
  return row?.timeZone ?? "America/New_York";
}

function numberOf(rows: readonly Record<string, unknown>[], column: string): number {
  const value = rows[0]?.[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * Measures the usage of one turn's contact and business, inside the turn's claim transaction
 * (row-level security keeps every count inside the business). `agencySpend` is asked only
 * when an agency-wide cap is set.
 */
export async function measureUsage(
  ctx: BusinessContext,
  input: {
    readonly contactId: ContactId;
    readonly conversationId: ConversationId;
    readonly now: Date;
    readonly timeZone: string;
    readonly agencySpend: ((since: Date) => Promise<number>) | null;
  },
): Promise<LimitUsage> {
  const hourAgo = new Date(input.now.getTime() - 3600_000).toISOString();
  const day = startOfDay(input.now, input.timeZone).toISOString();
  const month = startOfMonth(input.now, input.timeZone).toISOString();
  const contact = input.contactId;

  const messageRows = await ctx.tx.execute(
    sql`select
          count(*) filter (
            where m.direction = 'inbound' and m.author = 'customer'
              and m.created_at > ${hourAgo}::timestamptz
              and c.contact_id = ${contact}::uuid
          )::int as contact_inbound,
          count(*) filter (
            where m.direction = 'outbound' and m.author = 'bot'
              and m.status not in ('superseded', 'failed')
              and m.created_at >= ${day}::timestamptz
              and c.contact_id = ${contact}::uuid
          )::int as contact_replies,
          count(*) filter (
            where m.direction = 'outbound' and m.author = 'bot'
              and m.status not in ('superseded', 'failed')
              and m.created_at >= ${day}::timestamptz
          )::int as business_replies
        from messages m
        join conversations c on c.id = m.conversation_id
       where m.business_id = ${ctx.tenant.businessId}::uuid
         and m.created_at >= least(${hourAgo}::timestamptz, ${day}::timestamptz)`,
  );
  const spendRows = await ctx.tx.execute(
    sql`select
          coalesce(sum(mc.cost_micro_usd) filter (
            where mc.started_at >= ${day}::timestamptz
              and mc.conversation_id in (
                select id from conversations where contact_id = ${contact}::uuid
              )
          ), 0)::text as contact_day,
          coalesce(sum(mc.cost_micro_usd) filter (
            where mc.started_at >= ${day}::timestamptz
          ), 0)::text as business_day,
          coalesce(sum(mc.cost_micro_usd), 0)::text as business_month
        from model_calls mc
       where mc.business_id = ${ctx.tenant.businessId}::uuid
         and mc.started_at >= least(${month}::timestamptz, ${day}::timestamptz)
         and not exists (
           select 1 from escalations e
            where e.business_id = mc.business_id and e.trace_id = mc.trace_id
         )`,
  );
  const utcDay = new Date(`${input.now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return {
    contactMessagesLastHour: numberOf(messageRows, "contact_inbound"),
    contactRepliesToday: numberOf(messageRows, "contact_replies"),
    businessRepliesToday: numberOf(messageRows, "business_replies"),
    contactSpendToday: numberOf(spendRows, "contact_day"),
    businessSpendToday: numberOf(spendRows, "business_day"),
    businessSpendThisMonth: numberOf(spendRows, "business_month"),
    agencySpendToday: input.agencySpend === null ? null : await input.agencySpend(utcDay),
  };
}
