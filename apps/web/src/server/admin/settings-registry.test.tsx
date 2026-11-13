import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@repo/core";
import { loadUserAccess, type UserIdentity } from "@repo/db";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";
import { findSetting } from "@repo/settings";
import { createSettingsService, SettingsPermissionError } from "@repo/settings/server";

import { SettingsScreen } from "@/components/settings/settings-screen";

import { createAdminSettings } from "./settings-actions";

/*
 * C15's "done when": a setting added to the registry appears on the settings screen with no
 * UI code change, and override and reset work at business scope. The setting is added the
 * way a later chunk would add one, to a category file of the registry (here through a mock
 * of `registry/data.ts`); nothing in the admin panel names it. Then the real settings
 * service, the admin panel's server actions and the screen component run on a database.
 */

const ADDED = "data.c15_archive_to_cold_storage";
const LABEL = "Archive old photos to cold storage";
const ADDED_DAYS = "data.c15_cold_storage_after_days";
const DAYS_LABEL = "Move photos to cold storage after";

vi.mock("../../../../../packages/settings/src/registry/data.ts", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  // Declared exactly as a later chunk would, with the registry's own helpers.
  const { defineCategory, setting } = await import("../../../../../packages/settings/src/define");
  const { f } = await import("../../../../../packages/settings/src/fields");
  const added = defineCategory("data", {
    "data.c15_archive_to_cold_storage": setting({
      label: "Archive old photos to cold storage",
      help: "Photos older than the retention period are moved to cheaper storage instead of being deleted.",
      field: f.boolean(),
      default: false,
    }),
    "data.c15_cold_storage_after_days": setting({
      label: "Move photos to cold storage after",
      help: "How old a photo is before it moves to cold storage.",
      field: f.integer({ min: 30, max: 3650, unit: "days" }),
      default: 180,
      clientEditable: true,
    }),
  });
  return {
    ...original,
    dataSettings: Object.freeze({
      ...(original["dataSettings"] as Record<string, unknown>),
      ...added,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/",
}));

let t: TestDatabase;
let world: World;

const sessionOf = async (user: UserIdentity) => ({
  user,
  access: await t.db.asUser(user).run((ctx) => loadUserAccess(ctx)),
});

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});
afterAll(async () => {
  await t.dispose();
});

