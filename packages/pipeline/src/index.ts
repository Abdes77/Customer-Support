/**
 * @repo/pipeline (owner: C3)
 *
 * The message pipeline (ARCHITECTURE §2): webhook ingest and idempotent storage, the
 * debounced, lease-guarded reply turn per conversation, the ordered send path with retries
 * and dead letters, the sweeper, and the composition root that plugs the engine, the action
 * handlers and the loaders into it.
 *
 *   const pipeline = createPipeline({ db, adapters, engine, events });
 *   await pipeline.handleWebhook("test", request);     // from the webhook route
 *   runner.register(pipeline.jobs());                  // reply, send, sweeper
 *
 * Server only.
 */
export { createPipeline, type Pipeline } from "./pipeline";
export {
  createDomainComposition,
  type DomainComposition,
  type DomainCompositionOptions,
} from "./composition";
export {
  DEFAULT_PIPELINE_OPTIONS,
  type PipelineContext,
  type PipelineDeps,
  type PipelineOptions,
  type TurnFacts,
  type TurnGuard,
  type TurnLoaders,
} from "./deps";
export { type AdapterRegistry, createAdapterRegistry } from "./adapters";
export {
  type ActionHandlerRegistry,
  type AnyActionHandler,
  createActionHandlerRegistry,
  createToolRuntime,
  defaultActionOutcome,
} from "./actions";
export { createEchoEngine, ECHO_PROMPT_VERSION } from "./echo-engine";
export { createKnowledgeRetriever, emptyKnowledgeRetriever } from "./ports/knowledge";
export { endedConversationGuard } from "./composition/guards";
export {
  analyzePhotosHandler,
  endConversationHandler,
  engineActionHandlers,
  type EngineHandlerDeps,
  requestPhotoHandler,
} from "./composition/handlers";
export { defaultLeadLoader, defaultPlaybookLoader, loadBusinessProfile } from "./ports/loaders";
export { createModelCallSink } from "./ports/model-calls";
export { type IngestResult, isReplyableKind } from "./ingest/ingest";
export { type WebhookResponse } from "./ingest/webhook";
export { nextOutboundStatus } from "./ingest/signals";
export { REPLY_FUNCTION_ID, type ReplyRunOutcome } from "./reply/job";
export { SEND_FUNCTION_ID } from "./send/job";
export { SWEEPER_FUNCTION_ID, type SweepResult } from "./sweeper";
export { splitText } from "./send/split";
export { textToHtml } from "./send/prepare";
export { messagingWindow } from "./send/window";
export {
  receivedEventId,
  sendEventId,
  sendFailedEventId,
  takeoverStartedEventId,
} from "./event-ids";
