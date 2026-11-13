"use server";

import {
  AddEntryInput,
  RemoveEntryInput,
  ResetSettingInput,
  SaveSettingInput,
} from "@/server/admin/settings-actions";
import { type ActionResult, getAdminSettings, runAction } from "@/server/admin";
import { ActionError } from "@/server/admin/result";
import { type z } from "zod";

/*
 * The settings screen's server actions. Each one checks the request's origin and the
 * session (`runAction`), parses its input, and lets the settings store decide whether the
 * signed-in person may make the change: it validates, versions and audits it with that
 * person as the author.
 */

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ActionError("That change could not be read. Reload the page.");
  return parsed.data;
}

export async function saveSettingAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("settings.save", async (session) => {
    await getAdminSettings().save(session, parse(SaveSettingInput, input));
    return null;
  });
}

export async function resetSettingAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("settings.reset", async (session) => {
    await getAdminSettings().reset(session, parse(ResetSettingInput, input));
    return null;
  });
}

export async function addSettingEntryAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("settings.add_entry", async (session) => {
    await getAdminSettings().addEntry(session, parse(AddEntryInput, input));
    return null;
  });
}

export async function removeSettingEntryAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("settings.remove_entry", async (session) => {
    await getAdminSettings().removeEntry(session, parse(RemoveEntryInput, input));
    return null;
  });
}
