import type { AgencyId, BusinessId, ConversationId } from "@repo/core";
import {
  and,
  attachments,
  type BusinessContext,
  type BusinessRef,
  contacts,
  conversations,
  eq,
  escalations,
  inArray,
  isNotNull,
  leads,
  lt,
  messages,
  modelCalls,
  or,
  type SQL,
  sql,
  storedUploads,
  takeoverLocks,
  usageCounters,
  widgetSessions,
} from "@repo/db";
import { type CronJobDefinition, defineCronJob, describeJobError } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import type { PipelineContext } from "../deps";
import { raiseInAppAlert } from "../failures";

/**
 * Data retention (C17), driven by the `data.*` settings of each business, once a day:
 *
 * - Conversations whose last message is older than `data.conversation_retention_days`: their
 *   files are deleted from storage and the conversation with everything under it (messages,
 *   attachments, turns, model calls, notes, alerts, bookings, escalations) is deleted, and
 *   then the contact when nothing else refers to it. When the conversation's lead must be
 *   kept longer (`data.lead_retention_days` empty, or the lead changed more recently), the
 *   conversation row stays as the lead's anchor and only its messages, files, turns, notes
 *   and model calls go. A conversation with a running emergency or an active takeover waits.
 * - Leads unchanged for `data.lead_retention_days` are deleted (their fields, reports,
 *   routing and events with them).
 * - Customer files older than `data.attachment_retention_days` are deleted from storage; the
 *   attachment row keeps its description (status `purged`).
 * - Model calls older than `data.model_call_retention_days` lose their request and response;
 *   tokens, cost and timing stay for the spend caps and reports.
 * - Audit entries older than `data.audit_log_retention_days` (agency-wide, at least 90 days,
 *   through `app.purge_audit_log`).
 * - Housekeeping the C8 review asked for: expired or revoked website-chat sessions after a
 *   week, finished rate-limit windows after two days, and uploads stored before a message
 *   that was never ingested (`stored_uploads`) after a day.
 *
 * Each business is purged in batches (`BATCH`), in its own system scope; one failing business
 * is logged and alerted and the others go on. Runs are idempotent: what is gone stays gone,
 * and the next day's run takes what a batch limit left.
 */

export const RETENTION_FUNCTION_ID = "retention-purge";

const DAY_MS = 86_400_000;
const BATCH = 200;
const EMERGENCY_HOLD_MS = 6 * 3600 * 1000;
const WIDGET_SESSION_GRACE_MS = 7 * DAY_MS;
const COUNTER_GRACE_MS = 2 * DAY_MS;
const UPLOAD_GRACE_MS = DAY_MS;

export interface PurgeResult {
  readonly conversationsDeleted: number;
  readonly conversationsEmptied: number;
  readonly contactsDeleted: number;
  readonly leadsDeleted: number;
  readonly filesDeleted: number;
  readonly modelCallsTrimmed: number;
  readonly widgetSessionsDeleted: number;
  readonly countersDeleted: number;
  readonly uploadsDeleted: number;
}

const EMPTY: PurgeResult = {
  conversationsDeleted: 0,
  conversationsEmptied: 0,
  contactsDeleted: 0,
  leadsDeleted: 0,
  filesDeleted: 0,
  modelCallsTrimmed: 0,
  widgetSessionsDeleted: 0,
  countersDeleted: 0,
  uploadsDeleted: 0,
};

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

async function conversationsDue(
  ctx: BusinessContext,
  before: Date,
  now: Date,
): Promise<{ id: ConversationId; leadUpdatedAt: Date | null }[]> {
  const holdSince = ago(now, EMERGENCY_HOLD_MS);
  return ctx.tx
    .select({ id: conversations.id, leadUpdatedAt: leads.updatedAt })
    .from(conversations)
    .leftJoin(leads, eq(leads.conversationId, conversations.id))
    .where(
      and(
        lt(
          sql`greatest(coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}), coalesce(${conversations.lastOutboundAt}, ${conversations.createdAt}), ${conversations.createdAt})`,
          sql`${before.toISOString()}::timestamptz`,
        ),
        // Already emptied: nothing left to purge but the anchor of a kept lead.
        sql`not (${conversations.metadata} ? 'purgedAt')`,
        sql`not exists (select 1 from ${takeoverLocks} tl where tl.conversation_id = ${conversations.id} and tl.released_at is null)`,
        sql`not exists (select 1 from ${escalations} e where e.conversation_id = ${conversations.id} and (e.status = 'active' or e.started_at > ${holdSince.toISOString()}::timestamptz))`,
      ),
    )
    .orderBy(conversations.createdAt)
    .limit(BATCH);
}

async function filesOf(ctx: BusinessContext, where: SQL): Promise<{ id: string; path: string }[]> {
  const rows = await ctx.tx
    .select({ id: attachments.id, path: attachments.storagePath })
    .from(attachments)
    .where(and(isNotNull(attachments.storagePath), where));
  return rows.flatMap((row) => (row.path === null ? [] : [{ id: row.id, path: row.path }]));
}

