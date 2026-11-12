import type { ConversationId, EventName, EventPayload } from "@repo/core";
import {
  alerts,
  and,
  type BusinessTenant,
  eq,
  escalations,
  inArray,
  lt,
  scheduledJobs,
  sql,
  takeoverLocks,
  isNull,
} from "@repo/db";
import {
  type AnyJobEvent,
  defineCronJob,
  defineEventJob,
  type EventJobDefinition,
  type JobDefinition,
  jobEvent,
  type StepTools,
} from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import { deliverAlert } from "./alerts/deliver";
import { alertSendTime, planLeadAlerts } from "./alerts/plan";
import type { AlertKind } from "./alerts/render";
import { clockOf, type HandoffDeps } from "./deps";
import {
  escalationStartedEvent,
  finishChain,
  loadEscalation,
  runChainStep,
  startEscalation,
} from "./emergency/escalation";
import { planSteps } from "./emergency/policy";
import { loadConversationFacts } from "./facts";
import {
  FollowUpPayload,
  followUpBlocker,
  followUpPlannedEvent,
  followUpSendTime,
} from "./follow-ups/plan";
import { OPTED_OUT_NOTICE } from "./opt-out";
import { emergencyReadiness } from "./readiness";
import { activeLock, releaseTakeover, takeoverStartedEvent } from "./takeover/locks";

/*
 * The durable functions of handoff (ARCHITECTURE §4), all written against the step tools so
 * a retried or resumed run repeats nothing that happened: every side effect checks stored
 * state (alert rows by dedupe key, the escalation's status, the follow-up row, the lock).
 */

export const HANDOFF_FUNCTION_IDS = {
  alertQualified: "handoff-alert-qualified",
  alertMeetingRequested: "handoff-alert-meeting-requested",
  alertHandoff: "handoff-alert-handoff",
  alertDisqualified: "handoff-alert-disqualified",
  alertSendFailed: "handoff-alert-send-failed",
  alertAttention: "handoff-alert-attention",
  emergencyStart: "handoff-emergency-start",
  emergencyChain: "handoff-emergency-chain",
  takeoverRelease: "handoff-takeover-release",
  followUp: "handoff-follow-up",
  sweep: "handoff-sweep",
} as const;

/** Retries of one alert delivery, and the pause before each (30 s, 60 s). */
const ALERT_ATTEMPTS = 3;
const ALERT_PAUSE_MS = 30_000;
/** Wakes of the idle-release loop before it hands over to the sweeper. */
const MAX_RELEASE_WAKES = 200;
/** In front of the alert to the recipients when nobody in the chain acknowledged. */
const EXHAUSTED_NOTICE = "NOBODY ACKNOWLEDGED THIS EMERGENCY. Call the customer now.";
/** In front of the emergency alert when the business has nobody in its escalation chain. */
const NO_CHAIN_NOTICE =
  "NOBODY IS SET UP TO BE CALLED FOR EMERGENCIES. Call the customer now, and add escalation contacts.";
/** Times a due follow-up may be moved (quiet hours, then business hours). */
const MAX_FOLLOW_UP_MOVES = 6;

export interface HandoffJobOptions {
  /** The sweeper treats a chain, plan or lock as lost after this long past its time. */
  readonly sweepGraceMinutes?: number;
}

