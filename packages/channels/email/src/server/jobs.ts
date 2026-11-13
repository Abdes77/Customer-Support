import { type EmailSyncRequestedEvent, newTraceId } from "@repo/core";
import { and, channelConnections, eq, inArray } from "@repo/db";
import {
  type AnyJobEvent,
  type CronJobDefinition,
  defineCronJob,
  defineEventJob,
  type Duration,
  type EventJobDefinition,
  jobEvent,
} from "@repo/jobs";

import { EmailConnectionConfig, readState } from "../config";
import type { EmailServerDeps } from "./deps";
import { syncBatch, type SyncTarget } from "./sync";
import { createAccessTokens } from "./tokens";
import { ensurePush, graphNotificationsPossible } from "./watch";

export const EMAIL_SYNC_FUNCTION_ID = "email-sync";
export const EMAIL_POLL_FUNCTION_ID = "email-poll";
export const EMAIL_WATCH_RENEW_FUNCTION_ID = "email-watch-renew";

/** A pushed inbox is still read this often, in case a notification was lost. */
export const SAFETY_SYNC_MS = 15 * 60_000;
/** An inbox that refused our access is retried this often (the person may have fixed it). */
export const ERROR_RETRY_MS = 15 * 60_000;
/** Businesses looked at per step of the poll and renew runs. */
const CHUNK = 50;
/** Batches one sync run reads at most; the next notification or poll reads on. */
const MAX_BATCHES = 8;

export interface EmailJobOptions {
  /** Notifications within this period make one sync (default 5 s, at most 30 s apart). */
  readonly debounce?: { readonly period: Duration; readonly timeout: Duration } | null;
}

/** The `email.sync_requested` event for one inbox. */
export function emailSyncEvent(
  target: SyncTarget,
  reason: EmailSyncRequestedEvent["reason"],
  eventId: string,
): AnyJobEvent {
  return jobEvent("email.sync_requested", eventId, {
    traceId: newTraceId(),
    agencyId: target.agencyId,
    businessId: target.businessId,
    connectionId: target.connectionId,
    reason,
  });
}

/**
 * The email jobs (ARCHITECTURE §4):
 * - `email-sync`: reads new mail of one inbox from its cursor and ingests it; one run at a
 *   time per inbox, notifications close together collapse into one run;
 * - `email-poll` (every minute): an IMAP inbox is read every minute; a Gmail or Microsoft
 *   inbox when it has no push channel, or as a safety net when its last sync is older than
 *   15 minutes; an inbox that refused access every 15 minutes;
 * - `email-watch-renew` (hourly): Gmail watches and Graph subscriptions before they expire.
 */