describe("a setting added to the registry", () => {
  it("is declared (through the category file only)", () => {
    expect(findSetting(ADDED)?.label).toBe(LABEL);
    expect(findSetting(ADDED_DAYS)?.label).toBe(DAYS_LABEL);
  });

  it("appears on the settings screen, and override and reset work at business scope", async () => {
    const admin = createAdminSettings({ db: t.db, settings: createSettingsService({ db: t.db }) });
    const session = await sessionOf(world.users.aMember);
    const target = {
      scope: "business" as const,
      businessId: world.businesses.a1.tenant.businessId,
    };

    const before = await admin.view(session, target);
    const entry = before.entries.find((candidate) => candidate.key === ADDED);
    expect(entry).toMatchObject({
      value: false,
      source: "default",
      override: null,
      editable: true,
    });

    const fail = async () => ({ ok: false as const, error: "not called" });
    const actions = { save: fail, reset: fail, addEntry: fail, removeEntry: fail };
    const html = renderToStaticMarkup(
      <SettingsScreen view={before} target={target} actions={actions} initialCategory="data" />,
    );
    expect(html).toContain(LABEL);
    expect(html).toContain(`data-setting-key="${ADDED}"`);
    expect(html).toContain("Override");
    // Every setting of the category is on the screen, the new ones included, with its value.
    expect(html).toContain(DAYS_LABEL);
    expect(html).toContain(`data-setting-key="${ADDED_DAYS}"`);
    expect(html).toContain("180");
    for (const definition of before.entries.filter((candidate) =>
      candidate.key.startsWith("data."),
    )) {
      expect(html).toContain(`data-setting-key="${definition.key}"`);
    }

    await admin.save(session, { target, key: ADDED, value: true, expectedVersion: null });
    const overridden = await admin.view(session, target);
    const changed = overridden.entries.find((candidate) => candidate.key === ADDED)!;
    expect(changed).toMatchObject({
      value: true,
      source: "business",
      inherited: { value: false, source: "default" },
      resettable: true,
    });
    expect(changed.override?.version).toBe(1);
    const changedHtml = renderToStaticMarkup(
      <SettingsScreen view={overridden} target={target} actions={actions} initialCategory="data" />,
    );
    expect(changedHtml).toContain("Set here");
    expect(changedHtml).toContain("Reset to inherited");

    // Another business of the agency is not touched.
    const other = await admin.view(session, {
      scope: "business",
      businessId: world.businesses.a2.tenant.businessId,
    });
    expect(other.entries.find((candidate) => candidate.key === ADDED)?.value).toBe(false);

    // A stale form (expecting no override) is refused instead of overwriting.
    await expect(
      admin.save(session, { target, key: ADDED, value: false, expectedVersion: null }),
    ).rejects.toThrow(/changed/i);

    await admin.reset(session, { target, key: ADDED, expectedVersion: 1 });
    const reset = await admin.view(session, target);
    expect(reset.entries.find((candidate) => candidate.key === ADDED)).toMatchObject({
      value: false,
      source: "default",
      override: null,
    });
  });

  it("is not shown to or changed by client users, and no one reaches another agency's business", async () => {
    const admin = createAdminSettings({ db: t.db, settings: createSettingsService({ db: t.db }) });
    const target = {
      scope: "business" as const,
      businessId: world.businesses.a1.tenant.businessId,
    };

    const owner = await sessionOf(world.users.a1Owner);
    const clientView = await admin.view(owner, target);
    expect(clientView.entries.some((candidate) => candidate.key === ADDED)).toBe(false);
    // A new setting marked client-editable reaches the client's screen the same way.
    expect(clientView.entries.find((candidate) => candidate.key === ADDED_DAYS)).toMatchObject({
      value: 180,
    });
    await expect(
      admin.save(owner, { target, key: ADDED, value: true, expectedVersion: null }),
    ).rejects.toBeInstanceOf(SettingsPermissionError);

    const stranger = await sessionOf(world.users.bAdmin);
    await expect(admin.view(stranger, target)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      admin.save(stranger, { target, key: ADDED, value: true, expectedVersion: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Naming the other agency for the agency-wide screen does not help either.
    await expect(
      admin.view(stranger, { scope: "global", agencyId: world.agencies.a.agencyId }),
    ).rejects.toThrow();
  });

  it("adds and removes entries of a private list without sending it to the browser", async () => {
    const admin = createAdminSettings({ db: t.db, settings: createSettingsService({ db: t.db }) });
    const session = await sessionOf(world.users.aMember);
    const target = {
      scope: "business" as const,
      businessId: world.businesses.a2.tenant.businessId,
    };
    const key = "emergency.escalation_chain";
    await admin.addEntry(session, {
      target,
      key,
      entry: { name: "Dana", phone: "+1 512 555 0142", email: "", alert_by: ["sms"] },
      expectedVersion: null,
    });
    await admin.addEntry(session, {
      target,
      key,
      entry: { name: "Sam", phone: "+1 512 555 0199", email: "", alert_by: ["sms"] },
      expectedVersion: 1,
    });
    const view = await admin.view(session, target);
    const chain = view.entries.find((candidate) => candidate.key === key)!;
    expect(chain.entries?.map((item) => item.label)).toEqual(["Dana", "Sam"]);
    expect(JSON.stringify(view)).not.toContain("5125550142");

    // The server holds the values: the test alert reads one there.
    const { value } = await admin.entryAt(session, target, key, 1);
    expect(value).toMatchObject({ name: "Sam", phone: "+15125550199" });

    await admin.removeEntry(session, { target, key, index: 0, expectedVersion: 2 });
    const after = await admin.view(session, target);
    expect(
      after.entries.find((candidate) => candidate.key === key)?.entries?.map((item) => item.label),
    ).toEqual(["Sam"]);
    // A removal based on an old version is refused.
    await expect(
      admin.removeEntry(session, { target, key, index: 0, expectedVersion: 2 }),
    ).rejects.toThrow(/changed/i);
  });
});
