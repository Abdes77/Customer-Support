import {
  type ContactId,
  type ConversationId,
  NotFoundError,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  alerts,
  and,
  businesses,
  type BusinessTenant,
  contacts,
  conversations,
  desc,
  eq,
  escalations,
  inArray,
  scheduledJobs,
} from "@repo/db";
import type { AnyJobEvent } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import { deliverAlert } from "./alerts/deliver";
import type { AlertRecipient } from "./alerts/plan";
import { clockOf, type HandoffDeps } from "./deps";
import { type AckResult } from "./emergency/escalation";
import { acknowledgeByUser } from "./emergency/ack";
import { cancelFollowUps } from "./follow-ups/plan";
import { liftOptOut, recordOptOut } from "./opt-out";
import { type EmergencyReadiness, emergencyReadiness } from "./readiness";
import { plainLine } from "./text";
import { activeLock, releaseTakeover, startTakeover, touchTakeover } from "./takeover/locks";

/*
 * What the admin panel (C15, C16) calls for handoff. Every function acts in the business's
 * system scope; the app checks the signed-in person's role for that business first
 * (`requireAccess()`, then `requireBusinessRole()`), as for every write a user may not make
 * directly (ARCHITECTURE §3). Nothing returned holds a secret; alert contacts themselves are
 * settings (`alerts.recipients`, `emergency.escalation_chain`), edited on the settings screen.
 */

export interface TakeoverView {
  readonly active: boolean;
  readonly lockId: string | null;
  readonly source: string | null;
  readonly userId: string | null;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  /** When the bot takes the conversation back by itself, if nobody writes before then. */
  readonly releasesAt: string | null;
}

export interface EscalationView {
  readonly id: string;
  readonly conversationId: string | null;
  readonly emergencyClass: string;
  readonly status: string;
  readonly currentStep: number;
  readonly startedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedVia: string | null;
  /** Every alert of the chain: to whom (name only), how, and what happened. */
  readonly alerts: readonly {
    readonly id: string;
    readonly channel: string;
    readonly contactName: string | null;
    readonly status: string;
    readonly sentAt: string | null;
    readonly error: string | null;
  }[];
}

export interface FollowUpView {
  readonly id: string;
  readonly status: string;
  readonly runAt: string;
  readonly reason: string | null;
  readonly nudge: number | null;
  readonly cancelReason: string | null;
}

