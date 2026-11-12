import type {
  ActionHandler,
  ActionOutcome,
  ChannelId,
  ContactId,
  ConversationId,
  ExecutedAction,
  MessageId,
  TurnTrigger,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  contacts,
  conversations,
  conversationTurns,
  eq,
  gt,
  inArray,
  messages,
  ne,
  sql,
} from "@repo/db";
import type { AnyJobEvent } from "@repo/jobs";
import { type AppResolvedSettings, type AppSettings, channelSetting } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { clockOf, type HandoffDomainDeps } from "./deps";
import { escalationStartedEvent, startEscalation } from "./emergency/escalation";
import { loadConversationFacts } from "./facts";
import {
  botRoundsSinceCustomer,
  cancelFollowUps,
  followUpBlocker,
  lastInboundSeq,
  nudgeDelayMinutes,
  planFollowUp,
} from "./follow-ups/plan";
import {
  applyKeywords,
  cancelFollowUpsOfContact,
  matchKeyword,
  optOutRestriction,
  pendingCustomerMessages,
  hasRecentEmergency,
  surfaceOptedOutMessage,
} from "./opt-out";
import { startTakeover, touchTakeover } from "./takeover/locks";
import { customerTimeZone, parseIsoDuration, quietHoursEnd } from "./time";

/*
 * The domain parts handoff registers in the pipeline's composition (packages/pipeline/src/
 * composition): three action handlers, a turn observer, an inbound observer, a turn guard and
 * a send gate. The interfaces are the pipeline's, restated here structurally because a domain
 * package does not import the pipeline (ARCHITECTURE §6).
 */

const done = (executed: ExecutedAction) =>
  executed.outcome.status === "applied" || executed.outcome.status === "deferred";

// ---------------------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------------------

/**
 * `escalate_emergency`: records the emergency and starts the chain, at once, in the generate
 * step: the life-safety instructions the reply starts with never wait for it (the engine
 * writes them from the settings whatever this returns). In a dry run only the settings'
 * verdict. When it cannot be stored now the action is accepted as deferred: lead scoring
 * sends `lead.emergency` at commit and `handoff-emergency-start` starts the chain from it.
 */
export function escalateEmergencyHandler(
  deps: HandoffDomainDeps,
): ActionHandler<"escalate_emergency"> {
  const clock = clockOf(deps);
  return {
    type: "escalate_emergency",
    async handle(action, context): Promise<ActionOutcome> {
      const values = context.settings.values as AppSettings;
      if (!values["emergency.enabled"]) {
        return {
          status: "rejected",
          message:
            "Emergency alerts are switched off for this business. Nobody has been alerted; do not say anyone has.",
          data: { alerted: false },
        };
      }
      const conversationId = context.trace.conversationId;
      if (context.mode === "dry_run" || conversationId === null) {
        return {
          status: "applied",
          message: "The business's on-call contacts are being alerted.",
          data: { alerted: true },
        };
      }
      try {
        const started = await deps.db
          .forBusiness(context.trace.businessId, { agencyId: context.trace.agencyId })
          .run(async (ctx) => {
            const result = await startEscalation(ctx, {
              conversationId,
              emergencyClass: action.emergencyClass,
              summary: action.summary,
              traceId: context.trace.traceId,
              values,
              now: clock(),
            });
            return result;
          });
        if (started === null) {
          return { status: "rejected", message: "Emergency alerts are switched off.", data: null };
        }
        if (started.status === "active" && deps.events !== null) {
          try {
            await deps.events.send([
              escalationStartedEvent(context.trace, started.escalationId, context.trace.traceId),
            ]);
          } catch (error) {
            // The escalation is stored; `lead.emergency` and the sweeper start the chain.
            deps.logger.error("emergency.start_event_failed", {
              businessId: context.trace.businessId,
              escalationId: started.escalationId,
              error: error instanceof Error ? error.name : "Error",
            });
          }
        }
        if (started.status === "acknowledged") {
          return {
            status: "applied",
            message: "Someone at the business already acknowledged this emergency and is on it.",
            data: { alerted: true, acknowledged: true },
          };
        }
        // Recorded either way, so the lead, its report and the alert recipients hear of it
        // (`lead.emergency`); with nobody in the chain the agency is flagged in the panel.
        return {
          status: "applied",
          message:
            started.contacts === 0
              ? "The emergency is recorded and flagged to the team; no on-call contacts are set up to be called, so do not promise a call back beyond the emergency rules."
              : "The business's on-call contacts are being alerted.",
          data: { alerted: started.contacts > 0 },
        };
      } catch (error) {
        deps.logger.error("emergency.start_failed", {
          businessId: context.trace.businessId,
          error: error instanceof Error ? error.name : "Error",
        });
        // Accepted for a durable step: `lead.emergency` (sent when the turn commits) starts
        // the chain from `handoff-emergency-start`.
        return {
          status: "deferred",
          message: "The business's on-call contacts are being alerted.",
          data: { alerted: true },
        };
      }
    },
  };
}

