/**
 * @repo/evals (owner: C7)
 *
 * The evaluation harness: simulated customers play whole conversations against the real
 * engine in dry-run mode, code checks and a judge model grade them, and a run is compared
 * with a saved baseline. `pnpm eval` is the command; docs/ARCHITECTURE.md "As built (C7)"
 * is the map.
 *
 * - Scenarios: twelve personas × six trades (`allScenarios`, `selectScenarios`), each under
 *   a settings profile, with the expected routing computed by the product's own rules.
 * - Sandbox: `createEvalSandbox` (a throwaway database with the production domain
 *   composition on top). `runConversation` plays one scenario.
 * - Grading: `runChecks` (code), `createJudge` (model, strict tool), `gradeConversation`.
 * - Runs: `runEvaluation`, `createRunStore`, `summarizeRun`, the baseline and the verdict.
 * - Reports: `renderReport` (HTML), `renderSummaryMarkdown`.
 * - Calibration: `calibrateJudge` over hand-made conversations with known faults.
 *
 * Never imported by the app: it is a development and CI tool.
 */
export { main, USAGE, type CliDeps } from "./cli";

export {
  EVAL_BUSINESSES,
  EVAL_SEGMENTS,
  type EvalBusiness,
  type EvalSegment,
  evalBusiness,
} from "./fixtures/businesses";
export { evalPlaybook } from "./fixtures/playbooks";

export { allScenarios, EVAL_DATE, type ScenarioFilter, selectScenarios } from "./scenarios/matrix";
export { expectedRouting, fieldsFromTruth } from "./scenarios/oracle";
export { INJECTION_CODE, persona, PERSONAS } from "./scenarios/personas";
export { scenarioSettings, SETTINGS_PROFILES, settingsProfile } from "./scenarios/profiles";
export {
  EVAL_CHANNELS,
  type EvalChannel,
  type Expectations,
  type Persona,
  PERSONA_IDS,
  type PersonaId,
  PROFILE_IDS,
  type ProfileId,
  type Scenario,
  type SettingsProfile,
} from "./scenarios/types";

export { createEvalSandbox, type EvalSandbox, type SandboxBusiness } from "./sandbox/sandbox";

export { calibrateJudge, type CalibrationResult, probeProblems } from "./calibration/calibrate";
export { type JudgeProbe, judgeProbes } from "./calibration/probes";

export { type ConversationDeps, runConversation } from "./simulate/conversation";
export {
  createCustomerSimulator,
  CUSTOMER_PROMPT_VERSION,
  type CustomerMove,
  type CustomerSimulator,
  parseCustomerMove,
} from "./simulate/customer";
export {
  createStandInCustomerModel,
  STAND_IN_CUSTOMER_MODEL,
  standInMove,
} from "./simulate/stand-in-customer";
export type {
  BotEntry,
  CustomerEntry,
  EndReason,
  Transcript,
  TranscriptEntry,
  Usage,
} from "./simulate/transcript";

export { CHECK_IDS, type CheckGroup, type CheckResult, runChecks } from "./grade/checks";
export {
  createJudge,
  type Judge,
  judgeContext,
  type JudgeResult,
  judgeTool,
  quoteFound,
  settleAnswer,
  STAND_IN_JUDGE_MODEL,
} from "./grade/judge";
export {
  CRITERIA,
  type Criterion,
  CRITERION_TITLES,
  DEFAULT_THRESHOLDS,
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM_PROMPT,
  type Thresholds,
} from "./grade/rubric";
export { RULE_IDS, type RuleId, type RuleInForce, rulesInForce } from "./grade/rules";
export {
  type GradeFailure,
  gradeConversation,
  type RunMode,
  type ScenarioGrade,
} from "./grade/score";
export { createStandInJudgeModel } from "./grade/stand-in-judge";

export {
  type Baseline,
  BASELINE_FILE,
  BaselineError,
  baselineFrom,
  compareWithBaseline,
  type Comparison,
  loadBaseline,
  saveBaseline,
} from "./run/baseline";
export {
  DEFAULT_CUSTOMER_MODEL,
  DEFAULT_JUDGE_MODEL,
  type EvalModels,
  liveModels,
  mockModels,
} from "./run/models";
export { type FailureClass, withRetries } from "./run/retry";
export { runEvaluation, type RunEvaluationOptions } from "./run/runner";
export {
  createRunStore,
  type ErrorRow,
  type ResultRow,
  type RunManifest,
  type RunStore,
} from "./run/store";
export { type RunSummary, type ScenarioAggregate, summarizeRun } from "./run/summary";
export { decideVerdict, MOCK_NOTICE, type Verdict } from "./run/verdict";

export { renderReport } from "./report/html";
export { renderSummaryMarkdown } from "./report/markdown";
