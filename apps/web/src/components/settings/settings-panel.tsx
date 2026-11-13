import {
  addSettingEntryAction,
  removeSettingEntryAction,
  resetSettingAction,
  saveSettingAction,
} from "@/app/(admin)/_actions/settings";
import type { AdminSession, ScreenTarget } from "@/server/admin/settings-actions";
import { getAdminSettings } from "@/server/admin";

import { type SettingsActions, SettingsScreen } from "./settings-screen";

const ACTIONS: SettingsActions = {
  save: saveSettingAction,
  reset: resetSettingAction,
  addEntry: addSettingEntryAction,
  removeEntry: removeSettingEntryAction,
};

/**
 * The settings screen for one target, loaded on the server for the signed-in person (what
 * they may see and change is decided by the settings service), then handed to the browser
 * without the values of sensitive settings.
 */
export async function SettingsPanel({
  session,
  target,
  onlyKeys,
  initialCategory,
  actions,
}: {
  readonly session: AdminSession;
  readonly target: ScreenTarget;
  readonly onlyKeys?: readonly string[];
  readonly initialCategory?: string;
  readonly actions?: Partial<SettingsActions>;
}) {
  const view = await getAdminSettings().view(session, target);
  return (
    <SettingsScreen
      view={view}
      target={target}
      actions={{ ...ACTIONS, ...actions }}
      {...(onlyKeys === undefined ? {} : { onlyKeys })}
      {...(initialCategory === undefined ? {} : { initialCategory })}
    />
  );
}