export function createHandoffJobs(
  deps: HandoffDeps,
  options: HandoffJobOptions = {},
): JobDefinition[] {
  const clock = clockOf(deps);
  const log = deps.logger.child({ component: "handoff-jobs" });
  const grace = (options.sweepGraceMinutes ?? 5) * 60_000;

  /** Sends planned alert rows one by one; a failure is recorded and the next one goes on. */
  async function deliverAll(
    step: StepTools,
    tenant: BusinessTenant,
    ids: readonly string[],
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const id of ids) {
      for (let attempt = 0; attempt < ALERT_ATTEMPTS; attempt += 1) {
        const outcome = await step.run(`send-${id}-${attempt}`, () =>
          deliverAlert(deps, tenant, id, { maxAttempts: ALERT_ATTEMPTS }),
        );
        if (outcome.status === "retry") {
          await step.sleep(`pause-${id}-${attempt}`, ALERT_PAUSE_MS * (attempt + 1));
          continue;
        }
        if (outcome.status === "sent") sent += 1;
        if (outcome.status === "failed") failed += 1;
        break;
      }
    }
    return { sent, failed };
  }

  type LeadEventName =
    "lead.qualified" | "lead.meeting_requested" | "lead.handoff" | "lead.disqualified";

  function leadAlertJob<TName extends LeadEventName>(
    id: string,
    name: string,
    trigger: TName,
    decide: (data: EventPayload<TName>) => { kind: AlertKind; dedupeBase: string } | null,
  ): EventJobDefinition<TName> {
    return defineEventJob({
      id,
      name,
      trigger: { event: trigger },
      retries: 3,
      async handler({ event, step }) {
        const data = event.data as EventPayload<LeadEventName>;
        const decision = decide(event.data);
        if (decision === null) return { alerts: 0 };
        const tenant = { agencyId: data.agencyId, businessId: data.businessId };
        const plan = await step.run("plan", () =>
          deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
            const settings = await loadSettings(ctx, tenant, { logger: log });
            const values = settings.values;
            if (decision.kind === "lead_qualified" && data.score < values["alerts.minimum_score"]) {
              return { ids: [] as string[], sendAt: null };
            }
            const facts = await loadConversationFacts(ctx, data.conversationId);
            if (facts === null) return { ids: [] as string[], sendAt: null };
            const rows = await planLeadAlerts(ctx, {
              kind: decision.kind,
              dedupeBase: decision.dedupeBase,
              conversationId: data.conversationId,
              leadId: data.leadId,
              values,
              facts,
              appUrl: deps.appUrl,
              eventId: data.eventId,
            });
            const now = clock();
            const sendAt = alertSendTime(values, decision.kind, facts.business.timeZone, now);
            return {
              ids: rows.map((row) => row.id),
              sendAt: sendAt.getTime() > now.getTime() ? sendAt.toISOString() : null,
            };
          }),
        );
        if (plan.ids.length === 0) return { alerts: 0 };
        if (plan.sendAt !== null) await step.sleepUntil("hold", new Date(plan.sendAt));
        return deliverAll(step, tenant, plan.ids);
      },
    });
  }

  const alertQualified = leadAlertJob(
    HANDOFF_FUNCTION_IDS.alertQualified,
    "Handoff: alert a qualified lead",
    "lead.qualified",
    (data) => ({ kind: "lead_qualified", dedupeBase: `decision:${data.leadId}` }),
  );
  const alertMeeting = leadAlertJob(
    HANDOFF_FUNCTION_IDS.alertMeetingRequested,
    "Handoff: alert a meeting request",
    "lead.meeting_requested",
    (data) => ({ kind: "meeting_requested", dedupeBase: `decision:${data.leadId}` }),
  );
  const alertHandoff = leadAlertJob(
    HANDOFF_FUNCTION_IDS.alertHandoff,
    "Handoff: alert a handoff",
    "lead.handoff",
    (data) => ({
      kind: "handoff",
      // "We'll contact you" is the lead's decision; a person asked for, or a refusal, is its own.
      dedupeBase:
        data.trigger === "routing" ? `decision:${data.leadId}` : `handoff:${data.eventId}`,
    }),
  );
  const alertDisqualified = leadAlertJob(
    HANDOFF_FUNCTION_IDS.alertDisqualified,
    "Handoff: alert a disqualified lead",
    "lead.disqualified",
    (data) => ({ kind: "lead_disqualified", dedupeBase: `disqualified:${data.leadId}` }),
  );

  const alertSendFailed = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.alertSendFailed,
    name: "Handoff: alert a message that could not be delivered",
    trigger: { event: "message.send_failed" },
    retries: 3,
    async handler({ event, step }) {
      const data = event.data;
      const tenant = { agencyId: data.agencyId, businessId: data.businessId };
      const plan = await step.run("plan", () =>
        deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
          const settings = await loadSettings(ctx, tenant, { logger: log });
          const facts = await loadConversationFacts(ctx, data.conversationId);
          if (facts === null) return [] as string[];
          const rows = await planLeadAlerts(ctx, {
            kind: "send_failed",
            dedupeBase: `send_failed:${data.messageId}`,
            conversationId: data.conversationId,
            leadId: facts.lead?.id ?? null,
            values: settings.values,
            facts,
            appUrl: deps.appUrl,
            errorCode: data.errorCode,
            eventId: event.id ?? data.messageId,
          });
          return rows.map((row) => row.id);
        }),
      );
      return deliverAll(step, tenant, plan);
    },
  });

  /**
   * `handoff.attention_needed`: a conversation needs a person although nobody handed it over
   * (an opted-out customer wrote and the bot did not answer). Alerts the recipients of
   * "handoff" alerts, with the reason in front; the in-app alert was written with the event.
   */
  const alertAttention = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.alertAttention,
    name: "Handoff: alert a conversation that needs a person",
    trigger: { event: "handoff.attention_needed" },
    retries: 3,
    async handler({ event, step }) {
      const data = event.data;
      const tenant = { agencyId: data.agencyId, businessId: data.businessId };
      const plan = await step.run("plan", () =>
        deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
          const settings = await loadSettings(ctx, tenant, { logger: log });
          const facts = await loadConversationFacts(ctx, data.conversationId);
          if (facts === null) return [] as string[];
          const rows = await planLeadAlerts(ctx, {
            kind: "handoff",
            dedupeBase: `attention:${data.reason}:${data.conversationId}:${data.day}`,
            conversationId: data.conversationId,
            leadId: facts.lead?.id ?? null,
            values: settings.values,
            facts,
            appUrl: deps.appUrl,
            eventId: event.id ?? `${data.reason}:${data.conversationId}:${data.day}`,
            notice: OPTED_OUT_NOTICE,
          });
          return rows.map((row) => row.id);
        }),
      );
      return deliverAll(step, tenant, plan);
    },
  });

  /**
   * `lead.emergency`: makes sure the conversation's chain runs (the action normally started
   * it already; this covers a turn whose handler could not), and alerts the recipients who
   * want emergency alerts.
   */
  const emergencyStart = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.emergencyStart,
    name: "Handoff: start the emergency chain and alert recipients",
    trigger: { event: "lead.emergency" },
    retries: 4,
    async handler({ event, step }) {
      const data = event.data;
      const tenant = { agencyId: data.agencyId, businessId: data.businessId };
      const plan = await step.run("start", () =>
        deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
          const settings = await loadSettings(ctx, tenant, { logger: log });
          const started = await startEscalation(ctx, {
            conversationId: data.conversationId,
            emergencyClass: data.emergencyClass,
            summary: null,
            traceId: data.traceId,
            values: settings.values,
            now: clock(),
          });
          const facts = await loadConversationFacts(ctx, data.conversationId);
          const rows =
            facts === null
              ? []
              : await planLeadAlerts(ctx, {
                  kind: "emergency",
                  dedupeBase: `emergency:${data.eventId}`,
                  conversationId: data.conversationId,
                  leadId: data.leadId,
                  values: settings.values,
                  facts,
                  appUrl: deps.appUrl,
                  eventId: data.eventId,
                  ...(started !== null && started.contacts === 0
                    ? { notice: NO_CHAIN_NOTICE }
                    : {}),
                });
          if (started !== null && started.contacts === 0) {
            log.error("emergency.no_contacts", {
              businessId: data.businessId,
              escalationId: started.escalationId,
            });
          }
          return {
            escalationId: started?.status === "active" ? started.escalationId : null,
            ids: rows.map((row) => row.id),
          };
        }),
      );
      if (plan.escalationId !== null && deps.events !== null) {
        const escalationId = plan.escalationId;
        await step.run("emit", async () => {
          await deps.events?.send([escalationStartedEvent(tenant, escalationId, data.traceId)]);
          return null;
        });
      }
      return deliverAll(step, tenant, plan.ids);
    },
  });

  /** The escalation chain: alert, wait, call, next person; stops at the acknowledgement. */
  const emergencyChain = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.emergencyChain,
    name: "Handoff: emergency escalation chain",
    trigger: { event: "handoff.escalation_started" },
    concurrency: { key: "event.data.escalationId", limit: 1 },
    retries: 6,
    async handler({ event, step }) {
      const { agencyId, businessId, escalationId } = event.data;
      const tenant = { agencyId, businessId };
      const loaded = await step.run("load", () =>
        deps.db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
          const escalation = await loadEscalation(ctx, escalationId);
          if (escalation?.status !== "active") return { steps: -1 };
          return { steps: planSteps(escalation.chain, escalation.policy).length };
        }),
      );
      if (loaded.steps < 0) return { outcome: "not_active" };
      for (let index = 0; index < loaded.steps; index += 1) {
        const result = await step.run(`step-${index}`, () =>
          runChainStep(deps, tenant, escalationId, index),
        );
        if (!result.active) return { outcome: "stopped", step: index };
        if (result.waitUntil !== null) {
          await step.sleepUntil(`wait-${index}`, new Date(result.waitUntil));
        }
      }
      const exhausted = await step.run("finish", () => finishChain(deps, tenant, escalationId));
      if (!exhausted) return { outcome: "stopped" };
      // Nobody answered: loud everywhere it can be. The critical in-app alert is written by
      // `finishChain`; the alert recipients who get emergency alerts hear it by their own
      // channels too, and the error log reaches the operators (C17).
      log.error("emergency.chain_exhausted", { businessId, escalationId });
      const ids = await step.run("exhausted-alerts", () =>
        deps.db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
          const escalation = await loadEscalation(ctx, escalationId);
          if (escalation?.conversationId == null) return [] as string[];
          const settings = await loadSettings(ctx, tenant, { logger: log });
          const facts = await loadConversationFacts(ctx, escalation.conversationId);
          if (facts === null) return [] as string[];
          const rows = await planLeadAlerts(ctx, {
            kind: "emergency",
            dedupeBase: `emergency_exhausted:${escalationId}`,
            conversationId: escalation.conversationId,
            leadId: escalation.leadId,
            values: settings.values,
            facts,
            appUrl: deps.appUrl,
            eventId: `emergency_exhausted:${escalationId}`,
            notice: EXHAUSTED_NOTICE,
          });
          return rows.map((row) => row.id);
        }),
      );
      await deliverAll(step, tenant, ids);
      return { outcome: "exhausted" };
    },
    async onFailure({ event, error }) {
      // The sweeper resumes the chain; make sure a person also sees that it stumbled.
      const { agencyId, businessId, escalationId } = event.data;
      log.error("emergency.chain_failed", { businessId, escalationId, error: error.message });
      await deps.db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
        const [row] = await ctx.tx
          .select({
            conversationId: escalations.conversationId,
            leadId: escalations.leadId,
            status: escalations.status,
          })
          .from(escalations)
          .where(eq(escalations.id, escalationId))
          .limit(1);
        if (row?.status !== "active") return;
        await ctx.tx
          .insert(alerts)
          .values({
            ...ctx.tenant,
            conversationId: row.conversationId,
            leadId: row.leadId,
            escalationId,
            kind: "emergency_chain_failed",
            severity: "critical",
            channel: "in_app",
            recipient: "agency",
            subject:
              "An emergency's escalation chain stopped with an error: call the customer now. The chain is retried every few minutes.",
            payload: { escalationId },
            dedupeKey: `emergency_chain_failed:${escalationId}`,
          })
          .onConflictDoNothing();
      });
    },
  });

  /** Gives the conversation back to the bot once nobody wrote for the idle time. */
  const takeoverRelease = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.takeoverRelease,
    name: "Handoff: release an idle takeover",
    trigger: { event: "conversation.takeover_started" },
    concurrency: { key: "event.data.conversationId", limit: 1 },
    retries: 4,
    async handler({ event, step }) {
      const data = event.data;
      const tenant = { agencyId: data.agencyId, businessId: data.businessId };
      for (let wake = 0; wake < MAX_RELEASE_WAKES; wake += 1) {
        const verdict = await step.run(`check-${wake}`, () =>
          deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
            const lock = await activeLock(ctx, data.conversationId);
            if (lock === null) return { kind: "done" as const, reason: "released" };
            const settings = await loadSettings(ctx, tenant, { logger: log });
            const idle = settings.values["handoff.auto_release_minutes"];
            if (idle === null) return { kind: "done" as const, reason: "manual_only" };
            const releaseAt = lock.lastActivityAt.getTime() + idle * 60_000;
            const now = clock();
            if (now.getTime() < releaseAt) {
              return { kind: "wait" as const, until: new Date(releaseAt).toISOString() };
            }
            const released = await releaseTakeover(ctx, {
              conversationId: data.conversationId,
              reason: "idle_timeout",
              userId: null,
              traceId: data.traceId,
              now,
              values: settings.values,
              expect: { lockId: lock.id, lastActivityAt: lock.lastActivityAt },
            });
            if (released === null) return { kind: "wait" as const, until: now.toISOString() };
            return { kind: "released" as const, events: released.events };
          }),
        );
        if (verdict.kind === "done") return { outcome: verdict.reason };
        if (verdict.kind === "released") {
          if (deps.events !== null && verdict.events.length > 0) {
            await step.run("announce", async () => {
              await deps.events?.send(verdict.events);
              return null;
            });
          }
          return { outcome: "released" };
        }
        await step.sleepUntil(`idle-${wake}`, new Date(verdict.until));
      }
      return { outcome: "still_held" };
    },
  });

  /** One follow-up: sleeps until due, checks everything again, then asks for the turn. */
  const followUp = defineEventJob({
    id: HANDOFF_FUNCTION_IDS.followUp,
    name: "Handoff: follow up with a quiet customer",
    trigger: { event: "handoff.follow_up_planned" },
    concurrency: { key: "event.data.followUpId", limit: 1 },
    retries: 4,
    async handler({ event, step }) {
      const data = event.data;
      const tenant = { agencyId: data.agencyId, businessId: data.businessId };
      const scope = () => deps.db.forBusiness(data.businessId, { agencyId: data.agencyId });
      const first = await step.run("load", () =>
        scope().run(async (ctx) => {
          const [row] = await ctx.tx
            .select({ status: scheduledJobs.status, runAt: scheduledJobs.runAt })
            .from(scheduledJobs)
            .where(and(eq(scheduledJobs.id, data.followUpId), eq(scheduledJobs.kind, "follow_up")))
            .limit(1);
          return row === undefined || (row.status !== "scheduled" && row.status !== "running")
            ? null
            : row.runAt.toISOString();
        }),
      );
      if (first === null) return { outcome: "not_scheduled" };
      let due = first;
      for (let move = 0; move <= MAX_FOLLOW_UP_MOVES; move += 1) {
        await step.sleepUntil(`due-${move}`, new Date(due));
        const verdict = await step.run(`check-${move}`, () =>
          scope().run(async (ctx) => {
            const [row] = await ctx.tx
              .select({
                status: scheduledJobs.status,
                runAt: scheduledJobs.runAt,
                payload: scheduledJobs.payload,
              })
              .from(scheduledJobs)
              .where(eq(scheduledJobs.id, data.followUpId))
              .for("update")
              .limit(1);
            if (row?.status !== "scheduled") {
              return { kind: "stop" as const, reason: row?.status ?? "missing" };
            }
            const payload = FollowUpPayload.parse(row.payload);
            const now = clock();
            const cancel = async (reason: string) => {
              await ctx.tx
                .update(scheduledJobs)
                .set({ status: "cancelled", cancelledAt: now, cancelReason: reason })
                .where(eq(scheduledJobs.id, data.followUpId));
              return { kind: "stop" as const, reason };
            };
            // Moved later (a newer due time) by an earlier check: wait for it.
            if (row.runAt.getTime() > now.getTime() + 1000) {
              return { kind: "wait" as const, until: row.runAt.toISOString() };
            }
            const settings = await loadSettings(ctx, tenant, { logger: log });
            const facts = await loadConversationFacts(ctx, data.conversationId);
            if (facts === null) return cancel("conversation_missing");
            const blocker = await followUpBlocker(ctx, {
              facts,
              values: settings.values,
              nudge: payload.nudge,
              inboundSeq: payload.inboundSeq,
            });
            if (blocker !== null) return cancel(blocker);
            const at = followUpSendTime({ due: now, facts, values: settings.values });
            if (at === null) return cancel("no_allowed_time");
            if (at.getTime() > now.getTime() + 60_000) {
              await ctx.tx
                .update(scheduledJobs)
                .set({ runAt: at })
                .where(eq(scheduledJobs.id, data.followUpId));
              return { kind: "wait" as const, until: at.toISOString() };
            }
            await ctx.tx
              .update(scheduledJobs)
              .set({
                status: "running",
                attempts: sql`${scheduledJobs.attempts} + 1`,
                payload: { ...row.payload, requestedAt: now.toISOString() },
              })
              .where(eq(scheduledJobs.id, data.followUpId));
            return { kind: "request" as const };
          }),
        );
        if (verdict.kind === "stop") return { outcome: verdict.reason };
        if (verdict.kind === "wait") {
          due = verdict.until;
          continue;
        }
        await step.run("request", async () => {
          await requestFollowUpTurn(data.followUpId, data);
          return null;
        });
        return { outcome: "requested" };
      }
      return { outcome: "gave_up" };
    },
  });

  /** Asks the pipeline for the follow-up turn and marks the plan done. */
  async function requestFollowUpTurn(
    followUpId: string,
    data: BusinessTenant & { readonly traceId: string; readonly conversationId: ConversationId },
  ): Promise<void> {
    if (deps.events !== null) {
      await deps.events.send([
        jobEvent("conversation.turn_requested", `turn-follow-up-${followUpId}`, {
          traceId: data.traceId as EventPayload<"conversation.turn_requested">["traceId"],
          agencyId: data.agencyId,
          businessId: data.businessId,
          conversationId: data.conversationId,
          trigger: "follow_up",
          requestId: `follow-up-${followUpId}`,
        }),
      ]);
    }
    await deps.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
      await ctx.tx
        .update(scheduledJobs)
        .set({ status: "done", completedAt: clock() })
        .where(and(eq(scheduledJobs.id, followUpId), eq(scheduledJobs.status, "running")));
    });
  }

  /**
   * Every five minutes: what a lost event or a lost run left behind. An active chain whose
   * next action is overdue is resumed (it repeats nothing it did); a follow-up still waiting
   * long after its time is woken; one whose turn was asked for but not marked done is asked
   * for again (the event id makes that harmless); an idle takeover past its release time is
   * handed to the release job again.
   */
  const sweep = defineCronJob({
    id: HANDOFF_FUNCTION_IDS.sweep,
    name: "Handoff: resume lost chains, follow-ups and releases",
    trigger: { cron: "*/5 * * * *" },
    retries: 2,
    async handler({ step }) {
      const businesses = await step.run("businesses", () =>
        deps.db.directory.listBusinesses({ statuses: ["active", "onboarding", "paused"] }),
      );
      let emitted = 0;
      for (const business of businesses) {
        const found = await step.run(`sweep-${business.businessId}`, () =>
          deps.db
            .forBusiness(business.businessId, { agencyId: business.agencyId })
            .run(async (ctx) => {
              const now = clock();
              const minute = Math.floor(now.getTime() / 60_000);
              const overdue = new Date(now.getTime() - grace);
              const out: AnyJobEvent[] = [];
              const chains = await ctx.tx
                .select({ id: escalations.id, traceId: escalations.traceId })
                .from(escalations)
                .where(and(eq(escalations.status, "active"), lt(escalations.nextActionAt, overdue)))
                .limit(50);
              for (const chain of chains) {
                out.push(
                  escalationStartedEvent(
                    ctx.tenant,
                    chain.id,
                    chain.traceId ?? crypto.randomUUID(),
                    `-resume-${minute}`,
                  ),
                );
              }
              const plans = await ctx.tx
                .select({
                  id: scheduledJobs.id,
                  status: scheduledJobs.status,
                  conversationId: scheduledJobs.conversationId,
                  payload: scheduledJobs.payload,
                })
                .from(scheduledJobs)
                .where(
                  and(
                    eq(scheduledJobs.kind, "follow_up"),
                    inArray(scheduledJobs.status, ["scheduled", "running"]),
                    lt(scheduledJobs.runAt, overdue),
                  ),
                )
                .limit(100);
              for (const plan of plans) {
                if (plan.conversationId === null) continue;
                const payload = FollowUpPayload.safeParse(plan.payload);
                const traceId = payload.success ? payload.data.traceId : crypto.randomUUID();
                if (plan.status === "scheduled") {
                  out.push(
                    followUpPlannedEvent(
                      ctx,
                      { conversationId: plan.conversationId, followUpId: plan.id, traceId },
                      `-sweep-${minute}`,
                    ),
                  );
                } else if (
                  payload.success &&
                  payload.data.requestedAt !== undefined &&
                  Date.parse(payload.data.requestedAt) < overdue.getTime()
                ) {
                  // Asked for, never confirmed: ask again (same event id) and close it.
                  out.push(
                    jobEvent("conversation.turn_requested", `turn-follow-up-${plan.id}`, {
                      traceId: traceId as EventPayload<"conversation.turn_requested">["traceId"],
                      agencyId: ctx.tenant.agencyId,
                      businessId: ctx.tenant.businessId,
                      conversationId: plan.conversationId,
                      trigger: "follow_up",
                      requestId: `follow-up-${plan.id}`,
                    }),
                  );
                  await ctx.tx
                    .update(scheduledJobs)
                    .set({ status: "done", completedAt: now })
                    .where(eq(scheduledJobs.id, plan.id));
                }
              }
              const settings = await loadSettings(ctx, ctx.tenant, { logger: log });
              // An active business whose emergencies would reach nobody (both chains start
              // empty; no Twilio): a critical note in the admin panel, once a day.
              const readiness = emergencyReadiness(settings.values, deps.transports);
              if (business.status === "active" && readiness.enabled && !readiness.ready) {
                await ctx.tx
                  .insert(alerts)
                  .values({
                    ...ctx.tenant,
                    kind: "emergency_not_ready",
                    severity: "critical",
                    channel: "in_app",
                    recipient: "agency",
                    subject:
                      "Emergencies at this business reach nobody by phone: add escalation contacts (and set up Twilio).",
                    payload: { problems: [...readiness.problems] },
                    dedupeKey: `emergency_not_ready:${now.toISOString().slice(0, 10)}`,
                  })
                  .onConflictDoNothing();
              }
              const idle = settings.values["handoff.auto_release_minutes"];
              if (idle !== null) {
                const locks = await ctx.tx
                  .select({
                    id: takeoverLocks.id,
                    conversationId: takeoverLocks.conversationId,
                    userId: takeoverLocks.userId,
                    source: takeoverLocks.source,
                  })
                  .from(takeoverLocks)
                  .where(
                    and(
                      isNull(takeoverLocks.releasedAt),
                      lt(
                        takeoverLocks.lastActivityAt,
                        new Date(now.getTime() - idle * 60_000 - grace),
                      ),
                    ),
                  )
                  .limit(50);
                for (const lock of locks) {
                  const event = takeoverStartedEvent(ctx.tenant, {
                    lockId: lock.id,
                    conversationId: lock.conversationId,
                    traceId: crypto.randomUUID(),
                    userId: lock.userId,
                    source: lock.source,
                  });
                  out.push({ ...event, id: `${event.id}-sweep-${minute}` });
                }
              }
              return out;
            }),
        );
        if (found.length > 0 && deps.events !== null) {
          await step.run(`emit-${business.businessId}`, async () => {
            await deps.events?.send(found);
            return found.length;
          });
          emitted += found.length;
        }
      }
      return { emitted };
    },
  });

  return [
    alertQualified,
    alertMeeting,
    alertHandoff,
    alertDisqualified,
    alertSendFailed,
    alertAttention,
    emergencyStart,
    emergencyChain,
    takeoverRelease,
    followUp,
    sweep,
  ] as JobDefinition[];
}

/** The ids of the events handoff's jobs listen to, for tests and the docs. */
export const HANDOFF_TRIGGERS: readonly EventName[] = [
  "lead.qualified",
  "lead.meeting_requested",
  "lead.handoff",
  "lead.disqualified",
  "lead.emergency",
  "message.send_failed",
  "handoff.attention_needed",
  "handoff.escalation_started",
  "conversation.takeover_started",
  "handoff.follow_up_planned",
];
