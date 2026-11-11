import type { ParsedWebhook, WebhookRequest } from "@repo/core";
import type { BusinessRef } from "@repo/db";
import type { JobDefinition } from "@repo/jobs";

import { type PipelineContext, type PipelineDeps, resolveDeps } from "./deps";
import { ingest, type IngestResult } from "./ingest/ingest";
import { handleWebhook, type WebhookResponse } from "./ingest/webhook";
import { replyJob } from "./reply/job";
import { sendJob } from "./send/job";
import { sweepBusiness, sweeperJob, type SweepResult } from "./sweeper";

export interface Pipeline {
  /** The whole synchronous part of a webhook (verify, parse, store, emit). Never throws. */
  handleWebhook(channel: string, request: WebhookRequest): Promise<WebhookResponse>;
  /** Stores normalized messages and emits their events (email, widget and tests call it). */
  ingest(parsed: ParsedWebhook): Promise<IngestResult>;
  /** The durable functions: reply, send and sweeper. Register them with a job runner. */
  jobs(): JobDefinition[];
  /** One business's sweep, for tests and the dev tools. */
  sweep(business: BusinessRef): Promise<SweepResult>;
  /** The resolved dependencies, for the evaluation harness and tests. */
  readonly context: PipelineContext;
}

/**
 * The message pipeline's composition root (ARCHITECTURE §6): it holds the engine, the action
 * handlers, the knowledge retriever and the loaders, and turns them into a webhook handler
 * and three durable functions. `apps/web/src/server` builds one per process with the channel
 * adapters, the database and the job runner of the deployment.
 */
export function createPipeline(deps: PipelineDeps): Pipeline {
  const context = resolveDeps(deps);
  return {
    context,
    handleWebhook: (channel, request) => handleWebhook(context, channel, request),
    ingest: (parsed) => ingest(context, parsed),
    jobs: () => [replyJob(context), sendJob(context), sweeperJob(context)],
    sweep: (business) => sweepBusiness(context, business),
  };
}