/** Purges one business by its settings. Exported for tests and the dev tools. */
export async function purgeBusiness(
  p: PipelineContext,
  business: BusinessRef,
): Promise<PurgeResult & { readonly auditRetentionDays: number | null }> {
  const now = p.clock();
  const tenant = { agencyId: business.agencyId, businessId: business.businessId };
  const scope = p.db.forBusiness(business.businessId, { agencyId: business.agencyId });
  const storage = p.storage(tenant);
  const settings = await scope.run((ctx) => loadSettings(ctx, tenant, { logger: p.logger }));
  const values = settings.values;
  const result = { ...EMPTY };

  // Conversations (and contacts left without one).
  const conversationDays = values["data.conversation_retention_days"];
  const leadDays = values["data.lead_retention_days"];
  if (conversationDays !== null) {
    const before = ago(now, conversationDays * DAY_MS);
    const leadBefore = leadDays === null ? null : ago(now, leadDays * DAY_MS);
    const due = await scope.run((ctx) => conversationsDue(ctx, before, now));
    for (const conversation of due) {
      const keepLead =
        conversation.leadUpdatedAt !== null &&
        (leadBefore === null || conversation.leadUpdatedAt >= leadBefore);
      // Files first: once the rows are gone nothing knows where the files were.
      const files = await scope.run((ctx) =>
        filesOf(
          ctx,
          sql`${attachments.messageId} in (select m.id from messages m where m.conversation_id = ${conversation.id}::uuid)`,
        ),
      );
      if (files.length > 0) await storage.remove(files.map((file) => file.path));
      result.filesDeleted += files.length;
      await scope.run(async (ctx) => {
        if (keepLead) {
          await ctx.tx.delete(messages).where(eq(messages.conversationId, conversation.id));
          await ctx.tx.delete(modelCalls).where(eq(modelCalls.conversationId, conversation.id));
          await ctx.tx.execute(
            sql`delete from conversation_turns where conversation_id = ${conversation.id}::uuid`,
          );
          await ctx.tx.execute(
            sql`delete from internal_notes where conversation_id = ${conversation.id}::uuid`,
          );
          await ctx.tx
            .update(conversations)
            .set({
              metadata: sql`${conversations.metadata} || jsonb_build_object('purgedAt', ${now.toISOString()}::text)`,
            })
            .where(eq(conversations.id, conversation.id));
          result.conversationsEmptied += 1;
        } else {
          await ctx.tx.delete(conversations).where(eq(conversations.id, conversation.id));
          result.conversationsDeleted += 1;
        }
      });
    }
    // Contacts with no conversation and no lead left hold nothing but personal data.
    result.contactsDeleted += await scope.run(async (ctx) => {
      const removed = await ctx.tx
        .delete(contacts)
        .where(
          and(
            lt(contacts.createdAt, before),
            sql`not exists (select 1 from conversations c where c.contact_id = ${contacts.id})`,
            sql`not exists (select 1 from leads l where l.contact_id = ${contacts.id})`,
          ),
        )
        .returning({ id: contacts.id });
      return removed.length;
    });
  }

  // Leads unchanged for longer than their retention.
  if (leadDays !== null) {
    const before = ago(now, leadDays * DAY_MS);
    result.leadsDeleted += await scope.run(async (ctx) => {
      const removed = await ctx.tx
        .delete(leads)
        .where(lt(leads.updatedAt, before))
        .returning({ id: leads.id });
      return removed.length;
    });
  }

  // Customer files older than their retention: the file goes, the description stays.
  const attachmentDays = values["data.attachment_retention_days"];
  if (attachmentDays !== null) {
    const before = ago(now, attachmentDays * DAY_MS);
    const files = await scope.run(async (ctx) =>
      (await filesOf(ctx, lt(attachments.createdAt, before))).slice(0, BATCH * 5),
    );
    if (files.length > 0) {
      await storage.remove(files.map((file) => file.path));
      await scope.run((ctx) =>
        ctx.tx
          .update(attachments)
          .set({ storagePath: null, storageBucket: null, status: "purged" })
          .where(
            inArray(
              attachments.id,
              files.map((file) => file.id),
            ),
          ),
      );
    }
    result.filesDeleted += files.length;
  }

  // Model calls: full inputs and outputs go, tokens, cost and timing stay.
  const modelDays = values["data.model_call_retention_days"];
  result.modelCallsTrimmed += await scope.run(async (ctx) => {
    const trimmed = await ctx.tx
      .update(modelCalls)
      .set({ request: null, response: null })
      .where(
        and(
          lt(modelCalls.startedAt, ago(now, modelDays * DAY_MS)),
          or(isNotNull(modelCalls.request), isNotNull(modelCalls.response)),
        ),
      )
      .returning({ id: modelCalls.id });
    return trimmed.length;
  });

  // Housekeeping (C8 review): sessions, counters and uploads that were never ingested.
  await scope.run(async (ctx) => {
    const sessions = await ctx.tx
      .delete(widgetSessions)
      .where(
        or(
          lt(widgetSessions.expiresAt, ago(now, WIDGET_SESSION_GRACE_MS)),
          lt(widgetSessions.revokedAt, ago(now, WIDGET_SESSION_GRACE_MS)),
        ),
      )
      .returning({ id: widgetSessions.id });
    result.widgetSessionsDeleted += sessions.length;
    const counters = await ctx.tx
      .delete(usageCounters)
      .where(
        sql`${usageCounters.windowStart} + make_interval(secs => ${usageCounters.windowSeconds}) < ${ago(now, COUNTER_GRACE_MS).toISOString()}::timestamptz`,
      )
      .returning({ id: usageCounters.id });
    result.countersDeleted += counters.length;
  });
  const uploads = await scope.run((ctx) =>
    ctx.tx
      .select({
        id: storedUploads.id,
        path: storedUploads.path,
        used: sql<boolean>`exists (select 1 from attachments a where a.storage_path = ${storedUploads.path})`,
      })
      .from(storedUploads)
      .where(lt(storedUploads.createdAt, ago(now, UPLOAD_GRACE_MS)))
      .limit(BATCH * 5),
  );
  const orphans = uploads.filter((row) => !row.used);
  if (orphans.length > 0) await storage.remove(orphans.map((row) => row.path));
  if (uploads.length > 0) {
    await scope.run((ctx) =>
      ctx.tx.delete(storedUploads).where(
        inArray(
          storedUploads.id,
          uploads.map((row) => row.id),
        ),
      ),
    );
  }
  result.uploadsDeleted += orphans.length;

  return { ...result, auditRetentionDays: values["data.audit_log_retention_days"] };
}

