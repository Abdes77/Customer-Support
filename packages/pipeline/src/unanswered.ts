import { type BusinessContext, sql } from "@repo/db";

/**
 * Customer messages nobody dealt with (C18, THREAT_MODEL 4.16): a dead job runner is
 * invisible from inside the runner (the sweeper that would notice is a job too), so the
 * readiness check, which runs in the web request, counts what the runner should have done.
 *
 * A message counts when it is a customer's message (not a reaction, which never starts a
 * turn), no turn dealt with it (it is above the conversation's `handled_through_seq`, which
 * every finished turn moves, a turn stopped by a guard included: a takeover, a limit, a
 * channel guard), no turn of its conversation even started after it arrived, and nothing was
 * sent in the conversation after it, and it arrived between `UNANSWERED_AFTER_MS` and
 * `UNANSWERED_WINDOW_MS` ago. The lower bound is above the longest reply wait a setting allows
 * (15 minutes) plus the debounce cap; the upper bound keeps the count to recent work, while a
 * runner that never runs keeps adding new ones.
 *
 * "Started" matters: a turn that ran and failed (the model was down, a bug) has its own alert
 * and dead letter, and is not a dead runner. Without it, one failed turn, which a customer can
 * sometimes provoke, would fail the whole deployment's readiness for an hour and a half.
 */
export const UNANSWERED_AFTER_MS = 30 * 60_000;
export const UNANSWERED_WINDOW_MS = 2 * 3600_000;

export async function countUnansweredMessages(ctx: BusinessContext, now: Date): Promise<number> {
  const before = new Date(now.getTime() - UNANSWERED_AFTER_MS).toISOString();
  const after = new Date(now.getTime() - UNANSWERED_WINDOW_MS).toISOString();
  const rows = (await ctx.tx.execute(
    sql`select count(*)::int as total
          from messages m
          join conversations c on c.id = m.conversation_id
         where m.business_id = ${ctx.tenant.businessId}::uuid
           and m.direction = 'inbound'
           and m.kind <> 'reaction'
           and m.created_at < ${before}::timestamptz
           and m.created_at > ${after}::timestamptz
           and m.sequence > c.handled_through_seq
           and not exists (
             select 1 from conversation_turns t
              where t.conversation_id = m.conversation_id
                and t.started_at >= m.created_at
           )
           and not exists (
             select 1 from messages o
              where o.conversation_id = m.conversation_id
                and o.direction = 'outbound'
                and o.sequence > m.sequence
           )`,
  )) as unknown as { total: number }[];
  return rows[0]?.total ?? 0;
}
