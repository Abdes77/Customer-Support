/**
 * @repo/ai (owner: C4)
 *
 * The Claude model client and the conversation engine.
 *
 *   const engine = createEngine({ model: createModelClientFromEnv() });
 *   const result = await engine.respond(input, ports);      // ConversationEngine, @repo/core
 *
 * - Model client: `ModelClient` is the port every model call goes through (replies, photo
 *   analysis, and in later chunks reports, playbooks and evaluations). `callModel` adds the
 *   audit record. `createAnthropicModelClient` talks to the Claude API by the rules of
 *   docs/ARCHITECTURE.md §5; `createOfflineModelClient` needs no key.
 * - Prompt: the versioned core prompt (`src/prompt/core`) and the sections rendered from the
 *   playbook, the business and the settings.
 * - Engine: `createEngine`, the tool loop, the output guard.
 * - Dry runs: `createDryRunConversation` and `dryRunTurn` for the evaluation harness.
 * - Tests of other packages: `@repo/ai/testing` has the scripted model client.
 *
 * Server only.
 */
export {
  createEngine,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_TURN_BUDGET_MS,
  type EngineOptions,
} from "./engine/engine";
export type { ReplyHints } from "./engine/hints";
export {
  type AfterHoursDirective,
  describeSituation,
  type EmergencyClass,
  emergencyHints,
  type ReplyLimits,
  type TurnPurpose,
  type TurnSituation,
} from "./engine/situation";

// The model client
export {
  addUsage,
  assistantEcho,
  type ModelCacheControl,
  type ModelClient,
  type ModelContentBlock,
  type ModelContentBlockParam,
  type ModelMessageParam,
  type ModelRequest,
  type ModelResponse,
  type ModelStopReason,
  type ModelSystemBlock,
  type ModelTool,
  type ModelToolResultBlockParam,
  type ModelToolUnion,
  type ModelToolUseBlock,
  type ModelUsage,
  responseText,
  responseToolUses,
  supportsEffort,
  supportsMidConversationSystem,
  ZERO_USAGE,
} from "./model/types";
export {
  type AnthropicMessagesApi,
  type AnthropicModelClientOptions,
  createAnthropicModelClient,
  fromMessagesResponse,
  SERVER_SIDE_FALLBACK_BETA,
  toMessagesRequest,
  toModelError,
} from "./model/anthropic-client";
export { callModel, type ModelCallContext } from "./model/call";
export { createModelClientFromEnv, type ModelMode, modelModeFromEnv } from "./model/from-env";
export { createOfflineModelClient, OFFLINE_MODEL_ID } from "./model/offline";
export { estimateCostMicroUsd } from "./model/pricing";

// The prompt
export {
  type CorePrompt,
  CURRENT_REPLY_PROMPT,
  PROMPT_VERSION,
  RENDER_VERSION,
  REPLY_PROMPTS,
} from "./prompt/core";
export { type BuiltPrompt, buildPrompt, buildSystemBlocks, withOperatorNote } from "./prompt/build";
export { allowedLinkDomains, renderBusinessBlock } from "./prompt/business-block";
export { effectivePlaybook, renderPlaybookBlock } from "./prompt/playbook-block";
export { PLACEHOLDER_PLAYBOOK_SLUGS, placeholderPlaybook } from "./prompt/placeholder-playbooks";
export { renderTurnContext } from "./prompt/turn-context";
export { ENGINE_TOOLS, type EngineTool, findEngineTool, modelTools } from "./tools/definitions";

// Lead fields (for lead scoring, C5)
export {
  CONTACT_FIELD_KEYS,
  DECISION_ROLE_VALUES,
  isKnown,
  JOB_TYPE_VALUES,
  type LeadFieldGroup,
  type LeadFieldSpec,
  type LeadFieldType,
  leadFieldCatalogue,
  normalizeLeadValue,
  OBSERVABLE_SIGNALS,
  openFields,
  PROPERTY_TYPE_VALUES,
  TIMELINE_VALUES,
} from "./lead-fields";

// The output guard
export {
  allowedAmounts,
  type Draft,
  finalizeDraft,
  type Finding,
  type GuardContext,
  type GuardRule,
  reviewDraft,
} from "./guard/guard";
export { moneyAmounts } from "./guard/money";
export { type ParsedReply, parseReply } from "./guard/parse";

// Business hours
export {
  businessHoursState,
  clockTime,
  describeNextOpen,
  describeWeeklyHours,
  type HoursState,
  hoursOn,
  type LocalMoment,
  localMoment,
  usFederalHolidays,
  zonedInstant,
} from "./hours";

// Photo analysis
export {
  analyzePhotos,
  MAX_PHOTO_BYTES,
  PHOTO_PROMPT_VERSION,
  type PhotoAnalysisRequest,
  type PhotoAnalysisResult,
  type PhotoInput,
} from "./photos/analyze";

// Dry runs
export {
  createDryRunConversation,
  createDryRunPorts,
  createMemoryToolRuntime,
  type CustomerMessage,
  type DryRunConversation,
  type DryRunConversationOptions,
  type DryRunPorts,
  type DryRunState,
  type DryRunTurn,
  dryRunTurn,
  placeholderRouting,
  staticKnowledge,
} from "./dry-run/dry-run";
