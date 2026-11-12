import type { ModelClient } from "@repo/ai";
import {
  type BusinessProfile,
  type ChannelId,
  type ContactId,
  type ConversationEngine,
  type ConversationId,
  createLogger,
  type KnowledgeRetriever,
  type LeadSnapshot,
  type Logger,
  type ModelCallSink,
  type PlaybookSnapshot,
  type TurnTrigger,
} from "@repo/core";
import type { BusinessContext, BusinessTenant, Database } from "@repo/db";
import { getTenantStorage, type TenantStorage } from "@repo/db/storage";
import type { Duration, EventSender, RetryCount } from "@repo/jobs";
import type { AppResolvedSettings } from "@repo/settings";

import type { ActionHandlerRegistry } from "./actions";
import type { AdapterRegistry } from "./adapters";
import { createDomainComposition } from "./composition";

/** What a guard sees when it decides whether a turn may reply. */
export interface TurnFacts {
  readonly tenant: BusinessTenant;
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly channel: ChannelId;
  readonly trigger: TurnTrigger;
  readonly settings: AppResolvedSettings;
  readonly now: Date;
}

/**
 * A rule that can stop a turn before the engine runs (C13 takeover rules, C17 rate limits
 * and spend caps). It runs inside the turn's claim transaction, under the turn lease.
 * Return a short reason ("rate_limited") to stop, or null. A stopped turn stores nothing
 * for the customer; the messages stay visible in the inbox.
 */
export interface TurnGuard {
  readonly name: string;
  check(ctx: BusinessContext, facts: TurnFacts): Promise<string | null>;
}

/** Loads the parts of the engine input that other chunks own (C5 lead, C6 playbook). */
export interface TurnLoaders {
  readonly playbook: (
    ctx: BusinessContext,
    business: BusinessProfile,
  ) => Promise<PlaybookSnapshot | null>;
  readonly lead: (ctx: BusinessContext, conversationId: ConversationId) => Promise<LeadSnapshot>;
}

export interface PipelineOptions {
  /** How long a turn may hold the conversation before another run may take over. */
  readonly leaseSeconds: number;
  /** Waits between attempts to take a busy turn lease (ms); the last one repeats. */
  readonly leaseWaitsMs: readonly number[];
  /** Waits for an earlier outbound message of the conversation to finish (ms). */
  readonly orderWaitsMs: readonly number[];
  /** Inngest's static debounce in front of the per-business wait (ARCHITECTURE §2, step 8). */
  readonly debounce: { readonly period: Duration; readonly timeout: Duration };
  readonly replyRetries: RetryCount;
  readonly sendRetries: RetryCount;
  /** Webhook bodies above this size are refused with 413. */
  readonly maxWebhookBytes: number;
  /** The sweeper re-emits inbound messages left un-enqueued for this long. */
  readonly sweepUnenqueuedAfterSeconds: number;
  /** The sweeper re-emits outbound messages left queued for this long. */
  readonly sweepQueuedAfterSeconds: number;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  leaseSeconds: 300,
  leaseWaitsMs: [1000, 2000, 4000, 8000, 15_000, 30_000],
  orderWaitsMs: [
    1000, 2000, 4000, 8000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000,
    300_000, 300_000,
  ],
  debounce: { period: "2s", timeout: "1m" },
  replyRetries: 4,
  sendRetries: 5,
  maxWebhookBytes: 1024 * 1024,
  sweepUnenqueuedAfterSeconds: 60,
  sweepQueuedAfterSeconds: 300,
};

export interface PipelineDeps {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly events: EventSender;
  /*
   * The domain parts below default to `createDomainComposition()` (src/composition), where
   * later chunks register theirs. Pass them only to override (tests, experiments).
   */
  readonly engine?: ConversationEngine;
  /**
   * The model client behind the default engine and the photo analysis. Default: chosen from
   * the environment (`createModelClientFromEnv` in @repo/ai). Ignored for the engine when
   * `engine` is given.
   */
  readonly model?: ModelClient;
  readonly actions?: ActionHandlerRegistry;
  readonly knowledge?: KnowledgeRetriever;
  readonly modelCalls?: ModelCallSink;
  readonly guards?: readonly TurnGuard[];
  readonly loaders?: Partial<TurnLoaders>;
  readonly storage?: (tenant: BusinessTenant) => TenantStorage;
  readonly logger?: Logger;
  /** Injected clock. Default: the system clock. */
  readonly clock?: () => Date;
  readonly options?: Partial<PipelineOptions>;
}

/** The dependencies with every default filled in. Internal to the package. */
export interface PipelineContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly engine: ConversationEngine;
  readonly events: EventSender;
  readonly actions: ActionHandlerRegistry;
  readonly knowledge: KnowledgeRetriever;
  /** Null: each turn stores its model calls in `model_calls` with its settings version. */
  readonly modelCalls: ModelCallSink | null;
  readonly guards: readonly TurnGuard[];
  readonly loaders: TurnLoaders;
  readonly storage: (tenant: BusinessTenant) => TenantStorage;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly options: PipelineOptions;
}

export function resolveDeps(deps: PipelineDeps): PipelineContext {
  const logger = (deps.logger ?? createLogger()).child({ component: "pipeline" });
  const options = { ...DEFAULT_PIPELINE_OPTIONS, ...deps.options };
  const storage = deps.storage ?? getTenantStorage;
  const domain = createDomainComposition({
    db: deps.db,
    logger,
    leaseSeconds: options.leaseSeconds,
    storage,
    ...(deps.model === undefined ? {} : { model: deps.model }),
  });
  return {
    db: deps.db,
    adapters: deps.adapters,
    engine: deps.engine ?? domain.engine,
    events: deps.events,
    actions: deps.actions ?? domain.actions,
    knowledge: deps.knowledge ?? domain.knowledge,
    modelCalls: deps.modelCalls ?? null,
    guards: deps.guards ?? domain.guards,
    loaders: {
      playbook: deps.loaders?.playbook ?? domain.loaders.playbook,
      lead: deps.loaders?.lead ?? domain.loaders.lead,
    },
    storage,
    logger,
    clock: deps.clock ?? (() => new Date()),
    options,
  };
}
