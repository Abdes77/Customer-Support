/**
 * @repo/settings (owner: C2)
 *
 * The settings engine: the registry where every setting is declared once, the resolver that
 * merges registry defaults, agency-wide ("global") overrides, segment defaults and business
 * overrides, and the rules for who may change what.
 *
 * This entry point is safe to import in a browser: it has no database and no Node imports,
 * so the admin panel can read the registry to draw its forms. Reading and writing stored
 * settings is in `@repo/settings/server`.
 *
 * - `SETTINGS`, `AppSettings`: the catalogue and the type of the resolved values.
 * - `resolveSettings(layers)`: the pure resolver. `settingsWith({...})` for tests and evals.
 * - `f`, `setting`, `defineCategory`: how a setting is declared (see `registry/`).
 * - docs/SETTINGS.md is generated from the registry by `pnpm settings:docs`.
 */

// The catalogue
export {
  type AppSettings,
  findSetting,
  getSetting,
  isSettingKey,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingKey,
  SETTINGS,
  settingsByCategory,
  settingsInCategory,
} from "./registry";
export {
  AFTER_HOURS_MODES,
  AI_DISCLOSURE_MODES,
  ALERT_EVENTS,
  type ClientPermission,
  CRITERION_LABELS,
  CRM_IDS,
  CRM_LABELS,
  type CrmId,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  type EffortLevel,
  EMERGENCY_SEVERITIES,
  HANDOFF_TRIGGERS,
  MODEL_TASKS,
  type ModelTask,
  PRICING_DISCLOSURE_MODES,
  QUALIFICATION_CRITERIA,
  type QualificationCriterion,
  SCHEDULING_PROVIDERS,
  SCORE_BANDS,
  SCORE_SIGNALS,
  type ScoreBand,
  SUGGESTED_MODELS,
} from "./registry";

// Declaring settings
export {
  ALL_SCOPES,
  BUSINESS_ONLY,
  CHANNEL_LABELS,
  CUSTOMER_CHANNELS,
  type CustomerChannel,
  defineCategory,
  GLOBAL_AND_BUSINESS,
  GLOBAL_ONLY,
  group,
  perChannel,
  setting,
  SETTING_CATEGORIES,
  type SettingCategory,
  type SettingCategoryId,
  type SettingDefinition,
  type SettingDraft,
  settingsChannelOf,
  type SettingSpec,
} from "./define";
export {
  type AnyField,
  blankValue,
  type BooleanField,
  type DailyWindow,
  describeField,
  f,
  type FieldKind,
  type FieldProblem,
  type FieldValue,
  type ListField,
  type MultiSelectField,
  type NullableField,
  type NumberField,
  type ObjectField,
  type ObjectProperty,
  renderTemplate,
  sameHoursOn,
  type SelectField,
  type SelectOption,
  templateVariablesIn,
  TEXT_FORMATS,
  type TextField,
  type TextFormat,
  type TimeInterval,
  US_STATE_CODES,
  walkField,
  type Weekday,
  WEEKDAYS,
  type WeeklyHours,
} from "./fields";
export { TEMPLATE_VARIABLES, type TemplateVariable } from "./templates";

export {
  SEGMENT_PRESET_IDS,
  SEGMENT_PRESETS,
  type SegmentPreset,
  segmentPresetFor,
  type SegmentPresetId,
} from "./presets";

// Resolving
export {
  type AppResolvedSettings,
  buildSettingsView,
  channelSetting,
  defaultSettings,
  resolveSettings,
  type SettingIssue,
  type SettingLayers,
  type SettingOverrideView,
  type SettingsView,
  type SettingsViewer,
  settingsWith,
  type SettingViewEntry,
  type StoredSetting,
} from "./resolve";
export {
  checkSettingValue,
  parseSettingValue,
  type SettingCheck,
  type SettingIssueReason,
  summarizeProblems,
} from "./validate";
export { canonicalJson, fingerprint, jsonEqual } from "./hash";

// Who may change what
export {
  canEditSetting,
  clientPermissionAllows,
  type EditCheck,
  type EditDenial,
  type EditDenialReason,
  isVisibleToClients,
  settingEditDenial,
  type SettingsEditor,
} from "./access";
export { describeTarget, ScopeTarget, SettingChange, SettingsUpdateRequest } from "./target";

// Documentation
export { renderSettingsDocs } from "./docs";
