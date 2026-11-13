import type { SettingScope } from "@repo/core";
import {
  type EditDenialReason,
  findSetting,
  type SettingsView,
  type SettingViewEntry,
} from "@repo/settings";

import { maskEntry, type MaskedEntry, sensitiveSummary } from "./mask";

/*
 * The settings screen's view model: what the server sends to the browser for one scope.
 * Everything comes from `SettingsService.viewForUser` (C2); this only removes what must not
 * leave the server. A sensitive setting (the registry's `sensitive: true`: contact lists,
 * webhook addresses) travels as a summary and masked entries, never as its value.
 */

export type SourceScope = SettingScope | "default";

export interface SettingEntryView {
  readonly key: string;
  readonly sensitive: boolean;
  /** The value in force; null for a sensitive setting. */
  readonly value: unknown;
  /** Sensitive settings only: "Not set", "2 entries". */
  readonly summary: string | null;
  /** Sensitive lists only: each entry with masked details. */
  readonly entries: readonly MaskedEntry[] | null;
  readonly source: SourceScope;
  readonly inherited: {
    readonly value: unknown;
    readonly summary: string | null;
    readonly source: SourceScope;
  };
  /** This scope's own override, or null. Its value is shown only when it is not in force. */
  readonly override: {
    readonly version: number | null;
    readonly updatedAt: string | null;
    readonly inForce: boolean;
    readonly problem: string | null;
    readonly value: unknown;
  } | null;
  readonly editable: boolean;
  /** Why the setting cannot be changed here, in words. */
  readonly denial: string | null;
  readonly resettable: boolean;
}

export interface SettingsScreenView {
  readonly scope: SettingScope;
  readonly version: string;
  readonly entries: readonly SettingEntryView[];
  /** Stored overrides the resolver skipped (shown as a warning count). */
  readonly issueCount: number;
}

const DENIALS: Readonly<Record<EditDenialReason, string>> = {
  scope_not_allowed: "Cannot be set at this level.",
  admin_required: "Only an agency admin can change this here.",
  client_scope: "You can change settings of your own business only.",
  not_client_editable: "Managed by your agency.",
  client_editing_off: "Your agency has not enabled settings changes for your login.",
};

export function denialMessage(reason: EditDenialReason | null): string | null {
  return reason === null ? null : DENIALS[reason];
}

function entryView(entry: SettingViewEntry): SettingEntryView {
  const definition = findSetting(entry.key);
  const sensitive = definition?.sensitive ?? true;
  const item = definition?.field.kind === "list" ? definition.field.item : undefined;
  const override =
    entry.override === null
      ? null
      : {
          version: entry.override.version,
          updatedAt: entry.override.updatedAt,
          inForce: entry.override.inForce,
          problem: entry.override.problem,
          value: sensitive || entry.override.inForce ? null : entry.override.value,
        };
  if (!sensitive) {
    return {
      key: entry.key,
      sensitive: false,
      value: entry.value,
      summary: null,
      entries: null,
      source: entry.source.scope,
      inherited: {
        value: entry.inherited.value,
        summary: null,
        source: entry.inherited.source.scope,
      },
      override,
      editable: entry.editable,
      denial: denialMessage(entry.denial),
      resettable: entry.resettable,
    };
  }
  return {
    key: entry.key,
    sensitive: true,
    value: null,
    summary: sensitiveSummary(entry.value),
    entries: Array.isArray(entry.value)
      ? entry.value.map((value, index) => maskEntry(value, index, item))
      : null,
    source: entry.source.scope,
    inherited: {
      value: null,
      summary: sensitiveSummary(entry.inherited.value),
      source: entry.inherited.source.scope,
    },
    override,
    editable: entry.editable,
    denial: denialMessage(entry.denial),
    resettable: entry.resettable,
  };
}

/** The view for the browser. */
export function toScreenView(view: SettingsView): SettingsScreenView {
  return {
    scope: view.scope,
    version: view.version,
    entries: view.entries.map(entryView),
    issueCount: view.issues.length,
  };
}
