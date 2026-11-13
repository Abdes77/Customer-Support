import type { Role, SettingScope } from "@repo/core";

import type { SettingDefinition } from "./define";
import type { ClientPermission } from "./registry";

/**
 * Who may change which setting where. The same rules run in the store (which enforces
 * them) and in the admin panel (which uses them to disable controls); row-level security
 * is the third line behind both.
 *
 * | Editor         | global | segment | business                                              |
 * | -------------- | ------ | ------- | ----------------------------------------------------- |
 * | system         | yes    | yes     | yes                                                   |
 * | agency_admin   | yes    | yes     | yes                                                   |
 * | agency_member  | no     | no      | yes                                                   |
 * | client_owner   | no     | no      | client-editable settings, if `client_portal.edit_settings` is "owner" or "owner_and_staff" |
 * | client_staff   | no     | no      | client-editable settings, if `client_portal.edit_settings` is "owner_and_staff"            |
 *
 * In every case the scope must be one the setting allows.
 */

/** Who is making a change: a job, an import or the seed ("system"), or a signed-in user. */
export type SettingsEditor =
  | { readonly kind: "system" }
  /** `role` is the user's role toward the target: their agency role, or their role in the business. */
  | { readonly kind: "user"; readonly role: Role };

export type EditDenialReason =
  | "scope_not_allowed"
  | "admin_required"
  | "client_scope"
  | "not_client_editable"
  | "client_editing_off";

export interface EditDenial {
  readonly reason: EditDenialReason;
  /** Safe to show to the person who tried. */
  readonly message: string;
}

/**
 * Whether a client permission (a `client_portal.*` setting) covers a role. Agency staff are
 * always covered: the permissions only narrow what client users get.
 */
export function clientPermissionAllows(permission: ClientPermission, role: Role): boolean {
  switch (role) {
    case "agency_admin":
    case "agency_member":
      return true;
    case "client_owner":
      return permission === "owner" || permission === "owner_and_staff";
    case "client_staff":
      return permission === "owner_and_staff";
  }
}

export interface EditCheck {
  readonly setting: Pick<SettingDefinition, "label" | "scopes" | "clientEditable">;
  readonly scope: SettingScope;
  readonly editor: SettingsEditor;
  /**
   * Default "set". A reset is allowed at a scope the setting does not allow, so that a row
   * left behind by an older version of the registry (or written behind the store's back)
   * can be removed.
   */
  readonly operation?: "set" | "reset";
  /**
   * The business's resolved `client_portal.edit_settings`. Needed only for client users;
   * when it is missing they are refused.
   */
  readonly clientEditing?: ClientPermission;
}

/** Null when the edit is allowed, otherwise why it is not. */
export function settingEditDenial(check: EditCheck): EditDenial | null {
  const { setting, scope, editor } = check;
  if (check.operation !== "reset" && !setting.scopes.includes(scope)) {
    return {
      reason: "scope_not_allowed",
      message: `"${setting.label}" cannot be set at the ${scope} level.`,
    };
  }
  if (editor.kind === "system" || editor.role === "agency_admin") return null;
  if (editor.role === "agency_member") {
    return scope === "business"
      ? null
      : {
          reason: "admin_required",
          message: "Only an agency admin can change agency-wide and segment settings.",
        };
  }
  if (scope !== "business") {
    return {
      reason: "client_scope",
      message: "You can only change settings of your own business.",
    };
  }
  if (!setting.clientEditable) {
    return {
      reason: "not_client_editable",
      message: `"${setting.label}" is managed by your agency.`,
    };
  }
  if (
    check.clientEditing === undefined ||
    !clientPermissionAllows(check.clientEditing, editor.role)
  ) {
    return {
      reason: "client_editing_off",
      message: "Your agency has not enabled settings changes for your login.",
    };
  }
  return null;
}

export function canEditSetting(check: EditCheck): boolean {
  return settingEditDenial(check) === null;
}

/** Client users see the settings they could edit and nothing else. */
export function isVisibleToClients(setting: Pick<SettingDefinition, "clientEditable">): boolean {
  return setting.clientEditable;
}