/**
 * `handoff_to_human`: accepted; the takeover itself starts when the turn commits (the turn
 * observer), so the bot's own handoff message ("a member of the team will pick up here")
 * still goes out and everything after it waits for the person.
 */
export function handoffToHumanHandler(): ActionHandler<"handoff_to_human"> {
  return {
    type: "handoff_to_human",
    handle() {
      return Promise.resolve({
        status: "applied",
        message: "A person takes over after this reply.",
        data: { handedOff: true },
      });
    },
  };
}

/** The longest wait a scheduled check-in may have: a month. */
const MAX_CHECK_IN_MS = 31 * 86_400_000;

/**
 * `schedule_follow_up`: a check-in when the customer asked for time ("let me talk to my wife,
 * I'll get back to you tomorrow"), or the after-hours answer at the next opening. It replaces
 * the conversation's planned nudges; the customer's next message cancels it.
 */
export function scheduleFollowUpHandler(
  deps: HandoffDomainDeps,
): ActionHandler<"schedule_follow_up"> {
  const clock = clockOf(deps);
  return {
    type: "schedule_follow_up",
    async handle(action, context): Promise<ActionOutcome> {
      const values = context.settings.values as AppSettings;
      const wait = parseIsoDuration(action.after);
      if (wait === null) {
        return {
          status: "rejected",
          message: "The wait must be an ISO 8601 duration such as PT2H or P1D.",
          data: null,
        };
      }
      if (!values["follow_up.enabled"]) {
        return {
          status: "rejected",
          message: "Follow-ups are switched off for this business. Do not promise to check in.",
          data: null,
        };
      }
      const conversationId = context.trace.conversationId;
      if (context.mode === "dry_run" || conversationId === null) {
        return { status: "deferred", message: "The follow-up is scheduled.", data: null };
      }
      const now = clock();
      const due = new Date(now.getTime() + Math.min(wait, MAX_CHECK_IN_MS));
      const planned = await deps.db
        .forBusiness(context.trace.businessId, { agencyId: context.trace.agencyId })
        .run(async (ctx) => {
          const facts = await loadConversationFacts(ctx, conversationId);
          if (facts === null) return null;
          const blocker = await followUpBlocker(ctx, {
            facts,
            values,
            nudge: null,
            inboundSeq: null,
          });
          if (blocker !== null) return { blocker };
          return planFollowUp(ctx, {
            conversationId,
            leadId: facts.lead?.id ?? null,
            runAt: due,
            payload: {
              reason: "requested",
              nudge: null,
              inboundSeq: await lastInboundSeq(ctx, conversationId),
              traceId: context.trace.traceId,
              note: action.reason.slice(0, 300),
            },
            now,
          });
        });
      if (planned === null || "blocker" in planned) {
        return {
          status: "rejected",
          message: "A follow-up cannot be scheduled for this conversation. Do not promise one.",
          data: null,
        };
      }
      if (deps.events !== null) {
        try {
          await deps.events.send([planned.event]);
        } catch {
          // The plan is stored; the sweeper sends its event.
          deps.logger.warn("follow_up.event_failed", { followUpId: planned.followUpId });
        }
      }
      return {
        status: "deferred",
        message: "The follow-up is scheduled.",
        data: { followUpAt: due.toISOString() },
      };
    },
  };
}

