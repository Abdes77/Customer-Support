import { createEngine, createModelClientFromEnv, type ModelClient } from "@repo/ai";
import type { ConversationEngine, KnowledgeRetriever, Logger } from "@repo/core";
import type { BusinessTenant, Database } from "@repo/db";
import { getTenantStorage, type TenantStorage } from "@repo/db/storage";
import { handoffDomainParts } from "@repo/handoff";
import { createKnowledgePorts } from "@repo/knowledge";
import type { EventSender } from "@repo/jobs";
import { createLeadTurnObserver, leadActionHandlers, loadLeadSnapshot } from "@repo/leads";
import {
  schedulingActionHandlers,
  schedulingConfigFromEnv,
  type SchedulingDeps,
} from "@repo/scheduling";

import { type ActionHandlerRegistry, createActionHandlerRegistry } from "../actions";
import type { InboundObserver, SendGate, TurnGuard, TurnLoaders, TurnObserver } from "../deps";
import { enqueueBotMessage, enqueueHumanMessage } from "../outbound";
import { createLimitsGuard } from "../limits/guard";
import { endedConversationGuard } from "./guards";
import { engineActionHandlers } from "./handlers";

/**
 * The domain composition root (ARCHITECTURE §6, BUILD_PLAN "Shared files"): which engine,
 * action handlers, knowledge retriever, loaders and guards every turn uses, in production
 * and in the evaluation harness alike. `createPipeline()` takes these unless the caller
 * overrides them (tests do).
 *
 * Registered so far:
 * - C4: the conversation engine from @repo/ai; handlers for `request_photo`,
 *   `analyze_photos` and `end_conversation`; the guard for conversations the bot ended.
 * - C6: the knowledge retriever (full-text search plus the kinds of fact a message asks
 *   about) and the playbook loader (the segment's active version with the business's own
 *   sections), both from @repo/knowledge.
 *
 * - C5: handlers for `update_lead_fields` and `mark_not_a_fit` (scoring, report, routing
 *   decision in the tool result), the lead loader (decisions in `sequence` order) and the
 *   turn observer that keeps every conversation's lead scored and sends the `lead.*` events,
 *   all from @repo/leads.
 *
 * - C12: handlers for `offer_times`, `book_meeting` and `cancel_meeting` (calendars and
 *   Calendly), from @repo/scheduling.
 *
 * - C13: handlers for `escalate_emergency` (records the emergency and starts the chain),
 *   `handoff_to_human` and `schedule_follow_up`; the turn observer that starts the takeover
 *   of a handoff and plans the next nudge; the inbound observer that records opt-out and
 *   opt-in words, stops follow-ups when the customer writes and keeps a takeover awake; the
 *   opt-out guard (skips a lone opt-out word; restricts what an opted-out customer's turn may
 *   send by `follow_up.opt_out_scope`, an emergency always answered); the opt-out and
 *   quiet-hours send gates. All from @repo/handoff.
 *
 * - C17: the limits guard (rate limits and model-spend caps from `limits.*`), in
 *   `limitGuards`, which the pipeline asks after every other guard, the channels' included.
 */
export interface DomainComposition {
  readonly engine: ConversationEngine;
  readonly actions: ActionHandlerRegistry;
  readonly knowledge: KnowledgeRetriever;
  readonly loaders: TurnLoaders;
  readonly guards: readonly TurnGuard[];
  /** Rate limits and spend caps (C17), asked after every other guard. */
  readonly limitGuards: readonly TurnGuard[];
  /** What happens when a turn commits (C5: the lead side of the turn and its events). */
  readonly observers: readonly TurnObserver[];
  /** What happens when a customer message is stored (C13: opt-out, follow-ups, takeover). */
  readonly inboundObservers: readonly InboundObserver[];
  /** When bot messages may leave (C13: opt-out, then quiet hours). */
  readonly sendGates: readonly SendGate[];
  /** The model client behind the engine and the photo analysis. */
  readonly model: ModelClient;
}

/** The engine stops this long before the turn lease runs out, to leave room for the commit. */
const LEASE_MARGIN_MS = 60_000;

export interface DomainCompositionOptions {
  readonly db: Database;
  readonly logger: Logger;
  /** Default: chosen from the environment (the Claude API, or the offline model locally). */
  readonly model?: ModelClient;
  /** The turn lease of the pipeline: the engine's deadline has to fit inside it. */
  readonly leaseSeconds?: number;
  /** Where attachments are stored. Default: the deployment's object store. */
  readonly storage?: (tenant: BusinessTenant) => TenantStorage;
  /** Where domain events go (C12: a booking's reminders). Default: none are sent. */
  readonly events?: EventSender;
  /**
   * Calendars and Calendly (C12): the OAuth apps, the public origin and the `fetch` the
   * vendors are called with. Default: from the environment and the global `fetch`.
   */
  readonly scheduling?: Partial<Omit<SchedulingDeps, "db" | "logger" | "events">>;
  /** The service's clock for handoff's timing (follow-ups, takeover activity). */
  readonly clock?: () => Date;
}

export function createDomainComposition(options: DomainCompositionOptions): DomainComposition {
  const { db, logger } = options;
  const model = options.model ?? createModelClientFromEnv({ logger });
  const leaseMs = (options.leaseSeconds ?? 300) * 1000;
  // A turn renews its lease right before it calls the engine (generate step), so the engine
  // may use the lease minus a margin; one model call gets at most half of that.
  const turnBudgetMs = Math.max(20_000, leaseMs - LEASE_MARGIN_MS);
  const knowledge = createKnowledgePorts({ db, logger });
  const leadLogger = logger.child({ component: "leads" });
  const engine = createEngine({
    model,
    turnBudgetMs,
    callTimeoutMs: Math.max(10_000, Math.min(90_000, Math.floor(turnBudgetMs / 2))),
  });
  const handoff = handoffDomainParts({
    db,
    logger: logger.child({ component: "handoff" }),
    events: options.events ?? null,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    outbound: { enqueueBot: enqueueBotMessage, enqueueHuman: enqueueHumanMessage },
  });
  return {
    engine,
    model,
    actions: createActionHandlerRegistry([
      ...engineActionHandlers({
        db,
        model,
        storage: options.storage ?? getTenantStorage,
        logger: logger.child({ component: "engine-handlers" }),
      }),
      ...leadActionHandlers({ db, logger: leadLogger }),
      ...schedulingActionHandlers({
        db,
        logger: logger.child({ component: "scheduling" }),
        fetch: (input, init) => fetch(input, init),
        ...schedulingConfigFromEnv(),
        events: options.events ?? null,
        ...options.scheduling,
      }),
      ...handoff.handlers,
    ]),
    knowledge: knowledge.retriever,
    loaders: { playbook: knowledge.playbookLoader, lead: loadLeadSnapshot },
    guards: [endedConversationGuard, handoff.guard],
    limitGuards: [createLimitsGuard({ db, logger })],
    observers: [createLeadTurnObserver({ db, logger: leadLogger }), handoff.observer],
    inboundObservers: [handoff.inboundObserver],
    sendGates: handoff.gates,
  };
}
