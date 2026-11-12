/**
 * @repo/leads (owner: C5)
 *
 * Lead scoring, the written lead report, routing decisions and the lead.* events.
 *
 * - `assessLead` (pure): criteria → score → band → routing decision → status, from the lead
 *   fields and one settings snapshot. `buildLeadReport` (pure): the written report.
 * - `leadActionHandlers`: the `update_lead_fields` and `mark_not_a_fit` handlers, registered
 *   in the pipeline's domain composition. `createLeadTurnObserver`: what happens when a turn
 *   commits. `loadLeadSnapshot`: the lead as the engine input sees it.
 * - The outbox (`lead_events`) and the `leads-outbox` cron (`createLeadJobs`).
 * - `leadRouting` and `withLeadScoring` for dry runs.
 *
 * Server only.
 */
export {
  type Adjustment,
  assessLead,
  bandFor,
  type LeadAssessment,
  type LeadFacts,
  MODEL_SIGNALS,
  observedSignals,
} from "./assess/assess";
export {
  type CriterionResult,
  type CriterionState,
  evaluateCriteria,
  type FitAction,
  type FitFinding,
} from "./assess/criteria";
export {
  type IncomingField,
  MAX_EVIDENCE_CHARACTERS,
  mergeFields,
  type MergeResult,
} from "./assess/merge";
export {
  type AreaCheck,
  type AreaVerdict,
  checkServiceArea,
  stateIn,
  zipIn,
} from "./assess/service-area";
export { buildLeadReport, type LeadReport, type ReportInput } from "./report/report";
export {
  leadActionHandlers,
  type LeadHandlerDeps,
  markNotAFitHandler,
  updateLeadFieldsHandler,
} from "./handlers";
export {
  type CommittedTurnFacts,
  createLeadTurnObserver,
  handoffTrigger,
  type LeadTurnObserver,
} from "./observer";
export { loadLeadSnapshot } from "./loader";
export { createLeadJobs, OUTBOX_FUNCTION_ID, OUTBOX_GRACE_MS } from "./jobs";
export {
  dispatchLeadEvents,
  leadEventJobId,
  leadEventRowIds,
  markLeadEventsEmitted,
  pendingLeadEvents,
  toJobEvents,
} from "./store/outbox";
export {
  assessAndSave,
  type LeadRecord,
  loadLatestDecision,
  loadLeadFields,
  lockLead,
  recordLeadEvent,
} from "./store/lead-store";
export { leadRouting, withLeadScoring } from "./dry-run";