/** Deletes an agency's audit entries older than `days` (agency-wide scope, ≥ 90 days). */
export async function purgeAuditLog(
  p: PipelineContext,
  agencyId: AgencyId,
  days: number,
): Promise<number> {
  const before = ago(p.clock(), Math.max(90, days) * DAY_MS);
  return p.db.forAgency(agencyId).run(async (ctx) => {
    const rows = await ctx.tx.execute(
      sql`select app.purge_audit_log(${before.toISOString()}::timestamptz) as removed`,
    );
    return Number((rows[0] as { removed?: number } | undefined)?.removed ?? 0);
  });
}

export function retentionJob(p: PipelineContext): CronJobDefinition {
  return defineCronJob({
    id: RETENTION_FUNCTION_ID,
    name: "Delete data past its retention",
    retries: 1,
    // Daily, at a quiet hour for US businesses.
    trigger: { cron: "17 8 * * *" },
    handler: async ({ step }) => {
      const list = await step.run("businesses", () =>
        p.db.directory.listBusinesses({
          statuses: ["onboarding", "active", "paused", "archived"],
        }),
      );
      const totals: Record<string, number> = {};
      const auditDays = new Map<AgencyId, number | null>();
      for (const business of list) {
        const result = await step.run(`purge-${business.businessId}`, () =>
          purgeBusiness(p, business).catch(async (error: unknown) => {
            await recordFailure(p, business.agencyId, business.businessId, error);
            return { ...EMPTY, auditRetentionDays: null };
          }),
        );
        for (const [key, value] of Object.entries(result)) {
          if (typeof value === "number" && key !== "auditRetentionDays") {
            totals[key] = (totals[key] ?? 0) + value;
          }
        }
        // The audit retention is a global setting: any business of the agency carries it.
        if (!auditDays.has(business.agencyId)) {
          auditDays.set(business.agencyId, result.auditRetentionDays);
        }
      }
      for (const [agencyId, days] of auditDays) {
        if (days === null) continue;
        const removed = await step.run(`audit-${agencyId}`, () =>
          purgeAuditLog(p, agencyId, days).catch((error: unknown) => {
            p.logger.error("retention.audit_failed", { agencyId, error: describeJobError(error) });
            return 0;
          }),
        );
        totals["auditEntriesDeleted"] = (totals["auditEntriesDeleted"] ?? 0) + removed;
      }
      p.logger.info("retention.done", totals);
      return totals;
    },
    onFailure: async ({ error, runId }) => {
      p.logger.error("retention.failed", { runId, error });
    },
  });
}

async function recordFailure(
  p: PipelineContext,
  agencyId: AgencyId,
  businessId: BusinessId,
  error: unknown,
): Promise<void> {
  const described = describeJobError(error);
  p.logger.error("retention.business_failed", { businessId, error: described });
  try {
    const day = p.clock().toISOString().slice(0, 10);
    await p.db.forBusiness(businessId, { agencyId }).run((ctx) =>
      raiseInAppAlert(ctx, {
        kind: "retention_failed",
        severity: "warning",
        conversationId: null,
        subject:
          "Deleting this business's data past its retention failed; it is tried again tomorrow.",
        dedupeKey: `retention_failed:${day}`,
        payload: { errorCode: described.code },
      }),
    );
  } catch (alertError) {
    p.logger.error("retention.alert_failed", { businessId, error: describeJobError(alertError) });
  }
}
