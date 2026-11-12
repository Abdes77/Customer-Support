import type { ModelClient } from "@repo/ai";
import {
  type AttachmentKind,
  type BusinessProfile,
  type ChannelSignal,
  type ExecutedAction,
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
  type WindowFallbackResolver,
} from "@repo/core";
import type { BusinessContext, BusinessTenant, Database } from "@repo/db";
import { getTenantStorage, type TenantStorage } from "@repo/db/storage";
import type { AnyJobEvent, Duration, EventSender, RetryCount } from "@repo/jobs";
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

/** A turn as it was committed, for `TurnObserver`s. */
export interface CommittedTurn {
  readonly conversationId: ConversationId;
  readonly turnId: string;
  readonly traceId: string;
  /** The turn's status after the commit: replied, no_reply, refused, failed, superseded. */
  readonly status: string;
  /** Every action the engine carried out in the turn, with its outcome. */
  readonly actions: readonly ExecutedAction[];
  readonly now: Date;
}

/**
 * Something that happens when a reply turn commits (ARCHITECTURE §2, step 14): C5 records
 * the lead side of the turn and hands back its `lead.*` events. `committed` runs inside the
 * commit transaction, under a savepoint: if it throws, its writes are undone, the error is
 * logged and the turn commits without them. The events it returns are sent by the emit step
 * with the turn's own; `emitted` is called (best effort) once they were sent.
 */
export interface TurnObserver {
  readonly name: string;
  committed(ctx: BusinessContext, turn: CommittedTurn): Promise<readonly AnyJobEvent[]>;
  emitted?(tenant: BusinessTenant, events: readonly AnyJobEvent[], now: Date): Promise<void>;
}

/** Loads the parts of the engine input that other chunks own (C5 lead, C6 playbook). */
export interface TurnLoaders {
  readonly playbook: (
    ctx: BusinessContext,
    business: BusinessProfile,
  ) => Promise<PlaybookSnapshot | null>;
  readonly lead: (ctx: BusinessContext, conversationId: ConversationId) => Promise<LeadSnapshot>;
}

/**
 * Handles the `provider_event` signals of one channel (C9: WhatsApp template status, account
 * and quality updates). It resolves the account itself (the event may name a group account)
 * and returns whether it did something. Registered by the infrastructure root (apps/web).
 */
export interface ProviderEventHandler {
  readonly channel: ChannelId;
  handle(signal: Extract<ChannelSignal, { type: "provider_event" }>): Promise<boolean>;
}

/**
 * Turns an inbound attachment into text the engine reads in its place (C9: a voice message
 * becomes its transcript, or a note asking the customer to type). Runs in its own step after
 * the download (`bytes` is null when the file could not be downloaded) and stores what it
 * returns as the attachment's `analysis`; null leaves the attachment as it is. Throw a
 * retryable error to try again later.
 */
export interface AttachmentEnricher {
  readonly name: string;
  readonly channel: ChannelId;
  readonly kinds: readonly AttachmentKind[];
  enrich(input: {
    readonly tenant: BusinessTenant;
    readonly attachmentId: string;
    readonly kind: AttachmentKind;
    readonly mimeType: string | null;
    readonly bytes: Uint8Array | null;
    readonly settings: AppResolvedSettings;
    readonly logger: Logger;
  }): Promise<string | null>;
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
  // Meta's webhooks carry up to 3 MB; Vercel refuses request bodies over 4.5 MB.
  maxWebhookBytes: 4 * 1024 * 1024,
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
  /**
   * Guards of one channel, registered by the infrastructure root next to its adapter (C10:
   * Instagram story replies the team answers, Meta's standby channel). They run after the
   * domain guards, which `guards` replaces and this list never does.
   */
  readonly channelGuards?: readonly TurnGuard[];
  readonly observers?: readonly TurnObserver[];
  readonly loaders?: Partial<TurnLoaders>;
  /*
   * Channel-specific parts, registered by the infrastructure root (apps/web) next to the
   * adapters: what replaces a free-form message once the messaging window has closed, who
   * handles provider events, and what turns attachments into text.
   */
  readonly windowFallbacks?: readonly WindowFallbackResolver[];
  readonly providerEvents?: readonly ProviderEventHandler[];
  readonly attachmentEnrichers?: readonly AttachmentEnricher[];
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
  readonly observers: readonly TurnObserver[];
  readonly loaders: TurnLoaders;
  readonly windowFallbacks: readonly WindowFallbackResolver[];
  readonly providerEvents: readonly ProviderEventHandler[];
  readonly attachmentEnrichers: readonly AttachmentEnricher[];
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
    guards: [...(deps.guards ?? domain.guards), ...(deps.channelGuards ?? [])],
    observers: deps.observers ?? domain.observers,
    loaders: {
      playbook: deps.loaders?.playbook ?? domain.loaders.playbook,
      lead: deps.loaders?.lead ?? domain.loaders.lead,
    },
    windowFallbacks: deps.windowFallbacks ?? [],
    providerEvents: deps.providerEvents ?? [],
    attachmentEnrichers: deps.attachmentEnrichers ?? [],
    storage,
    logger,
    clock: deps.clock ?? (() => new Date()),
    options,
  };
}