export function createEmailJobs(
  deps: EmailServerDeps,
  options: EmailJobOptions = {},
): (EventJobDefinition<"email.sync_requested"> | CronJobDefinition)[] {
  const tokens = createAccessTokens(deps);
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({ component: "email-jobs" });
  const debounce =
    options.debounce === undefined
      ? { period: "5s" as const, timeout: "30s" as const }
      : options.debounce;

  const sync = defineEventJob({
    id: EMAIL_SYNC_FUNCTION_ID,
    name: "Read new email of an inbox",
    retries: 3,
    trigger: { event: "email.sync_requested" },
    ...(debounce === null ? {} : { debounce: { key: "event.data.connectionId", ...debounce } }),
    concurrency: { key: "event.data.connectionId", limit: 1 },
    handler: async ({ event, step }) => {
      const target: SyncTarget = {
        agencyId: event.data.agencyId,
        businessId: event.data.businessId,
        connectionId: event.data.connectionId,
      };
      if (event.data.reason === "lifecycle") {
        // Graph asked us to reauthorize, or removed the subscription: renew or recreate it.
        await step.run("push", async () => {
          try {
            return await ensurePush(deps, tokens, target, { force: true });
          } catch (error) {
            log.warn("email.push_renew_failed", {
              businessId: target.businessId,
              connectionId: target.connectionId,
              error,
            });
            return "failed";
          }
        });
      }
      let fetched = 0;
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const result = await step.run(`batch-${batch}`, () => syncBatch(deps, tokens, target));
        fetched += result.fetched;
        if (result.fetched > 0 || result.stopped !== null) {
          log.info("email.synced", {
            traceId: event.data.traceId,
            businessId: target.businessId,
            connectionId: target.connectionId,
            fetched: result.fetched,
            outcomes: result.outcomes,
            stopped: result.stopped,
          });
        }
        if (!result.more || result.stopped !== null) break;
      }
      return { fetched };
    },
    onFailure: async ({ event, error }) => {
      log.warn("email.sync_failed", {
        businessId: event.data.businessId,
        connectionId: event.data.connectionId,
        code: error.code,
      });
      // Shown on the connection page; the next poll tries again.
      await deps.db
        .forBusiness(event.data.businessId, { agencyId: event.data.agencyId })
        .run(async (ctx) => {
          await ctx.tx
            .update(channelConnections)
            .set({
              lastError: `Reading the inbox failed: ${error.message}`.slice(0, 500),
              lastErrorAt: clock(),
            })
            .where(eq(channelConnections.id, event.data.connectionId));
        });
    },
  });

  /** The inboxes of these businesses that the minute poll should read now. */
  async function dueInboxes(
    list: readonly {
      readonly agencyId: SyncTarget["agencyId"];
      readonly businessId: SyncTarget["businessId"];
    }[],
  ): Promise<SyncTarget[]> {
    const due: SyncTarget[] = [];
    for (const business of list) {
      const rows = await deps.db
        .forBusiness(business.businessId, { agencyId: business.agencyId })
        .run((ctx) =>
          ctx.tx
            .select({
              id: channelConnections.id,
              status: channelConnections.status,
              config: channelConnections.config,
              state: channelConnections.state,
              lastErrorAt: channelConnections.lastErrorAt,
            })
            .from(channelConnections)
            .where(
              and(
                eq(channelConnections.channel, "email"),
                inArray(channelConnections.status, ["active", "error"]),
              ),
            ),
        );
      const now = clock().getTime();
      for (const row of rows) {
        const config = EmailConnectionConfig.safeParse(row.config);
        if (!config.success) continue;
        const state = readState(row.state);
        const lastSync = Date.parse(state.lastSyncAt ?? "") || 0;
        if (row.status === "error") {
          const lastError = row.lastErrorAt === null ? 0 : new Date(row.lastErrorAt).getTime();
          if (now - Math.max(lastSync, lastError) < ERROR_RETRY_MS) continue;
        } else if (config.data.provider !== "imap") {
          const pushed =
            config.data.provider === "gmail"
              ? deps.google?.pubsubTopic != null &&
                state.gmail?.watchExpiresAt != null &&
                Date.parse(state.gmail.watchExpiresAt) > now
              : graphNotificationsPossible(deps) &&
                state.subscriptionId != null &&
                Date.parse(state.microsoft?.subscriptionExpiresAt ?? "") > now;
          if (pushed && now - lastSync < SAFETY_SYNC_MS) continue;
        }
        due.push({
          agencyId: business.agencyId,
          businessId: business.businessId,
          connectionId: row.id,
        });
      }
    }
    return due;
  }

  const poll = defineCronJob({
    id: EMAIL_POLL_FUNCTION_ID,
    name: "Poll email inboxes",
    retries: 1,
    trigger: { cron: "* * * * *" },
    handler: async ({ step, runId }) => {
      const list = await step.run("businesses", () =>
        deps.db.directory.listBusinesses({ statuses: ["active", "onboarding", "paused"] }),
      );
      const due: SyncTarget[] = [];
      // A few steps however many businesses there are (Inngest caps the steps of a run).
      for (let index = 0; index * CHUNK < list.length; index += 1) {
        const chunk = list.slice(index * CHUNK, (index + 1) * CHUNK);
        due.push(...(await step.run(`due-${index}`, () => dueInboxes(chunk))));
      }
      if (due.length > 0) {
        // One event per inbox and run: a retried run sends the same ids (no double sync).
        await step.run("emit", async () => {
          await deps.events.send(
            due.map((target) =>
              emailSyncEvent(target, "poll", `email-poll-${target.connectionId}-${runId}`),
            ),
          );
          return null;
        });
      }
      return { due: due.length };
    },
  });

  /** Renews what is close to expiry among these businesses' Gmail and Microsoft inboxes. */
  async function renewChunk(
    list: readonly {
      readonly agencyId: SyncTarget["agencyId"];
      readonly businessId: SyncTarget["businessId"];
    }[],
  ): Promise<Record<string, number>> {
    const outcomes: Record<string, number> = {};
    for (const business of list) {
      const rows = await deps.db
        .forBusiness(business.businessId, { agencyId: business.agencyId })
        .run((ctx) =>
          ctx.tx
            .select({ id: channelConnections.id, config: channelConnections.config })
            .from(channelConnections)
            .where(
              and(eq(channelConnections.channel, "email"), eq(channelConnections.status, "active")),
            ),
        );
      for (const row of rows) {
        const provider = EmailConnectionConfig.safeParse(row.config).data?.provider;
        if (provider !== "gmail" && provider !== "microsoft") continue;
        let outcome: string;
        try {
          outcome = await ensurePush(deps, tokens, { ...business, connectionId: row.id });
        } catch (error) {
          log.warn("email.push_renew_failed", {
            businessId: business.businessId,
            connectionId: row.id,
            error,
          });
          outcome = "failed";
        }
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      }
    }
    return outcomes;
  }

  const renew = defineCronJob({
    id: EMAIL_WATCH_RENEW_FUNCTION_ID,
    name: "Renew Gmail watches and Graph subscriptions",
    retries: 1,
    trigger: { cron: "23 * * * *" },
    handler: async ({ step }) => {
      const list = await step.run("businesses", () =>
        deps.db.directory.listBusinesses({ statuses: ["active", "onboarding", "paused"] }),
      );
      const outcomes: Record<string, number> = {};
      for (let index = 0; index * CHUNK < list.length; index += 1) {
        const chunk = list.slice(index * CHUNK, (index + 1) * CHUNK);
        const counted = await step.run(`renew-${index}`, () => renewChunk(chunk));
        for (const [outcome, total] of Object.entries(counted)) {
          outcomes[outcome] = (outcomes[outcome] ?? 0) + total;
        }
      }
      return outcomes;
    },
  });

  return [sync, poll, renew];
}
