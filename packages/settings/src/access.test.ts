import { describe, expect, it } from "vitest";

import { ROLES, SETTING_SCOPES } from "@repo/core";

import {
  canEditSetting,
  clientPermissionAllows,
  isVisibleToClients,
  settingEditDenial,
  type SettingsEditor,
} from "./access";
import { SETTING_DEFINITIONS, SETTINGS } from "./registry";

const system: SettingsEditor = { kind: "system" };
const as = (role: (typeof ROLES)[number]): SettingsEditor => ({ kind: "user", role });

const anyScope = SETTINGS["routing.mode"]; // all scopes, not client-editable
const clientEditable = SETTINGS["persona.bot_name"]; // all scopes, client-editable
const businessOnly = SETTINGS["alerts.recipients"]; // business only, client-editable
const globalOnly = SETTINGS["limits.agency_daily_spend_usd"]; // global only

describe("who may edit what", () => {
  it("the system and agency admins edit at every scope the setting allows", () => {
    for (const editor of [system, as("agency_admin")]) {
      for (const scope of SETTING_SCOPES) {
        expect(settingEditDenial({ setting: anyScope, scope, editor })).toBeNull();
      }
      expect(canEditSetting({ setting: globalOnly, scope: "global", editor })).toBe(true);
      expect(settingEditDenial({ setting: globalOnly, scope: "business", editor })?.reason).toBe(
        "scope_not_allowed",
      );
      expect(settingEditDenial({ setting: businessOnly, scope: "segment", editor })?.reason).toBe(
        "scope_not_allowed",
      );
    }
  });

  it("agency members edit business settings only", () => {
    const editor = as("agency_member");
    expect(settingEditDenial({ setting: anyScope, scope: "business", editor })).toBeNull();
    expect(settingEditDenial({ setting: anyScope, scope: "segment", editor })?.reason).toBe(
      "admin_required",
    );
    expect(settingEditDenial({ setting: anyScope, scope: "global", editor })?.reason).toBe(
      "admin_required",
    );
  });

  it("client users edit only client-editable settings of their business, when allowed", () => {
    const owner = as("client_owner");
    const staff = as("client_staff");
    // The flag.
    expect(
      settingEditDenial({
        setting: anyScope,
        scope: "business",
        editor: owner,
        clientEditing: "owner",
      })?.reason,
    ).toBe("not_client_editable");
    expect(
      settingEditDenial({
        setting: clientEditable,
        scope: "business",
        editor: owner,
        clientEditing: "owner",
      }),
    ).toBeNull();
    // The scope.
    for (const scope of ["global", "segment"] as const) {
      expect(
        settingEditDenial({ setting: clientEditable, scope, editor: owner, clientEditing: "owner" })
          ?.reason,
      ).toBe("client_scope");
    }
    // The business's permission.
    const attempt = (
      editor: SettingsEditor,
      clientEditing?: "nobody" | "owner" | "owner_and_staff",
    ) =>
      settingEditDenial({ setting: clientEditable, scope: "business", editor, clientEditing })
        ?.reason ?? null;
    expect(attempt(owner, "nobody")).toBe("client_editing_off");
    expect(attempt(owner, "owner")).toBeNull();
    expect(attempt(owner, "owner_and_staff")).toBeNull();
    expect(attempt(staff, "nobody")).toBe("client_editing_off");
    expect(attempt(staff, "owner")).toBe("client_editing_off");
    expect(attempt(staff, "owner_and_staff")).toBeNull();
    // Unknown permission: refused.
    expect(attempt(owner, undefined)).toBe("client_editing_off");
  });

  it("the client-editable flag of every setting decides, for every setting", () => {
    for (const definition of SETTING_DEFINITIONS) {
      const allowed = canEditSetting({
        setting: definition,
        scope: "business",
        editor: as("client_owner"),
        clientEditing: "owner_and_staff",
      });
      expect(allowed, definition.key).toBe(
        definition.clientEditable && definition.scopes.includes("business"),
      );
      expect(isVisibleToClients(definition)).toBe(definition.clientEditable);
    }
  });

  it("a reset is allowed where a set is not, so a stray row can be removed", () => {
    const check = { setting: globalOnly, scope: "business", editor: as("agency_member") } as const;
    expect(settingEditDenial(check)?.reason).toBe("scope_not_allowed");
    expect(settingEditDenial({ ...check, operation: "reset" })).toBeNull();
    // Role rules still apply to a reset.
    expect(
      settingEditDenial({
        setting: anyScope,
        scope: "global",
        editor: as("agency_member"),
        operation: "reset",
      })?.reason,
    ).toBe("admin_required");
    expect(
      settingEditDenial({
        setting: anyScope,
        scope: "business",
        editor: as("client_owner"),
        clientEditing: "owner",
        operation: "reset",
      })?.reason,
    ).toBe("not_client_editable");
  });

  it("denials carry a message a person can read", () => {
    for (const role of ROLES) {
      for (const scope of SETTING_SCOPES) {
        const denial = settingEditDenial({ setting: businessOnly, scope, editor: as(role) });
        if (denial !== null) expect(denial.message.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("clientPermissionAllows", () => {
  it("narrows client users and never agency staff", () => {
    const table = [
      ["nobody", "agency_admin", true],
      ["nobody", "agency_member", true],
      ["nobody", "client_owner", false],
      ["nobody", "client_staff", false],
      ["owner", "client_owner", true],
      ["owner", "client_staff", false],
      ["owner_and_staff", "client_owner", true],
      ["owner_and_staff", "client_staff", true],
    ] as const;
    for (const [permission, role, expected] of table) {
      expect(clientPermissionAllows(permission, role), `${permission} ${role}`).toBe(expected);
    }
  });
});