export function createHandoffService(deps: HandoffDeps) {
  const clock = clockOf(deps);
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });
  const emit = async (events: readonly AnyJobEvent[]) => {
    if (events.length > 0 && deps.events !== null) await deps.events.send(events);
  };
  const traceId = () => crypto.randomUUID();

  async function requireConversation(
    tenant: BusinessTenant,
    conversationId: ConversationId,
  ): Promise<void> {
    const found = await scope(tenant).run(async (ctx) => {
      const [row] = await ctx.tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return row !== undefined;
    });
    if (!found) throw new NotFoundError("The conversation was not found.");
  }

  return {
    /** Whether a person holds the conversation, and when the bot would take it back. */
    async takeoverState(
      tenant: BusinessTenant,
      conversationId: ConversationId,
    ): Promise<TakeoverView> {
      return scope(tenant).run(async (ctx) => {
        const lock = await activeLock(ctx, conversationId);
        if (lock === null) {
          return {
            active: false,
            lockId: null,
            source: null,
            userId: null,
            reason: null,
            startedAt: null,
            lastActivityAt: null,
            releasesAt: null,
          };
        }
        const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
        const idle = settings.values["handoff.auto_release_minutes"];
        return {
          active: true,
          lockId: lock.id,
          source: lock.source,
          userId: lock.userId,
          reason: lock.reason,
          startedAt: lock.startedAt.toISOString(),
          lastActivityAt: lock.lastActivityAt.toISOString(),
          releasesAt:
            idle === null
              ? null
              : new Date(lock.lastActivityAt.getTime() + idle * 60_000).toISOString(),
        };
      });
    },

    /**
     * Whether an emergency at this business reaches a person (C15's onboarding wizard and
     * alert contacts page, C17's readiness): both chains start empty, and without Twilio
     * nobody is texted or called. `ready: false` must be shown, not hidden.
     */
    async readiness(tenant: BusinessTenant): Promise<EmergencyReadiness> {
      return scope(tenant).run(async (ctx) => {
        const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
        return emergencyReadiness(settings.values, deps.transports);
      });
    },

    /**
     * A person is writing in the conversation (C16's reply box calls this while they type,
     * every minute or so): the idle release counts from now, so the bot never takes the
     * conversation back in the middle of a reply. Nothing happens without an active takeover.
     */
    async noteActivity(input: {
      readonly tenant: BusinessTenant;
      readonly conversationId: ConversationId;
      readonly userId: UserId;
    }): Promise<{ readonly active: boolean }> {
      return scope(input.tenant).run(async (ctx) => ({
        active: await touchTakeover(ctx, input.conversationId, clock()),
      }));
    },

    /** A person takes the conversation over: the bot stays silent until it is released. */
    async takeOver(input: {
      readonly tenant: BusinessTenant;
      readonly conversationId: ConversationId;
      readonly userId: UserId;
      readonly reason?: string;
    }): Promise<{ readonly started: boolean }> {
      await requireConversation(input.tenant, input.conversationId);
      const result = await scope(input.tenant).run(async (ctx) => {
        const started = await startTakeover(ctx, {
          conversationId: input.conversationId,
          source: "admin_panel",
          userId: input.userId,
          reason: input.reason ?? "Taken over in the admin panel.",
          traceId: traceId(),
          now: clock(),
        });
        if (started !== null) await cancelFollowUps(ctx, input.conversationId, "takeover", clock());
        return started;
      });
      if (result !== null) await emit([result.event]);
      return { started: result !== null };
    },

    /** Gives the conversation back to the bot (and, per settings, lets it check in). */
    async release(input: {
      readonly tenant: BusinessTenant;
      readonly conversationId: ConversationId;
      readonly userId: UserId;
    }): Promise<{ readonly released: boolean }> {
      await requireConversation(input.tenant, input.conversationId);
      const result = await scope(input.tenant).run(async (ctx) => {
        const settings = await loadSettings(ctx, input.tenant, { logger: deps.logger });
        return releaseTakeover(ctx, {
          conversationId: input.conversationId,
          reason: "manual",
          userId: input.userId,
          traceId: traceId(),
          now: clock(),
          values: settings.values,
        });
      });
      if (result !== null) await emit(result.events);
      return { released: result !== null };
    },

    /**
     * A person's reply from the admin panel, sent through the conversation's channel by the
     * pipeline. A reply means the person holds the conversation: a takeover starts if none is
     * active, and the idle time starts again.
     */
    async sendManualReply(input: {
      readonly tenant: BusinessTenant;
      readonly conversationId: ConversationId;
      readonly userId: UserId;
      readonly text: string;
    }): Promise<{ readonly messageId: string }> {
      const text = input.text.trim();
      if (text.length === 0) throw new ValidationError("The reply is empty.");
      if (text.length > 4000)
        throw new ValidationError("The reply is too long (4,000 characters at most).");
      await requireConversation(input.tenant, input.conversationId);
      const id = traceId();
      const result = await scope(input.tenant).run(async (ctx) => {
        const now = clock();
        const started = await startTakeover(ctx, {
          conversationId: input.conversationId,
          source: "admin_panel",
          userId: input.userId,
          reason: "A person replied in the admin panel.",
          traceId: id,
          now,
        });
        if (started === null) await touchTakeover(ctx, input.conversationId, now);
        await cancelFollowUps(ctx, input.conversationId, "takeover", now);
        const queued = await deps.outbound.enqueueHuman(ctx, {
          conversationId: input.conversationId,
          text,
          traceId: id,
          userId: input.userId,
        });
        if (queued === null) throw new NotFoundError("The conversation was not found.");
        return {
          messageId: queued.messageId,
          events: [...(started === null ? [] : [started.event]), ...queued.events],
        };
      });
      await emit(result.events);
      return { messageId: result.messageId };
    },

    /** Opts a contact out of (or back into) every automated message, as a person decided. */
    async setOptOut(input: {
      readonly tenant: BusinessTenant;
      readonly contactId: ContactId;
      readonly optedOut: boolean;
      readonly userId: UserId;
    }): Promise<{ readonly changed: boolean }> {
      return scope(input.tenant).run(async (ctx) => {
        const [contact] = await ctx.tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.id, input.contactId))
          .limit(1);
        if (contact === undefined) throw new NotFoundError("The contact was not found.");
        const now = clock();
        const record = {
          at: now.toISOString(),
          source: "admin_panel" as const,
          channel: null,
          conversationId: null,
          messageId: null,
          keyword: null,
          userId: input.userId,
        };
        const changed = input.optedOut
          ? await recordOptOut(ctx, input.contactId, record, now)
          : await liftOptOut(ctx, input.contactId, record, now);
        return { changed };
      });
    },

    /** The business's emergency escalations, newest first, with each alert's outcome. */
    async listEscalations(
      tenant: BusinessTenant,
      filter: { readonly status?: readonly string[]; readonly limit?: number } = {},
    ): Promise<EscalationView[]> {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select()
          .from(escalations)
          .where(
            filter.status === undefined || filter.status.length === 0
              ? undefined
              : inArray(escalations.status, filter.status as ("active" | "acknowledged")[]),
          )
          .orderBy(desc(escalations.startedAt))
          .limit(Math.min(filter.limit ?? 50, 200));
        const ids = rows.map((row) => row.id);
        const alertRows =
          ids.length === 0
            ? []
            : await ctx.tx
                .select({
                  id: alerts.id,
                  escalationId: alerts.escalationId,
                  channel: alerts.channel,
                  status: alerts.status,
                  sentAt: alerts.sentAt,
                  error: alerts.error,
                  payload: alerts.payload,
                })
                .from(alerts)
                .where(inArray(alerts.escalationId, ids))
                .orderBy(alerts.createdAt);
        return rows.map((row) => ({
          id: row.id,
          conversationId: row.conversationId,
          emergencyClass: row.emergencyClass,
          status: row.status,
          currentStep: row.currentStep,
          startedAt: row.startedAt.toISOString(),
          acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
          acknowledgedBy: row.acknowledgedBy,
          acknowledgedVia: row.acknowledgedVia,
          alerts: alertRows
            .filter((alert) => alert.escalationId === row.id)
            .map((alert) => ({
              id: alert.id,
              channel: alert.channel,
              contactName:
                typeof alert.payload["contactName"] === "string"
                  ? alert.payload["contactName"]
                  : null,
              status: alert.status,
              sentAt: alert.sentAt?.toISOString() ?? null,
              error: alert.error,
            })),
        }));
      });
    },

    /** A signed-in person acknowledges an emergency: the chain stops. */
    acknowledgeEscalation(input: {
      readonly tenant: BusinessTenant;
      readonly escalationId: string;
      readonly userId: UserId;
      /** How the person is named in the record (their name or email). */
      readonly userLabel: string;
    }): Promise<AckResult> {
      return acknowledgeByUser(deps, input);
    },

    /** The conversation's follow-ups, newest first. */
    async listFollowUps(
      tenant: BusinessTenant,
      conversationId: ConversationId,
    ): Promise<FollowUpView[]> {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select()
          .from(scheduledJobs)
          .where(
            and(
              eq(scheduledJobs.conversationId, conversationId),
              eq(scheduledJobs.kind, "follow_up"),
            ),
          )
          .orderBy(desc(scheduledJobs.runAt))
          .limit(50);
        return rows.map((row) => ({
          id: row.id,
          status: row.status,
          runAt: row.runAt.toISOString(),
          reason: typeof row.payload["reason"] === "string" ? row.payload["reason"] : null,
          nudge: typeof row.payload["nudge"] === "number" ? row.payload["nudge"] : null,
          cancelReason: row.cancelReason,
        }));
      });
    },

    /** Stops the conversation's planned follow-ups. */
    async cancelFollowUps(input: {
      readonly tenant: BusinessTenant;
      readonly conversationId: ConversationId;
      readonly userId: UserId;
    }): Promise<{ readonly cancelled: number }> {
      return scope(input.tenant).run(async (ctx) => ({
        cancelled: await cancelFollowUps(ctx, input.conversationId, "cancelled_by_staff", clock()),
      }));
    },

    /**
     * Sends a test alert to one recipient (the contact page's "send a test"): records it like
     * any alert and reports whether each channel took it.
     */
    async sendTestAlert(input: {
      readonly tenant: BusinessTenant;
      readonly recipient: Pick<AlertRecipient, "name" | "email" | "phone" | "channels">;
      readonly userId: UserId;
    }): Promise<{ readonly results: readonly { channel: string; status: string }[] }> {
      const now = clock();
      const ids = await scope(input.tenant).run(async (ctx) => {
        const [found] = await ctx.tx
          .select({ name: businesses.name })
          .from(businesses)
          .where(eq(businesses.id, input.tenant.businessId))
          .limit(1);
        const business = plainLine(found?.name, 80) || "your business";
        const out: { id: string; channel: string }[] = [];
        for (const channel of input.recipient.channels) {
          const to = channel === "email" ? input.recipient.email : input.recipient.phone;
          if (to.trim().length === 0) continue;
          const [row] = await ctx.tx
            .insert(alerts)
            .values({
              ...ctx.tenant,
              kind: "test",
              severity: "info",
              channel,
              recipient: to.trim(),
              subject: channel === "email" ? "Test alert" : null,
              body: `Test alert from ${business}: alerts reach you by ${channel}.`,
              payload: { recipientName: input.recipient.name, test: true, userId: input.userId },
              dedupeKey: `test:${input.userId}:${channel}:${now.getTime()}`,
            })
            .returning({ id: alerts.id });
          if (row !== undefined) out.push({ id: row.id, channel });
        }
        return out;
      });
      const results = [];
      for (const item of ids) {
        const outcome = await deliverAlert(deps, input.tenant, item.id, { maxAttempts: 1 });
        results.push({ channel: item.channel, status: outcome.status });
      }
      return { results };
    },
  };
}

export type HandoffService = ReturnType<typeof createHandoffService>;
