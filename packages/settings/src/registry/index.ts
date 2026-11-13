import { type SettingCategoryId, type SettingDefinition, SETTING_CATEGORIES } from "../define";
import { alertsSettings } from "./alerts";
import { channelsSettings } from "./channels";
import { clientPortalSettings } from "./client-portal";
import { conversationSettings } from "./conversation";
import { dataSettings } from "./data";
import { emergencySettings } from "./emergency";
import { followUpSettings } from "./follow-up";
import { guardrailsSettings } from "./guardrails";
import { handoffSettings } from "./handoff";
import { hoursSettings } from "./hours";
import { integrationsSettings } from "./integrations";
import { knowledgeSettings } from "./knowledge";
import { limitsSettings } from "./limits";
import { modelSettings } from "./model";
import { personaSettings } from "./persona";
import { photosSettings } from "./photos";
import { pricingSettings } from "./pricing";
import { qualificationSettings } from "./qualification";
import { routingSettings } from "./routing";
import { schedulingSettings } from "./scheduling";
import { scoringSettings } from "./scoring";
import { voiceSettings } from "./voice";

/**
 * The registry: every setting of the product, declared once.
 *
 * To add a setting, add one entry to the file of its category (or a new file plus a
 * category in `../define.ts`), then run `pnpm settings:docs`. Nothing else needs to change:
 * the type `AppSettings`, the resolver, the store, the documentation and the settings
 * screen all read this object.
 *
 * The order here is the order of the categories on screen and in the documentation.
 */
export const SETTINGS = {
  ...qualificationSettings,
  ...scoringSettings,
  ...routingSettings,
  ...personaSettings,
  ...voiceSettings,
  ...pricingSettings,
  ...photosSettings,
  ...guardrailsSettings,
  ...conversationSettings,
  ...emergencySettings,
  ...hoursSettings,
  ...followUpSettings,
  ...handoffSettings,
  ...alertsSettings,
  ...schedulingSettings,
  ...channelsSettings,
  ...integrationsSettings,
  ...knowledgeSettings,
  ...clientPortalSettings,
  ...modelSettings,
  ...limitsSettings,
  ...dataSettings,
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** The value type of every setting: `AppSettings["persona.bot_name"]` is `string`. */
export type AppSettings = {
  [K in SettingKey]: (typeof SETTINGS)[K] extends SettingDefinition<infer T> ? T : never;
};

/** Every key, in registry order. */
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Every definition, in registry order. */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.values(SETTINGS);

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isSettingKey(key: string): key is SettingKey {
  return BY_KEY.has(key);
}

/** The definition of a setting, or undefined when the key is not declared. */
export function findSetting(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** The definition of a declared setting, with its value type. */
export function getSetting<K extends SettingKey>(key: K): SettingDefinition<AppSettings[K]> {
  return SETTINGS[key] as unknown as SettingDefinition<AppSettings[K]>;
}

/** The definitions of one category, in registry order. */
export function settingsInCategory(category: SettingCategoryId): readonly SettingDefinition[] {
  return SETTING_DEFINITIONS.filter((definition) => definition.category === category);
}

/** Categories that have at least one setting, each with its settings, in display order. */
export function settingsByCategory(): readonly {
  readonly category: (typeof SETTING_CATEGORIES)[number];
  readonly settings: readonly SettingDefinition[];
}[] {
  return SETTING_CATEGORIES.map((category) => ({
    category,
    settings: settingsInCategory(category.id),
  })).filter((entry) => entry.settings.length > 0);
}

export {
  QUALIFICATION_CRITERIA,
  type QualificationCriterion,
  CRITERION_LABELS,
} from "./qualification";
export { SCORE_BANDS, type ScoreBand, SCORE_SIGNALS } from "./scoring";
export { AI_DISCLOSURE_MODES } from "./persona";
export { PRICING_DISCLOSURE_MODES } from "./pricing";
export { EMERGENCY_SEVERITIES } from "./emergency";
export { AFTER_HOURS_MODES } from "./hours";
export { HANDOFF_TRIGGERS } from "./handoff";
export { ALERT_EVENTS } from "./alerts";
export { SCHEDULING_PROVIDERS } from "./scheduling";
export { CRM_IDS, type CrmId, CRM_LABELS } from "./integrations";
export { type ClientPermission } from "./client-portal";
export {
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_TASKS,
  type ModelTask,
  SUGGESTED_MODELS,
} from "./model";
