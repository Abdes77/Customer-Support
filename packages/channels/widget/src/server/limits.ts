import { type BusinessContext, sql, usageCounters } from "@repo/db";

/**
 * Fixed-window counters in `usage_counters` (one row per business, metric, subject and
 * window). `hit` adds one and returns the new count in a single statement, so concurrent
 * requests cannot both slip under a limit.
 */
export async function hit(
  ctx: BusinessContext,
  input: {
    readonly metric: string;
    readonly subject: string;
    readonly windowSeconds: number;
    readonly now: Date;
  },
): Promise<{ readonly count: number; readonly retryAfterSeconds: number }> {
  const windowMs = input.windowSeconds * 1000;
  const start = Math.floor(input.now.getTime() / windowMs) * windowMs;
  const [row] = await ctx.tx
    .insert(usageCounters)
    .values({
      ...ctx.tenant,
      metric: input.metric,
      subject: input.subject,
      windowStart: new Date(start),
      windowSeconds: input.windowSeconds,
      value: 1,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.businessId,
        usageCounters.metric,
        usageCounters.subject,
        usageCounters.windowStart,
        usageCounters.windowSeconds,
      ],
      set: { value: sql`${usageCounters.value} + 1`, updatedAt: input.now },
    })
    .returning({ value: usageCounters.value });
  return {
    count: row?.value ?? 1,
    retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - input.now.getTime()) / 1000)),
  };
}
