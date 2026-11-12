import { createEngine, createModelClientFromEnv, type ModelClient } from "@repo/ai";
import type { ConversationEngine, KnowledgeRetriever, Logger } from "@repo/core";
import type { BusinessTenant, Database } from "@repo/db";
import { getTenantStorage, type TenantStorage } from "@repo/db/storage";

import { type ActionHandlerRegistry, createActionHandlerRegistry } from "../actions";
import type { TurnGuard, TurnLoaders } from "../deps";
import { createKnowledgeRetriever } from "../ports/knowledge";
import { defaultLeadLoader, defaultPlaybookLoader } from "../ports/loaders";
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
 *   `analyze_photos` and `end_conversation`; the guard for conversations the bot ended; a
 *   knowledge retriever over `knowledge_items` until C6.
 *
 * Later chunks register here, and only here:
 * - C5: handlers for `update_lead_fields` and `mark_not_a_fit`; the lead loader if it needs
 *   more than the tables.
 * - C6: the real `KnowledgeRetriever`; the playbook loader with per-business overrides.
 * - C12: handlers for `offer_times` and `book_meeting`.
 * - C13: handlers for `schedule_follow_up`, `escalate_emergency` and `handoff_to_human`;
 *   takeover guards. C17: rate-limit and spend-cap guards.
 */
export interface DomainComposition {
  readonly engine: ConversationEngine;
  readonly actions: ActionHandlerRegistry;
  readonly knowledge: KnowledgeRetriever;
  readonly loaders: TurnLoaders;
  readonly guards: readonly TurnGuard[];
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
}

export function createDomainComposition(options: DomainCompositionOptions): DomainComposition {
  const { db, logger } = options;
  const model = options.model ?? createModelClientFromEnv({ logger });
  const leaseMs = (options.leaseSeconds ?? 300) * 1000;
  // A turn renews its lease right before it calls the engine (generate step), so the engine
  // may use the lease minus a margin; one model call gets at most half of that.
  const turnBudgetMs = Math.max(20_000, leaseMs - LEASE_MARGIN_MS);
  const engine = createEngine({
    model,
    turnBudgetMs,
    callTimeoutMs: Math.max(10_000, Math.min(90_000, Math.floor(turnBudgetMs / 2))),
  });
  return {
    engine,
    model,
    actions: createActionHandlerRegistry(
      engineActionHandlers({
        db,
        model,
        storage: options.storage ?? getTenantStorage,
        logger: logger.child({ component: "engine-handlers" }),
      }),
    ),
    knowledge: createKnowledgeRetriever({ db }),
    loaders: { playbook: defaultPlaybookLoader, lead: defaultLeadLoader },
    guards: [endedConversationGuard],
  };
}
