/**
 * @repo/settings/server: the half of the settings engine that talks to the database.
 * Server only. The registry, the types and the pure resolver are in `@repo/settings`.
 *
 * - Read settings for a turn: `createSettingsResolver({ db }).resolve({ agencyId, businessId })`,
 *   or `loadSettings(ctx, target)` inside a transaction you already hold.
 * - Change settings: `createSettingsService({ db }).updateForUser(user, { target, changes })`
 *   for a signed-in user; `applySettingChanges(ctx, { target, changes, actor })` for jobs.
 * - Draw the settings screen: `service.viewForUser(user, target)`.
 */
export {
  type AppSettingsResolver,
  type BusinessTarget,
  createSettingsResolver,
  loadSettings,
} from "./resolver";
export { CLIENT_PORTAL_ENABLED_KEY, type LoadedLayers, loadLayers, loadTargetFacts } from "./rows";
export {
  type AppliedChange,
  type ApplyChangesInput,
  type ApplyChangesResult,
  applySettingChanges,
  applySettingChangesAsUser,
  listSettingHistory,
  roleToward,
  type SettingChangeProblem,
  type SettingHistoryEntry,
  type SettingsActor,
} from "./store";
export { SettingsConflictError, SettingsPermissionError } from "./errors";
export { type AppliedPreset, applySegmentPreset } from "./presets";
export {
  createSettingsService,
  loadSettingsView,
  type SettingsService,
  type SettingsViewForUser,
} from "./service";
