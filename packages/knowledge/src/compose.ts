import type { ModelClient } from "@repo/ai";
import type { BusinessProfile, KnowledgeRetriever, Logger, PlaybookSnapshot } from "@repo/core";
import type { BusinessContext, Database } from "@repo/db";
import type { EventSender, JobDefinition } from "@repo/jobs";

import { createKnowledgeImportJob } from "./crawl/job";
import { createSafeFetcher, type SafeFetcher } from "./crawl/safe-fetch";
import { type ApiKeyService, createApiKeyService } from "./import/api-keys";
import { createKnowledgeRetriever } from "./knowledge/retriever";
import { createKnowledgeService, type KnowledgeService } from "./knowledge/service";
import { createPlaybookGenerationJob } from "./playbooks/job";
import { loadPlaybookForBusiness } from "./playbooks/overrides";
import { createPlaybookService, type PlaybookService } from "./playbooks/service";

/**
 * How a deployment puts this package together. Three entry points, for the three places
 * that use it:
 *
 * - `createKnowledgePorts`: what a reply turn reads (the pipeline's domain composition);
 * - `createKnowledgeJobs`: the durable functions (registered next to the pipeline's);
 * - `createKnowledgeServices`: what the admin panel and the import API call.
 */

/**
 * Which model work this deployment can do. "live": the Claude API. "offline": a developer
 * machine without a key, where a playbook is the built-in starter document and website facts
 * come from structured data only. "unconfigured": a hosted deployment without a key, where
 * model work fails loudly instead of being faked.
 */
export type KnowledgeModelMode = "live" | "offline" | "unconfigured";

export interface KnowledgePorts {
  /** The engine's `KnowledgeRetriever`. */
  readonly retriever: KnowledgeRetriever;
  /** The pipeline's playbook loader: the segment's active version with the business's overrides. */
  readonly playbookLoader: (
    ctx: BusinessContext,
    business: BusinessProfile,
  ) => Promise<PlaybookSnapshot | null>;
}

export function createKnowledgePorts(options: {
  readonly db: Database;
  readonly logger: Logger;
}): KnowledgePorts {
  const logger = options.logger.child({ component: "knowledge" });
  return {
    retriever: createKnowledgeRetriever({ db: options.db }),
    playbookLoader: (ctx, business) => loadPlaybookForBusiness(ctx, business, { logger }),
  };
}

export interface KnowledgeJobsOptions {
  readonly db: Database;
  readonly model: ModelClient;
  readonly modelMode: KnowledgeModelMode;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Default: the fetcher guarded against server-side request forgery. Tests inject one. */
  readonly fetcher?: SafeFetcher;
  /** False for organizations where strict tools are not available. */
  readonly strictTools?: boolean;
}

/** `knowledge-playbook-generate` and `knowledge-import`. */
export function createKnowledgeJobs(options: KnowledgeJobsOptions): JobDefinition[] {
  const logger = options.logger.child({ component: "knowledge-jobs" });
  const offline = options.modelMode === "offline";
  const shared = {
    db: options.db,
    model: options.model,
    logger,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.strictTools === undefined ? {} : { strictTools: options.strictTools }),
  };
  return [
    createPlaybookGenerationJob({ ...shared, generator: offline ? "starter" : "model" }),
    createKnowledgeImportJob({
      ...shared,
      extractor: offline ? "rules" : "model",
      fetcher: options.fetcher ?? createSafeFetcher(),
    }),
  ];
}

export interface KnowledgeServices {
  readonly playbooks: PlaybookService;
  readonly knowledge: KnowledgeService;
  readonly apiKeys: ApiKeyService;
}

export function createKnowledgeServices(options: {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}): KnowledgeServices {
  const deps = {
    db: options.db,
    events: options.events,
    logger: options.logger.child({ component: "knowledge" }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  return {
    playbooks: createPlaybookService(deps),
    knowledge: createKnowledgeService(deps),
    apiKeys: createApiKeyService(deps),
  };
}