export function handoffActionHandlers(deps: HandoffDomainDeps) {
  return [
    escalateEmergencyHandler(deps),
    handoffToHumanHandler(),
    scheduleFollowUpHandler(deps),
  ] as const;
}

// ---------------------------------------------------------------------------------------
// Turn observer (the pipeline's `TurnObserver`)
// ---------------------------------------------------------------------------------------

export interface HandoffCommittedTurn {
  readonly conversationId: ConversationId;
  readonly turnId: string;
  readonly traceId: string;
  readonly status: string;
  readonly actions: readonly ExecutedAction[];
  readonly now: Date;
}

/**
 * A customer who opted out wrote and the turn sent nothing: the team must see it (C13).
 * Only turns for the customer's own messages count; a silent follow-up is not news.
 */
async function surfaceSilence(
  ctx: BusinessContext,
  turn: HandoffCommittedTurn,
): Promise<AnyJobEvent[]> {
  const [row] = await ctx.tx
    .select({ trigger: conversationTurns.trigger, optedOutAt: contacts.optedOutAt })
    .from(conversationTurns)
    .innerJoin(conversations, eq(conversations.id, conversationTurns.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversationTurns.id, turn.turnId))
    .limit(1);
  if (row?.trigger !== "inbound_message" || row.optedOutAt === null) return [];
  return surfaceOptedOutMessage(ctx, {
    conversationId: turn.conversationId,
    traceId: turn.traceId,
    now: turn.now,
  });
}

/**
 * When a turn commits: a `handoff_to_human` hands the conversation to a person (a takeover
 * lock that lets this turn's own messages out), and a bot reply plans the next nudge.
 */
