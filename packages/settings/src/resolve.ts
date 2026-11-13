import {
  type ChannelId,
  type ResolvedSettings,
  SETTING_SCOPES,
  type SettingScope,
  type SettingSource,
  ValidationError,
} from "@repo/core";

import { type EditDenialReason, settingEditDenial, type SettingsEditor } from "./access";
import { type CustomerChannel, freezeValue, settingsChannelOf } from "./define";
import type { FieldProblem } from "./fields";
import { fingerprint } from "./hash";
import {
  type AppSettings,
  type ClientPermission,
  isSettingKey,
  SETTING_DEFINITIONS,
  type SettingKey,
} from "./registry";
import { checkSettingValue, type SettingIssueReason } from "./validate";

/**
 * The pure half of the resolver: no database, no clock, safe in a browser. The server half
 * (`@repo/settings/server`) reads the rows and calls this.
 */

/** One stored override, as read from `setting_values`. */
export interface StoredSetting {
  readonly key: string;
  readonly value: unknown;
  /** Version of the key in its scope. Null for overrides that were never stored (tests, evals). */
  readonly version: number | null;
  /** ISO 8601. */
  readonly updatedAt: string | null;
}

/** The overrides that apply to one business, by scope. A missing layer has no overrides. */
export type SettingLayers = Readonly<Partial<Record<SettingScope, readonly StoredSetting[]>>>;

/** A stored row that the resolver skipped, and why. */
export interface SettingIssue {
  readonly key: string;
  readonly scope: SettingScope;
  readonly reason: SettingIssueReason;
  /** Safe to show and to log: it names the setting and the rule, never the stored value. */
  readonly message: string;
  readonly problems: readonly FieldProblem[];
}

/** `ResolvedSettings` for this product, plus the stored rows that were skipped. */
export interface AppResolvedSettings extends ResolvedSettings<AppSettings> {
  readonly issues: readonly SettingIssue[];
}

const DEFAULT_SOURCE: SettingSource = Object.freeze({
  scope: "default",
  version: null,
  updatedAt: null,
});

/**
 * Resolves every setting from the registry defaults and the given overrides. Precedence,
 * later wins: default, global, segment, business.
 *
 * Stored rows are not trusted. A row is skipped, and reported in `issues`, when its key is
 * not declared, when the setting does not allow an override at that scope, or when the value
 * does not pass the setting's schema. A skipped row changes nothing: the value stays what the
 * layers below it say.
 */
export function resolveSettings(layers: SettingLayers = {}): AppResolvedSettings {
  const values: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  for (const definition of SETTING_DEFINITIONS) {
    values[definition.key] = definition.default;
    sources[definition.key] = DEFAULT_SOURCE;
  }

  const issues: SettingIssue[] = [];
  for (const scope of SETTING_SCOPES) {
    for (const row of layers[scope] ?? []) {
      const checked = checkSettingValue(row.key, row.value, scope);
      if (!checked.ok) {
        issues.push({
          key: row.key,
          scope,
          reason: checked.reason,
          message: checked.message,
          problems: checked.problems,
        });
        continue;
      }
      values[row.key] = freezeValue(checked.value);
      sources[row.key] = Object.freeze({
        scope,
        version: row.version,
        updatedAt: row.updatedAt,
      });
    }
  }

  return Object.freeze({
    values: Object.freeze(values) as unknown as Readonly<AppSettings>,
    sources: Object.freeze(sources),
    version: fingerprint(values),
    issues: Object.freeze(issues),
  });
}

/** The registry defaults, resolved: what a business gets when nothing is overridden. */
export function defaultSettings(): AppResolvedSettings {
  return resolveSettings();
}

/**
 * Resolved settings with the given values overridden, for tests, evaluation profiles and
 * previews. Unlike the resolver it is strict: an invalid override throws.
 *
 *   const settings = settingsWith({ "pricing.disclosure": "ranges", "voice.emoji": "never" });
 */
