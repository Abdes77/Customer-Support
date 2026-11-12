/**
 * @repo/knowledge (owner: C6)
 *
 * Industry playbooks (generation with web research, immutable versions, diff, rollback,
 * per-business overrides) and business knowledge (facts, CSV and API import, website crawl,
 * retrieval for the conversation engine). docs/ARCHITECTURE.md §2 "As built (C6)" is the map.
 *
 * Server only. `src/compose.ts` wires a deployment: `createKnowledgePorts` (the retriever and
 * the playbook loader the pipeline's domain composition registers), `createKnowledgeJobs` and
 * `createKnowledgeServices` (what the admin panel calls).
 */

// Composition
export {
  createKnowledgeJobs,
  createKnowledgePorts,
  createKnowledgeServices,
  type KnowledgeJobsOptions,
  type KnowledgeModelMode,
  type KnowledgePorts,
  type KnowledgeServices,
} from "./compose";

// Playbook documents
export {
  COMPLETENESS_MINIMUMS,
  completenessIssues,
  describeIssues,
  documentRuleIssues,
  normalizeUrl,
  type ParsedPlaybook,
  type ParsedSection,
  parsePlaybookDocument,
  parsePlaybookSection,
  type PlaybookIssue,
} from "./playbooks/document";
export {
  diffPlaybooks,
  type PlaybookDiff,
  type SectionDiff,
  summarizeDiff,
} from "./playbooks/diff";

// Generation
export {
  checkSubmission,
  type GeneratedPlaybook,
  generatePlaybook,
  PLAYBOOK_PROMPT_VERSION,
  PLAYBOOK_SYSTEM_PROMPT,
  type PlaybookBrief,
  PlaybookGenerationError,
  type PlaybookGenerationFailure,
  type PlaybookGenerationOptions,
  type PlaybookGenerationStats,
  type PlaybookModelCaller,
  SUBMIT_TOOL_NAME,
  submitPlaybookTool,
  webSearchTool,
} from "./playbooks/generate";
export {
  createSearchLedger,
  findSource,
  recordSearches,
  type SearchLedger,
  type SearchSource,
} from "./playbooks/sources";
export { starterPlaybook } from "./playbooks/starter";
export {
  createPlaybookGenerationJob,
  PLAYBOOK_GENERATION_JOB_ID,
  type PlaybookJobDeps,
} from "./playbooks/job";

// Versions, runs and overrides
export {
  findSegment,
  GENERATION_STALE_MS,
  getActivePlaybook,
  getGeneration,
  getPlaybookVersion,
  listGenerations,
  listPlaybookVersions,
  listSegmentPlaybooks,
  type PlaybookGenerationRecord,
  PlaybookValidationError,
  type PlaybookVersionRecord,
  type PlaybookVersionSummary,
  type PlaybookWriteContext,
  rollbackPlaybook,
  type SavedPlaybook,
  type SavePlaybookInput,
  savePlaybookVersion,
  type SegmentPlaybookStatus,
  type SegmentRecord,
} from "./playbooks/store";
export {
  applyOverrides,
  clearPlaybookOverride,
  isOverridableSection,
  listPlaybookOverrides,
  loadPlaybookForBusiness,
  OVERRIDABLE_SECTIONS,
  type OverridableSection,
  type PlaybookOverrideRecord,
  setPlaybookOverride,
} from "./playbooks/overrides";
export {
  assignSegment,
  type AssignSegmentInput,
  type AssignSegmentResult,
  type PlaybookAssignment,
  type PlaybookRequestDeps,
  requestPlaybookGeneration,
  type SegmentChoice,
  segmentSlug,
} from "./playbooks/onboarding";
export { createPlaybookService, type PlaybookService } from "./playbooks/service";

// Knowledge items and retrieval
export {
  assertRoomForFacts,
  confirmKnowledgeItem,
  createKnowledgeItem,
  deleteKnowledgeItem,
  FACT_SOURCES,
  type FactSource,
  KnowledgeItemInput,
  KnowledgeItemPatch,
  type KnowledgeItemRecord,
  listKnowledgeItems,
  type ListKnowledgeOptions,
  MAX_ACTIVE_FACTS,
  MAX_FACT_CONTENT,
  MAX_FACT_TITLE,
  setKnowledgeItemStatus,
  updateKnowledgeItem,
} from "./knowledge/items";
export {
  askedCategories,
  createKnowledgeRetriever,
  isWebsiteSource,
  searchTerms,
} from "./knowledge/retriever";
export {
  createKnowledgeService,
  type ImportRunRecord,
  type KnowledgeService,
  listAgencyImports,
} from "./knowledge/service";
export { cleanLine, cleanText, looksLikeInstruction } from "./knowledge/text";

// Import: CSV and API
export {
  CSV_LIMITS,
  type CsvDelimiter,
  type CsvFailure,
  type CsvRow,
  detectDelimiter,
  parseCsv,
  type ParsedCsv,
} from "./import/csv";
export {
  ColumnMapping,
  ColumnTarget,
  type MappingProblem,
  mappingProblems,
  parseCategory,
  PROFILE_FIELDS,
  type ProfileField,
  suggestMapping,
} from "./import/mapping";
export {
  csvToRecords,
  IMPORT_LIMITS,
  ImportFact,
  type ImportProblem,
  ImportProfile,
  type ImportRecord,
} from "./import/records";
export {
  applyImport,
  type ApplyImportInput,
  type ImportContext,
  importKey,
  type ImportMode,
  type ImportResult,
  type ImportStats,
  MAX_STORED_PROBLEMS,
  type ProfileMode,
  recordFailedImport,
} from "./import/apply";
export {
  type ApiImportInput,
  type ApiImportOutcome,
  ApiImportRequest,
  type CsvImportInput,
  type CsvImportResult,
  type CsvPreview,
  importApiRecords,
  importCsv,
  previewCsv,
} from "./import/run";
export {
  handleCsvImportRequest,
  handleImportRequest,
  handleImportStatusRequest,
  IMPORT_SCOPE_READ,
  IMPORT_SCOPE_WRITE,
  type ImportApiDeps,
  MAX_JSON_BYTES,
} from "./import/http";
export {
  API_KEY_SCOPES,
  type ApiKeyRecord,
  type ApiKeyService,
  createApiKeyAsSystem,
  createApiKeyService,
  type CreatedApiKey,
  CreateApiKeyInput,
} from "./import/api-keys";

// Website crawl
export { isIpLiteral, isPublicAddress } from "./crawl/address";
export {
  CRAWLER_USER_AGENT,
  createSafeFetcher,
  type ResolvedAddress,
  type SafeFetcher,
  type SafeFetcherDeps,
  type SafeFetchOptions,
  type SafeResponse,
  type Transport,
  UnsafeUrlError,
  type UnsafeUrlReason,
} from "./crawl/safe-fetch";
export { extractPage, type PageContent } from "./crawl/html";
export { parseRobots, robotsAllow, type RobotsRules } from "./crawl/robots";
export { createFrontier, isCrawlable, pageKey, pagePriority, sameSite } from "./crawl/frontier";
export {
  buildExtractionRequest,
  type ExtractedFact,
  extractFactsByRule,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionResult,
  quoteIsOnPage,
  readExtraction,
  verifyFacts,
} from "./crawl/extract";
export { storeWebsiteFacts, websiteKey } from "./crawl/store";
export {
  type CrawlJobDeps,
  createKnowledgeImportJob,
  KNOWLEDGE_IMPORT_JOB_ID,
  requestWebsiteCrawl,
} from "./crawl/job";