export function createHandoffTurnObserver(deps: HandoffDomainDeps) {
  return {
    name: "handoff",
    async committed(ctx: BusinessContext, turn: HandoffCommittedTurn): Promise<AnyJobEvent[]> {
      const events: AnyJobEvent[] = [];
      if (turn.status === "no_reply") events.push(...(await surfaceSilence(ctx, turn)));
      const handoff = turn.actions.find(
        (executed) => executed.action.type === "handoff_to_human" && done(executed),
      );
      if (
        handoff !== undefined &&
        (turn.status === "replied" || turn.status === "no_reply" || turn.status === "superseded")
      ) {
        const [row] = await ctx.tx
          .select({ replies: conversationTurns.replyMessageIds })
          .from(conversationTurns)
          .where(eq(conversationTurns.id, turn.turnId))
          .limit(1);
        const ids = turn.status === "replied" ? (row?.replies ?? []) : [];
        const [last] =
          ids.length === 0
            ? [undefined]
            : await ctx.tx
                .select({ seq: sql<number>`max(${messages.sequence})` })
                .from(messages)
                .where(inArray(messages.id, ids as MessageId[]));
        const reason =
          handoff.action.type === "handoff_to_human" ? handoff.action.reason : "Handed over.";
        const started = await startTakeover(ctx, {
          conversationId: turn.conversationId,
          source: "rule",
          userId: null,
          reason: `The bot handed the conversation to a person: ${reason}`,
          traceId: turn.traceId,
          now: turn.now,
          exemptThroughSeq: last?.seq ?? null,
        });
        if (started !== null) events.push(started.event);
        await cancelFollowUps(ctx, turn.conversationId, "handed_off", turn.now);
        return events;
      }

      if (turn.status !== "replied") return events;
      // The bot scheduled its own check-in this turn: that plan stands instead of a nudge.
      const scheduled = turn.actions.some(
        (executed) => executed.action.type === "schedule_follow_up" && done(executed),
      );
      if (scheduled) return events;
      const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
      const values = settings.values;
      const facts = await loadConversationFacts(ctx, turn.conversationId);
      if (facts === null) return events;
      const nudge = await botRoundsSinceCustomer(ctx, turn.conversationId);
      // The customer messages this turn answered: one after them means the customer wrote
      // again (their own turn plans the next nudge).
      const [answered] = await ctx.tx
        .select({ throughSeq: conversationTurns.throughSeq })
        .from(conversationTurns)
        .where(eq(conversationTurns.id, turn.turnId))
        .limit(1);
      const inboundSeq = answered?.throughSeq ?? (await lastInboundSeq(ctx, turn.conversationId));
      const blocker = await followUpBlocker(ctx, { facts, values, nudge, inboundSeq });
      if (blocker !== null) {
        await cancelFollowUps(ctx, turn.conversationId, blocker, turn.now, "cadence");
        return events;
      }
      const delays = channelSetting(values, "follow_up.delays_minutes", facts.channel);
      const runAt = new Date(turn.now.getTime() + nudgeDelayMinutes(delays, nudge) * 60_000);
      const planned = await planFollowUp(ctx, {
        conversationId: turn.conversationId,
        leadId: facts.lead?.id ?? null,
        runAt,
        payload: { reason: "cadence", nudge, inboundSeq, traceId: turn.traceId },
        now: turn.now,
      });
      events.push(planned.event);
      return events;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Inbound observer (the pipeline's `InboundObserver`)
// ---------------------------------------------------------------------------------------

export interface HandoffInboundFacts {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: ChannelId;
  readonly kind: string;
  readonly text: string | null;
  readonly traceId: string;
  readonly now: Date;
}

/** Kinds whose text can be an opt-out or opt-in word. */
const KEYWORD_KINDS = new Set(["text", "interactive_reply", "email"]);

/**
 * When a customer message is stored (in the same transaction, before the reply turn can
 * start): an opt-out or opt-in word is recorded (with the one confirmation), the follow-ups
 * planned for the customer stop because they replied, and a takeover's idle time starts
 * again because the customer wrote.
 */
export function createHandoffInboundObserver(deps: HandoffDomainDeps) {
  return {
    name: "handoff",
    async stored(ctx: BusinessContext, message: HandoffInboundFacts): Promise<AnyJobEvent[]> {
      if (message.kind === "reaction") return [];
      const events: AnyJobEvent[] = [];
      const candidate =
        KEYWORD_KINDS.has(message.kind) &&
        message.text !== null &&
        message.text.trim().length > 0 &&
        message.text.length <= 60;
      if (candidate) {
        const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
        const applied = await applyKeywords(ctx, {
          contactId: message.contactId,
          conversationId: message.conversationId,
          channel: message.channel,
          messageId: message.messageId,
          text: message.text,
          traceId: message.traceId,
          values: settings.values,
          now: message.now,
          outbound: deps.outbound,
        });
        events.push(...applied.events);
        if (applied.change !== null) {
          deps.logger.info(`contact.${applied.change}`, {
            businessId: ctx.tenant.businessId,
            conversationId: message.conversationId,
            channel: message.channel,
          });
        }
      }
      await cancelFollowUpsOfContact(ctx, message.contactId, "customer_replied", message.now);
      await touchTakeover(ctx, message.conversationId, message.now);
      return events;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Turn guard (the pipeline's `TurnGuard`): the opt-out backstop
// ---------------------------------------------------------------------------------------

export interface HandoffTurnFacts {
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: ChannelId;
  readonly trigger: TurnTrigger;
  readonly settings: AppResolvedSettings;
  readonly now: Date;
}

/**
 * The opt-out rules of a turn for what the customer wrote.
 *
 * `check` stops a turn whose new messages are nothing but opt-out words (the confirmation is
 * the answer), and records an opt-out word the inbound observer did not (it failed, or the
 * message came in another way); the confirmation is queued and the pipeline's sweeper sends
 * queued messages it was not told about. Any other message of a customer who opted out is
 * not stopped here: the turn runs, so an emergency is always recognized and answered.
 *
 * `restrict` decides what such a turn may send (`optOutRestriction`): only an emergency
 * answer, or a normal reply, by `follow_up.opt_out_scope`.
 */
export function createOptOutGuard(deps: HandoffDomainDeps) {
  return {
    name: "opt_out",
    async check(ctx: BusinessContext, facts: HandoffTurnFacts): Promise<string | null> {
      if (facts.trigger !== "inbound_message") return null;
      const keywords = facts.settings.values["follow_up.opt_out_keywords"];
      const pending = await pendingCustomerMessages(ctx, facts.conversationId);
      const match = pending.find((row) => matchKeyword(row.text, keywords) !== null);
      if (match === undefined) return null;
      const [contact] = await ctx.tx
        .select({ optedOutAt: contacts.optedOutAt })
        .from(contacts)
        .where(eq(contacts.id, facts.contactId))
        .limit(1);
      if (contact?.optedOutAt == null) {
        await applyKeywords(ctx, {
          contactId: facts.contactId,
          conversationId: facts.conversationId,
          channel: facts.channel,
          messageId: match.id,
          text: match.text,
          traceId: crypto.randomUUID(),
          values: facts.settings.values,
          now: facts.now,
          outbound: deps.outbound,
        });
      }
      // "STOP" alone: nothing to answer. "STOP" with more (a gas smell, say): the turn runs,
      // restricted to an emergency answer.
      const onlyKeywords = pending.every((row) => matchKeyword(row.text, keywords) !== null);
      return onlyKeywords ? "opted_out" : null;
    },
    async restrict(ctx: BusinessContext, facts: HandoffTurnFacts) {
      if (facts.trigger !== "inbound_message") return null;
      return optOutRestriction(ctx, {
        contactId: facts.contactId,
        conversationId: facts.conversationId,
        values: facts.settings.values,
        now: facts.now,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------
// Send gate (the pipeline's `SendGate`): opt-out
// ---------------------------------------------------------------------------------------

/**
 * What may still reach a customer who opted out, at the moment of sending: the one
 * confirmation; a reply whose turn escalated an emergency, or any reply while an emergency in
 * the conversation is running or recent; with `follow_up.opt_out_scope` "proactive_only", a
 * reply to what the customer wrote after opting out. Never anything the bot starts itself
 * (nudges, reminders, check-ins), nor a reply written before the opt-out. The pipeline's send
 * step keeps its own, coarser check behind this one.
 */
export function createOptOutGate(deps: HandoffDomainDeps) {
  return {
    name: "opt_out",
    async check(
      ctx: BusinessContext,
      message: {
        readonly messageId: MessageId;
        readonly conversationId: ConversationId;
        readonly channel: ChannelId;
        readonly sequence: number;
        readonly payload: Readonly<Record<string, unknown>>;
        readonly now: Date;
      },
    ): Promise<GateVerdict> {
      const [contact] = await ctx.tx
        .select({ optedOutAt: contacts.optedOutAt })
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(eq(conversations.id, message.conversationId))
        .limit(1);
      const optedOutAt = contact?.optedOutAt ?? null;
      if (optedOutAt === null) return { kind: "send" };
      const purpose = message.payload["purpose"];
      if (purpose === "opt_out_confirmation") return { kind: "send" };
      const withhold = { kind: "withhold", reason: "opted_out" } as const;
      if (typeof purpose === "string") return withhold;
      const [turn] = await ctx.tx
        .select({
          trigger: conversationTurns.trigger,
          startedAt: conversationTurns.startedAt,
          actions: conversationTurns.actions,
        })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.conversationId, message.conversationId),
            sql`${conversationTurns.replyMessageIds} @> ${JSON.stringify([message.messageId])}::jsonb`,
          ),
        )
        .limit(1);
      if (turn?.trigger !== "inbound_message") return withhold;
      const actions = turn.actions as ExecutedAction[];
      if (actions.some((entry) => entry?.action?.type === "escalate_emergency")) {
        return { kind: "send" };
      }
      if (await hasRecentEmergency(ctx, message.conversationId, message.now)) {
        return { kind: "send" };
      }
      if (turn.startedAt.getTime() < optedOutAt.getTime()) return withhold;
      const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
      return settings.values["follow_up.opt_out_scope"] === "proactive_only"
        ? { kind: "send" }
        : withhold;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Send gate (the pipeline's `SendGate`): quiet hours
// ---------------------------------------------------------------------------------------

type GateVerdict =
  | { readonly kind: "send" }
  | { readonly kind: "hold"; readonly until: string; readonly reason: string }
  | { readonly kind: "withhold"; readonly reason: string };

/** Code-written messages that are not held: a reminder plans around quiet hours itself (C12). */
const UNGATED_PURPOSES = new Set(["opt_out_confirmation", "reminder"]);

/**
 * Quiet hours at the moment of sending, in the customer's time zone:
 * - an unprompted message (a nudge or check-in from a requested turn) waits until they end,
 *   and is dropped when the customer has written since it was written;
 * - a reply to the customer waits only with `hours.quiet_hours_cover_replies` on, and never
 *   when its turn escalated an emergency (or the conversation's emergency chain is active).
 */
export function createQuietHoursGate(deps: HandoffDomainDeps) {
  return {
    name: "quiet_hours",
    async check(
      ctx: BusinessContext,
      message: {
        readonly messageId: MessageId;
        readonly conversationId: ConversationId;
        readonly channel: ChannelId;
        readonly sequence: number;
        readonly payload: Readonly<Record<string, unknown>>;
        readonly now: Date;
      },
    ): Promise<GateVerdict> {
      const purpose = message.payload["purpose"];
      if (typeof purpose === "string" && UNGATED_PURPOSES.has(purpose)) return { kind: "send" };
      const [turn] = await ctx.tx
        .select({ trigger: conversationTurns.trigger, actions: conversationTurns.actions })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.conversationId, message.conversationId),
            sql`${conversationTurns.replyMessageIds} @> ${JSON.stringify([message.messageId])}::jsonb`,
          ),
        )
        .limit(1);
      const unprompted =
        typeof purpose === "string" || (turn !== undefined && turn.trigger !== "inbound_message");
      if (turn === undefined && !unprompted) return { kind: "send" };

      if (unprompted) {
        const [newer] = await ctx.tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, message.conversationId),
              eq(messages.direction, "inbound"),
              ne(messages.kind, "reaction"),
              gt(messages.sequence, message.sequence),
            ),
          )
          .limit(1);
        if (newer !== undefined) return { kind: "withhold", reason: "customer_replied" };
      }

      const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
      const values = settings.values;
      if (!unprompted) {
        if (!values["hours.quiet_hours_cover_replies"]) return { kind: "send" };
        // Any turn that recognized an emergency carries the safety instructions, whatever
        // became of the escalation (switched off, failed): it is never held.
        const actions = (turn?.actions ?? []) as ExecutedAction[];
        const emergency = actions.some((entry) => entry?.action?.type === "escalate_emergency");
        if (emergency) return { kind: "send" };
        // Nor is anything said in a conversation with a running or recent emergency.
        if (await hasRecentEmergency(ctx, message.conversationId, message.now)) {
          return { kind: "send" };
        }
      }
      const facts = await loadConversationFacts(ctx, message.conversationId);
      if (facts === null) return { kind: "send" };
      const zone = customerTimeZone({
        contactTimeZone: facts.contact.timeZone,
        phone: facts.contact.phone,
        businessTimeZone: facts.business.timeZone,
        mode: values["hours.customer_time_zone"],
      });
      const end = quietHoursEnd(message.now, zone, values["hours.quiet_hours"]);
      if (end === null) return { kind: "send" };
      return {
        kind: "hold",
        until: end.toISOString(),
        reason: unprompted ? "quiet_hours" : "quiet_hours_reply",
      };
    },
  };
}

/** Everything handoff adds to a turn, for the pipeline's domain composition. */
export function handoffDomainParts(deps: HandoffDomainDeps) {
  return {
    handlers: handoffActionHandlers(deps),
    observer: createHandoffTurnObserver(deps),
    inboundObserver: createHandoffInboundObserver(deps),
    guard: createOptOutGuard(deps),
    /** In order: opt-out first, then quiet hours. */
    gates: [createOptOutGate(deps), createQuietHoursGate(deps)],
  };
}