export function settingsWith(
  overrides: Partial<AppSettings>,
  scope: SettingScope = "business",
): AppResolvedSettings {
  const rows: StoredSetting[] = Object.entries(overrides).map(([key, value]) => ({
    key,
    value,
    version: null,
    updatedAt: null,
  }));
  const resolved = resolveSettings({ [scope]: rows });
  if (resolved.issues.length > 0) {
    throw new ValidationError(
      `Invalid settings: ${resolved.issues.map((issue) => issue.message).join(" ")}`,
      { details: { issues: resolved.issues } },
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------
// Per-channel settings
// ---------------------------------------------------------------------------------------

type PerChannelBase = {
  [K in SettingKey]: K extends `${infer Base}.${CustomerChannel}`
    ? `${Base}.whatsapp` extends SettingKey
      ? Base
      : never
    : never;
}[SettingKey];

/**
 * The value of a per-channel setting for a channel:
 * `channelSetting(values, "follow_up.max_nudges", "whatsapp")`. The test channel uses the
 * website chat's values.
 */
export function channelSetting<B extends PerChannelBase>(
  values: Readonly<AppSettings>,
  base: B,
  channel: ChannelId,
): AppSettings[`${B}.whatsapp` & SettingKey] {
  const key = `${base}.${settingsChannelOf(channel)}` as SettingKey;
  return values[key] as AppSettings[`${B}.whatsapp` & SettingKey];
}

// ---------------------------------------------------------------------------------------
// A scope as the settings screen shows it
// ---------------------------------------------------------------------------------------

export interface SettingOverrideView {
  /** The stored value, as stored. For an invalid override this is what needs fixing. */
  readonly value: unknown;
  readonly version: number | null;
  readonly updatedAt: string | null;
  /** False when the resolver skips this override; `problem` then says why. */
  readonly inForce: boolean;
  readonly problem: string | null;
}

export interface SettingViewEntry {
  readonly key: SettingKey;
  /** The value in force at this scope. */
  readonly value: unknown;
  readonly source: SettingSource;
  /** What the value would be without this scope's own override ("inherited"). */
  readonly inherited: { readonly value: unknown; readonly source: SettingSource };
  /** This scope's own override, or null when the value is inherited. */
  readonly override: SettingOverrideView | null;
  /** The viewer may set the setting at this scope. */
  readonly editable: boolean;
  /** Why not, when `editable` is false. */
  readonly denial: EditDenialReason | null;
  /** There is an override here and the viewer may remove it. */
  readonly resettable: boolean;
}

export interface SettingsView {
  readonly scope: SettingScope;
  /** One entry per setting the viewer may see, in registry order. */
  readonly entries: readonly SettingViewEntry[];
  /** Fingerprint of the values in force at this scope. */
  readonly version: string;
  /** Rows skipped in this scope or the scopes below it. */
  readonly issues: readonly SettingIssue[];
}

export interface SettingsViewer {
  readonly editor: SettingsEditor;
  /** The business's `client_portal.edit_settings`, when the viewer is a client user. */
  readonly clientEditing?: ClientPermission;
  /** Limit the view to these settings (client users see only what they may edit). */
  readonly only?: (key: SettingKey) => boolean;
}

/**
 * Everything the settings screen shows for one scope: for each setting the value in force,
 * where it comes from, what it would be without this scope's override, the override itself
 * and whether the viewer may change it.
 *
 * `layers` holds the rows of the scope and of the scopes below it: `{ global }` for the
 * agency-wide screen, `{ global, segment }` for a segment, all three for a business.
 */
export function buildSettingsView(
  scope: SettingScope,
  layers: SettingLayers,
  viewer: SettingsViewer,
): SettingsView {
  const position = SETTING_SCOPES.indexOf(scope);
  const upTo = (count: number): SettingLayers =>
    Object.fromEntries(SETTING_SCOPES.slice(0, count).map((layer) => [layer, layers[layer] ?? []]));
  const effective = resolveSettings(upTo(position + 1));
  const inherited = resolveSettings(upTo(position));
  const own = new Map((layers[scope] ?? []).map((row) => [row.key, row]));
  const ownIssues = new Map(
    effective.issues.filter((issue) => issue.scope === scope).map((issue) => [issue.key, issue]),
  );

  const entries: SettingViewEntry[] = [];
  for (const definition of SETTING_DEFINITIONS) {
    const key = definition.key as SettingKey;
    if (viewer.only !== undefined && !viewer.only(key)) continue;
    const row = own.get(key);
    const issue = ownIssues.get(key);
    const check = {
      setting: definition,
      scope,
      editor: viewer.editor,
      clientEditing: viewer.clientEditing,
    };
    const denial = settingEditDenial(check);
    entries.push({
      key,
      value: effective.values[key],
      source: effective.sources[key],
      inherited: { value: inherited.values[key], source: inherited.sources[key] },
      override:
        row === undefined
          ? null
          : {
              value: row.value,
              version: row.version,
              updatedAt: row.updatedAt,
              inForce: issue === undefined,
              problem: issue?.message ?? null,
            },
      editable: denial === null,
      denial: denial?.reason ?? null,
      resettable: row !== undefined && settingEditDenial({ ...check, operation: "reset" }) === null,
    });
  }
  const { only } = viewer;
  const issues =
    only === undefined
      ? effective.issues
      : effective.issues.filter((issue) => isSettingKey(issue.key) && only(issue.key));
  return { scope, entries, version: effective.version, issues };
}
