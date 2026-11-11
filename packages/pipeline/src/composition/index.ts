import type { ConversationEngine, KnowledgeRetriever, Logger } from "@repo/core";
import type { Database } from "@repo/db";

import { type ActionHandlerRegistry, createActionHandlerRegistry } from "../actions";
import type { TurnGuard, TurnLoaders } from "../deps";
import { createEchoEngine } from "../echo-engine";
import { emptyKnowledgeRetriever } from "../ports/knowledge";
import { defaultLeadLoader, defaultPlaybookLoader } from "../ports/loaders";

/**
 * The domain composition root (ARCHITECTURE §6, BUILD_PLAN "Shared files"): which engine,
 * action handlers, knowledge retriever, loaders and guards every turn uses, in production
 * and in the evaluation harness alike. `createPipeline()` takes these unless the caller
 * overrides them (tests do).
 *
 * Later chunks register here, and only here:
 * - C4: `createEngine()` from @repo/ai in place of the echo stub; handlers for
 *   `request_photo`, `analyze_photos` and `end_conversation`.
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
}

export function createDomainComposition(_options: {
  readonly db: Database;
  readonly logger: Logger;
}): DomainComposition {
  return {
    engine: createEchoEngine(),
    actions: createActionHandlerRegistry([]),
    knowledge: emptyKnowledgeRetriever,
    loaders: { playbook: defaultPlaybookLoader, lead: defaultLeadLoader },
    guards: [],
  };
}
