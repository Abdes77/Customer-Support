import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type AgencyId,
  AppError,
  type BusinessId,
  createLogger,
  type LogRecord,
  NotFoundError,
  type SegmentId,
  TenantAccessError,
  ValidationError,
} from "@repo/core";
import {
  and,
  auditLog,
  businesses,
  eq,
  loadUserAccess,
  segments,
  settingValues,
  settingVersions,
  sql,
} from "@repo/db";
import { DEMO, seedDemoData } from "@repo/db/seed";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";

import { defaultSettings, SEGMENT_PRESETS, SETTING_KEYS, SETTINGS } from "../index";
import type { ScopeTarget } from "../target";
import { seedDemoSettings } from "./demo";
import {
  applySegmentPreset,
  applySettingChanges,
  applySettingChangesAsUser,
  createSettingsResolver,
  createSettingsService,
  listSettingHistory,
  loadSettings,
  loadSettingsView,
  type SettingChangeProblem,
  SettingsConflictError,
  type SettingsService,
  SettingsPermissionError,
} from "./index";

/*
 * The settings engine against PostgreSQL, with row-level security in force: the resolver,
 * the store and the service, as every role of the test world (two agencies, four
 * businesses, one user per role; see @repo/db/testing).
 */

let t: TestDatabase;
let world: World;
let service: SettingsService;
let hvacSegmentId: SegmentId;

const SYSTEM = { type: "system", label: "test" } as const;

function globalOf(agency: "a" | "b"): ScopeTarget {
  return { scope: "global", agencyId: world.agencies[agency].agencyId };
}
function segmentOf(agency: "a" | "b", segmentId?: SegmentId): ScopeTarget {
  const { agencyId, segmentId: roofing } = world.agencies[agency];
  return { scope: "segment", agencyId, segmentId: segmentId ?? roofing };
}
function businessOf(key: "a1" | "a2" | "a3" | "b1"): ScopeTarget & { scope: "business" } {
  return { scope: "business", ...world.businesses[key].tenant };
}

/** Writes through the store in the agency's system scope: the arrange step of most tests. */
async function seed(target: ScopeTarget, values: Record<string, unknown>) {
  return t.db.forAgency(target.agencyId).run((ctx) =>
    applySettingChanges(ctx, {
      target,
      actor: SYSTEM,
      changes: Object.entries(values).map(([key, value]) => ({ key, value })),
    }),
  );
}

async function storedRows(target: ScopeTarget, key?: string) {
  const rows = await t.admin
    .select()
    .from(settingValues)
    .where(
      and(
        eq(settingValues.agencyId, target.agencyId),
        eq(settingValues.scope, target.scope),
        target.scope === "business" ? eq(settingValues.businessId, target.businessId) : undefined,
        target.scope === "segment" ? eq(settingValues.segmentId, target.segmentId) : undefined,
        key === undefined ? undefined : eq(settingValues.key, key),
      ),
    );
  return rows;
}

async function historyOf(target: ScopeTarget, key: string) {
  return t.db.forAgency(target.agencyId).run((ctx) => listSettingHistory(ctx, target, { key }));
}

async function auditOf(agencyId: AgencyId, key: string) {
  const rows = await t.admin
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.agencyId, agencyId), eq(auditLog.targetId, key)));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail, and it succeeded.");
}

function problemsOf(error: unknown): SettingChangeProblem[] {
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).details["problems"] as SettingChangeProblem[];
}

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  service = createSettingsService({ db: t.db });
  // A second segment in agency A, with business a2 in it.
  const [hvac] = await t.admin
    .insert(segments)
    .values({ agencyId: world.agencies.a.agencyId, slug: "hvac", name: "HVAC" })
    .returning({ id: segments.id });
  hvacSegmentId = hvac!.id;
  await t.admin
    .update(businesses)
    .set({ segmentId: hvacSegmentId })
    .where(eq(businesses.id, world.businesses.a2.tenant.businessId));
});

afterAll(async () => {
  await t?.dispose();
});

beforeEach(async () => {
  // The world puts one row with a made-up key in every scope; each test starts without
  // overrides, history or audit entries. (Only this unrestricted test handle can delete the
  // last two: no role of the product can.)
  await t.admin.delete(settingValues);
  await t.admin.delete(settingVersions);
  await t.admin.delete(auditLog);
  await t.admin
    .update(businesses)
    .set({ clientPortalEnabled: true })
    .where(eq(businesses.id, world.businesses.a1.tenant.businessId));
});

describe("resolver", () => {
  it("resolves the registry defaults for a business without overrides", async () => {
    const resolver = createSettingsResolver({ db: t.db });
    const resolved = await resolver.resolve(world.businesses.a3.tenant);
    expect(resolved.values).toEqual(defaultSettings().values);
    expect(resolved.version).toBe(defaultSettings().version);
    expect(resolved.issues).toEqual([]);
    expect(Object.keys(resolved.sources)).toEqual(SETTING_KEYS);
  });

  it("merges global, then the business's segment, then the business", async () => {
    await seed(globalOf("a"), {
      "voice.tone": "professional",
      "voice.emoji": "never",
      "persona.bot_name": "Sam",
    });
    await seed(segmentOf("a"), { "voice.tone": "empathetic", "voice.emoji": "freely" });
    await seed(segmentOf("a", hvacSegmentId), { "voice.tone": "upbeat" });
    await seed(businessOf("a1"), { "voice.tone": "direct" });

    const a1 = await service.resolve(world.businesses.a1.tenant);
    expect(a1.values["voice.tone"]).toBe("direct");
    expect(a1.sources["voice.tone"]).toMatchObject({ scope: "business", version: 1 });
    expect(a1.sources["voice.tone"].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(a1.values["voice.emoji"]).toBe("freely");
    expect(a1.sources["voice.emoji"].scope).toBe("segment");
    expect(a1.values["persona.bot_name"]).toBe("Sam");
    expect(a1.sources["persona.bot_name"].scope).toBe("global");
    expect(a1.sources["voice.humor"].scope).toBe("default");

    // Same agency, same segment, no business override.
    const a3 = await service.resolve(world.businesses.a3.tenant);
    expect(a3.values["voice.tone"]).toBe("empathetic");
    // Same agency, other segment: the roofing defaults do not apply.
    const a2 = await service.resolve(world.businesses.a2.tenant);
    expect(a2.values["voice.tone"]).toBe("upbeat");
    expect(a2.values["voice.emoji"]).toBe("never");
    // Another agency sees none of it.
    const b1 = await service.resolve(world.businesses.b1.tenant);
    expect(b1.values["voice.tone"]).toBe("friendly");
    expect(b1.values["persona.bot_name"]).toBe("Alex");
    expect(b1.version).not.toBe(a1.version);
  });

  it("stores and reads every kind of JSON value unchanged", async () => {
    const hours = {
      ...SETTINGS["hours.weekly"].default,
      saturday: [{ open: "09:00", close: "13:00" }],
    };
    const values = {
      "persona.bot_name": 'Jo "the fixer" O\'Neil',
      "qualification.budget.weight": 35,
      "scoring.minimum_confidence": 0.75,
      "photos.analysis_enabled": false,
      "handoff.auto_release_minutes": null,
      "voice.banned_phrases": ["cheap", "unfortunately"],
      "scoring.thresholds": { hot: 85, warm: 55 },
      "hours.weekly": hours,
    };
    await seed(businessOf("a1"), values);
    const resolved = await service.resolve(world.businesses.a1.tenant);
    for (const [key, value] of Object.entries(values)) {
      expect(resolved.values[key as keyof typeof resolved.values], key).toEqual(value);
      expect(resolved.sources[key as keyof typeof resolved.sources].scope, key).toBe("business");
    }
    // The explicit null is an override, not an absent row.
    const [row] = await storedRows(businessOf("a1"), "handoff.auto_release_minutes");
    expect(row).toMatchObject({ value: null, version: 1 });
  });

  it("text that looks like JSON stays text", async () => {
    // Before `connect()` in @repo/db left the jsonb parse to Drizzle alone, a stored string
    // was parsed twice and each of these came back as a number, a boolean, null, an array or
    // an object (docs/ARCHITECTURE.md §8).
    const target = businessOf("a1");
    const admin = world.users.aAdmin;
    const cases: [string, string][] = [
      ["qualification.service_area.center_zip", "55408"],
      ["persona.bot_name", "true"],
      ["persona.role_title", "null"],
      ["routing.contact_later_timeframe", "24"],
      ["voice.style_notes", '{"tone": "dry"}'],
      ["voice.closing_message", "[1, 2]"],
      ["pricing.disclaimer", '"Prices are estimates."'],
    ];
    const changes = cases.map(([key, value]) => ({ key, value }));
    const first = await service.updateForUser(admin, { target, changes });
    expect(first.applied.every((change) => change.operation === "set")).toBe(true);

    const resolved = await service.resolve(world.businesses.a1.tenant);
    expect(resolved.issues).toEqual([]);
    for (const [key, value] of cases) {
      expect(resolved.values[key as keyof typeof resolved.values], key).toBe(value);
      expect(resolved.sources[key as keyof typeof resolved.sources].scope, key).toBe("business");
    }
    // The store compares with what is stored: saving the same form again changes nothing.
    const again = await service.updateForUser(admin, { target, changes });
    expect(again.applied.every((change) => change.operation === "unchanged")).toBe(true);
    // History and the settings screen show the same text.
    const [entry] = await historyOf(target, "qualification.service_area.center_zip");
    expect(entry?.value).toBe("55408");
    await service.updateForUser(admin, {
      target,
      changes: [{ key: "persona.bot_name", value: "false" }],
    });
    const [renamed] = await historyOf(target, "persona.bot_name");
    expect(renamed).toMatchObject({ value: "false", previousValue: "true" });
    const view = await service.viewForUser(admin, target);
    expect(view.entries.find((e) => e.key === "persona.role_title")?.override?.value).toBe("null");
  });

  it("ignores rows written behind the store's back, and says so", async () => {
    await seed(globalOf("a"), { "voice.tone": "professional" });
    // What Supabase's REST API lets a member of staff do: write business-level rows directly.
    const { a1 } = world.businesses;
    await t.db.asUser(world.users.aMember).run(async ({ tx }) => {
      const rows = [
        { key: "voice.tone", value: "SHOUTING" }, // not an option
        { key: "pricing.disclosure", value: { anything: true } }, // wrong type
        { key: "limits.agency_daily_spend_usd", value: 1_000_000 }, // global-only setting
        { key: "model.reply.model", value: "some-other-model" }, // not a Claude model
        { key: "voice.volume", value: 11 }, // no such setting
        { key: "voice.emoji", value: "never" }, // fine
      ];
      await tx
        .insert(settingValues)
        .values(rows.map((row) => ({ ...a1.tenant, scope: "business" as const, ...row })));
    });

    const records: LogRecord[] = [];
    const resolver = createSettingsResolver({
      db: t.db,
      logger: createLogger({ sink: (record) => records.push(record) }),
    });
    const resolved = await resolver.resolve(a1.tenant);

    expect(resolved.values["voice.tone"]).toBe("professional"); // falls back to the global value
    expect(resolved.sources["voice.tone"].scope).toBe("global");
    expect(resolved.values["pricing.disclosure"]).toBe("never");
    expect(resolved.values["limits.agency_daily_spend_usd"]).toBeNull();
    expect(resolved.values["model.reply.model"]).toBe("claude-fable-5-2");
    expect(resolved.values["voice.emoji"]).toBe("never");
    expect(resolved.sources["voice.emoji"].scope).toBe("business");
    expect(resolved.issues.map(({ key, reason }) => `${key}: ${reason}`).sort()).toEqual([
      "limits.agency_daily_spend_usd: scope_not_allowed",
      "model.reply.model: invalid_value",
      "pricing.disclosure: invalid_value",
      "voice.tone: invalid_value",
      "voice.volume: unknown_key",
    ]);

    // Logged once, by key and reason; the stored values stay out of the log.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: "warn", msg: "settings.rows_skipped" });
    const logged = JSON.stringify(records[0]);
    expect(logged).toContain("voice.volume");
    expect(logged).not.toContain("SHOUTING");
    expect(logged).not.toContain("some-other-model");
  });

  it("refuses a business of another agency and an unknown business", async () => {
    const { a1, b1 } = world.businesses;
    await expect(
      service.resolve({ agencyId: b1.tenant.agencyId, businessId: a1.tenant.businessId }),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      service.resolve({
        agencyId: a1.tenant.agencyId,
        businessId: "0c9f3d1e-52a7-4c1b-9e7a-6f1d2b3c4d5e" as BusinessId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves inside a transaction the caller already holds, as staff or as the system", async () => {
    await seed(businessOf("a1"), { "voice.tone": "direct" });
    const { tenant } = world.businesses.a1;
    const asStaff = await t.db.asUser(world.users.aMember).run((ctx) => loadSettings(ctx, tenant));
    const asSystem = await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => loadSettings(ctx, tenant));
    expect(asStaff.values["voice.tone"]).toBe("direct");
    expect(asSystem.version).toBe(asStaff.version);
    // Staff of another agency are refused.
    await expect(
      t.db.asUser(world.users.bAdmin).run((ctx) => loadSettings(ctx, tenant)),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    // So is a client user: row-level security hides the setting rows from them, and reading
    // in their context would quietly return the defaults instead of the business's settings.
    await expect(
      t.db.asUser(world.users.a1Owner).run((ctx) => loadSettings(ctx, tenant)),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
  });

  it("reports the client-login switch from the business's column", async () => {
    const on = await service.resolve(world.businesses.a1.tenant);
    expect(on.values["client_portal.enabled"]).toBe(true);
    expect(on.sources["client_portal.enabled"]).toEqual({
      scope: "business",
      version: null,
      updatedAt: null,
    });
    const off = await service.resolve(world.businesses.a3.tenant);
    expect(off.values["client_portal.enabled"]).toBe(false);
    expect(off.sources["client_portal.enabled"].scope).toBe("default");
    // A stray row cannot contradict the column.
    await t.admin.insert(settingValues).values({
      ...world.businesses.a3.tenant,
      scope: "business",
      key: "client_portal.enabled",
      value: true,
    });
    const stillOff = await service.resolve(world.businesses.a3.tenant);
    expect(stillOff.values["client_portal.enabled"]).toBe(false);
  });
});

describe("store: writes by agency staff", () => {
  it("validates, versions, records history under the user's name and audits", async () => {
    const target = businessOf("a1");
    const member = world.users.aMember;
    const first = await service.updateForUser(member, {
      target,
      changes: [{ key: "persona.bot_name", value: "  Riley  " }],
      note: "Owner asked for a new name",
    });
    expect(first.applied).toEqual([{ key: "persona.bot_name", operation: "set", version: 1 }]);

    const [row] = await storedRows(target, "persona.bot_name");
    expect(row).toMatchObject({ value: "Riley", version: 1, updatedBy: member.id }); // tidied

    const second = await service.updateForUser(member, {
      target,
      changes: [{ key: "persona.bot_name", value: "Jordan" }],
    });
    expect(second.applied[0]).toMatchObject({ operation: "set", version: 2 });

    const history = await historyOf(target, "persona.bot_name");
    expect(
      history.map(({ version, operation, value, previousValue, changedBy, note }) => ({
        version,
        operation,
        value,
        previousValue,
        changedBy,
        note,
      })),
    ).toEqual([
      {
        version: 2,
        operation: "set",
        value: "Jordan",
        previousValue: "Riley",
        changedBy: member.id,
        note: null,
      },
      {
        version: 1,
        operation: "set",
        value: "Riley",
        previousValue: null,
        changedBy: member.id,
        note: "Owner asked for a new name",
      },
    ]);

    const audit = await auditOf(target.agencyId, "persona.bot_name");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      businessId: target.businessId,
      actorType: "user",
      actorUserId: member.id,
      action: "settings.set",
      targetType: "setting",
      summary: 'Changed "Bot name" for the business.',
      before: null,
      after: "Riley",
      metadata: { scope: "business", version: 1, note: "Owner asked for a new name" },
    });
    expect(audit[1]).toMatchObject({ before: "Riley", after: "Jordan" });

    const resolved = await service.resolve(world.businesses.a1.tenant);
    expect(resolved.sources["persona.bot_name"]).toMatchObject({ scope: "business", version: 2 });
  });

  it("writes nothing when the value is already in force", async () => {
    const target = businessOf("a2");
    await service.updateForUser(world.users.aMember, {
      target,
      changes: [{ key: "qualification.contact_details", value: ["phone", "name", "email"] }],
    });
    const again = await service.updateForUser(world.users.aAdmin, {
      target,
      // The same set in another order is the same value.
      changes: [{ key: "qualification.contact_details", value: ["email", "name", "phone"] }],
    });
    expect(again.applied).toEqual([
      { key: "qualification.contact_details", operation: "unchanged", version: 1 },
    ]);
    expect(await historyOf(target, "qualification.contact_details")).toHaveLength(1);
    expect(await auditOf(target.agencyId, "qualification.contact_details")).toHaveLength(1);
  });

  it("a reset removes the override, is recorded, and versions keep counting", async () => {
    const target = businessOf("a1");
    const admin = world.users.aAdmin;
    const key = "voice.reading_level";
    await service.updateForUser(admin, { target, changes: [{ key, value: "simple" }] });
    const reset = await service.updateForUser(admin, { target, changes: [{ key, reset: true }] });
    expect(reset.applied).toEqual([{ key, operation: "reset", version: 2 }]);
    expect(await storedRows(target, key)).toEqual([]);
    const resolved = await service.resolve(world.businesses.a1.tenant);
    expect(resolved.values[key]).toBe("standard");
    expect(resolved.sources[key].scope).toBe("default");

    // Resetting what is not overridden changes nothing.
    const noop = await service.updateForUser(admin, { target, changes: [{ key, reset: true }] });
    expect(noop.applied).toEqual([{ key, operation: "unchanged", version: 2 }]);

    const again = await service.updateForUser(admin, {
      target,
      changes: [{ key, value: "advanced" }],
    });
    expect(again.applied).toEqual([{ key, operation: "set", version: 3 }]);
    const history = await historyOf(target, key);
    expect(
      history.map((entry) => [entry.version, entry.operation, entry.value, entry.previousValue]),
    ).toEqual([
      [3, "set", "advanced", null],
      [2, "reset", null, "simple"],
      [1, "set", "simple", null],
    ]);
    const audit = await auditOf(target.agencyId, key);
    expect(audit.map((entry) => entry.action)).toEqual([
      "settings.set",
      "settings.reset",
      "settings.set",
    ]);
  });

  it("is all or nothing: one bad change rejects the whole call, with a problem per change", async () => {
    const target = businessOf("a1");
    const error = await failure(
      service.updateForUser(world.users.aAdmin, {
        target,
        changes: [
          { key: "voice.humor", value: "light" }, // valid
          { key: "voice.tone", value: "loud" },
          { key: "scoring.thresholds", value: { hot: 20, warm: 60 } },
          { key: "limits.agency_daily_spend_usd", value: 100 }, // global only
          { key: "voice.volume", value: 11 },
        ],
      }),
    );
    const problems = problemsOf(error);
    expect(problems.map(({ key, reason }) => `${key}: ${reason}`)).toEqual([
      "voice.tone: invalid_value",
      "scoring.thresholds: invalid_value",
      "limits.agency_daily_spend_usd: scope_not_allowed",
      "voice.volume: unknown_key",
    ]);
    expect(problems[1]?.problems).toEqual([
      { path: ["hot"], message: "The hot threshold must be above the warm threshold." },
    ]);
    expect((error as ValidationError).message).toBe(
      "4 settings could not be saved. Nothing was changed.",
    );
    expect(await storedRows(target)).toEqual([]);
    expect(await historyOf(target, "voice.humor")).toEqual([]);
  });

  it("refuses a setting listed twice and an empty or oversized note", async () => {
    const target = businessOf("a1");
    await expect(
      service.updateForUser(world.users.aAdmin, {
        target,
        changes: [
          { key: "voice.humor", value: "light" },
          { key: "voice.humor", reset: true },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.updateForUser(world.users.aAdmin, {
        target,
        changes: [{ key: "voice.humor", value: "light" }],
        note: "x".repeat(501),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // NUL cannot be stored in text or jsonb: a validation error, not a database error.
    for (const change of [
      { changes: [{ key: "persona.bot_name", value: "Ri\u0000ley" }] },
      { changes: [{ key: "voice.humor", value: "light" }], note: "a\u0000b" },
      { changes: [{ key: "no.such\u0000key", reset: true as const }] },
    ]) {
      await expect(
        service.updateForUser(world.users.aAdmin, { target, ...change }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(
      (await service.updateForUser(world.users.aAdmin, { target, changes: [] })).applied,
    ).toEqual([]);
  });

  it("global and segment settings need an agency admin", async () => {
    for (const target of [globalOf("a"), segmentOf("a")]) {
      const error = await failure(
        service.updateForUser(world.users.aMember, {
          target,
          changes: [{ key: "voice.tone", value: "direct" }],
        }),
      );
      expect(error).toBeInstanceOf(SettingsPermissionError);
      expect((error as SettingsPermissionError).details).toMatchObject({
        reason: "admin_required",
      });
      expect(await storedRows(target)).toEqual([]);

      const ok = await service.updateForUser(world.users.aAdmin, {
        target,
        changes: [{ key: "voice.tone", value: "direct" }],
      });
      expect(ok.applied[0]?.operation).toBe("set");
      const [row] = await storedRows(target, "voice.tone");
      expect(row).toMatchObject({ value: "direct", updatedBy: world.users.aAdmin.id });
    }
    // The audit entry of an agency-level change has no business.
    const audit = await auditOf(world.agencies.a.agencyId, "voice.tone");
    expect(audit.filter((entry) => entry.businessId === null).length).toBeGreaterThanOrEqual(2);
  });

  it("staff of one agency cannot touch another agency's settings", async () => {
    for (const target of [businessOf("a1"), globalOf("a"), segmentOf("a")]) {
      await expect(
        service.updateForUser(world.users.bAdmin, {
          target,
          changes: [{ key: "voice.tone", value: "direct" }],
        }),
      ).rejects.toBeInstanceOf(TenantAccessError);
      await expect(service.viewForUser(world.users.bAdmin, target)).rejects.toBeInstanceOf(
        TenantAccessError,
      );
      await expect(service.historyForUser(world.users.bAdmin, target)).rejects.toBeInstanceOf(
        TenantAccessError,
      );
    }
    // A target that mixes agencies: the business of A under the agency of B.
    const mixed: ScopeTarget = {
      scope: "business",
      agencyId: world.agencies.b.agencyId,
      businessId: world.businesses.a1.tenant.businessId,
    };
    await expect(
      service.updateForUser(world.users.bAdmin, {
        target: mixed,
        changes: [{ key: "voice.tone", value: "direct" }],
      }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.updateForUser(world.users.aAdmin, {
        target: mixed,
        changes: [{ key: "voice.tone", value: "direct" }],
      }),
    ).rejects.toBeInstanceOf(AppError);
    // A segment of another agency.
    const foreignSegment: ScopeTarget = {
      scope: "segment",
      agencyId: world.agencies.a.agencyId,
      segmentId: world.agencies.b.segmentId,
    };
    await expect(
      service.updateForUser(world.users.aAdmin, {
        target: foreignSegment,
        changes: [{ key: "voice.tone", value: "direct" }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await t.admin.select().from(settingValues)).toEqual([]);
  });

  it("someone without a membership gets nothing", async () => {
    await expect(
      service.updateForUser(world.users.outsider, {
        target: businessOf("a1"),
        changes: [{ key: "persona.bot_name", value: "Mallory" }],
      }),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    await expect(service.viewForUser(world.users.outsider, globalOf("a"))).rejects.toBeInstanceOf(
      SettingsPermissionError,
    );
  });

  it("refuses a stale form with a conflict (expectedVersion)", async () => {
    const target = businessOf("a1");
    const key = "voice.use_customer_name";
    const admin = world.users.aAdmin;
    // The form was drawn when there was no override.
    await service.updateForUser(admin, {
      target,
      changes: [{ key, value: "often", expectedVersion: null }],
    });
    const stale = await failure(
      service.updateForUser(world.users.aMember, {
        target,
        changes: [{ key, value: "never", expectedVersion: null }],
      }),
    );
    expect(stale).toBeInstanceOf(SettingsConflictError);
    expect((stale as SettingsConflictError).code).toBe("conflict");
    const [row] = await storedRows(target, key);
    expect(row?.value).toBe("often");
    // With the current version it goes through.
    const ok = await service.updateForUser(world.users.aMember, {
      target,
      changes: [{ key, value: "never", expectedVersion: 1 }],
    });
    expect(ok.applied[0]).toMatchObject({ operation: "set", version: 2 });
  });

  it("two people saving the same setting at once both succeed, one after the other", async () => {
    const target = businessOf("a2");
    const key = "voice.max_messages_per_turn";
    const results = await Promise.all(
      [1, 2, 3, 1, 2, 3].map((value, index) =>
        service.updateForUser(index % 2 === 0 ? world.users.aAdmin : world.users.aMember, {
          target,
          changes: [{ key, value }],
        }),
      ),
    );
    const history = await historyOf(target, key);
    const written = results.filter((result) => result.applied[0]?.operation === "set").length;
    expect(history).toHaveLength(written);
    expect(history.map((entry) => entry.version).sort()).toEqual(
      Array.from({ length: written }, (_, index) => index + 1),
    );
    const [row] = await storedRows(target, key);
    expect(row?.version).toBe(written);
    expect(row?.value).toBe(history[0]?.value);
    expect(history.map((entry) => entry.version)).toEqual(
      Array.from({ length: written }, (_, index) => written - index),
    );
  });

  it("lists history newest version first when a writer that started earlier saved later", async () => {
    // The race behind concurrent saves, made deterministic: transaction `slow` begins first,
    // then waits while another save commits version 1, then writes version 2. Its
    // transaction began before version 1 was written, so `now()` is older there.
    const target = businessOf("a2");
    const key = "voice.max_messages_per_turn";
    let markBegun!: () => void;
    const begun = new Promise<void>((resolve) => (markBegun = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slow = t.db.forAgency(target.agencyId).run(async (ctx) => {
      await ctx.tx.execute(sql`select 1`);
      markBegun();
      await released;
      return applySettingChanges(ctx, { target, actor: SYSTEM, changes: [{ key, value: 3 }] });
    });
    await begun;
    expect((await seed(target, { [key]: 2 })).applied[0]?.version).toBe(1);
    release();
    expect((await slow).applied[0]?.version).toBe(2);

    const history = await historyOf(target, key);
    expect(history.map((entry) => [entry.version, entry.value, entry.previousValue])).toEqual([
      [2, 3, 2],
      [1, 2, null],
    ]);
    // The recorded time is when the change was written, so it agrees with the order.
    expect(Date.parse(history[0]!.changedAt)).toBeGreaterThan(Date.parse(history[1]!.changedAt));
    const all = await t.db.forAgency(target.agencyId).run((ctx) => listSettingHistory(ctx, target));
    expect(all.map((entry) => entry.version)).toEqual([2, 1]);
    // The stored value and its source agree with the newest entry.
    const [row] = await storedRows(target, key);
    expect(row).toMatchObject({ value: 3, version: 2 });
    expect(row?.updatedAt.toISOString()).toBe(history[0]?.changedAt);
  });

  it("records that a sensitive setting changed, not what it changed to", async () => {
    const target = businessOf("a1");
    const recipients = [
      {
        name: "Dana Whitfield",
        email: "dana@summit.test",
        phone: "(512) 555-0142",
        channels: ["sms", "email"],
        events: [],
        active: true,
      },
    ];
    await service.updateForUser(world.users.aMember, {
      target,
      changes: [{ key: "alerts.recipients", value: recipients }],
    });
    const [audit] = await auditOf(target.agencyId, "alerts.recipients");
    expect(JSON.stringify(audit)).not.toContain("dana@summit.test");
    expect(JSON.stringify(audit)).not.toContain("5125550142");
    expect(audit).toMatchObject({
      action: "settings.set",
      summary: 'Changed "Alert recipients" for the business.',
    });
    // The value itself is stored (tidied) and kept in the history, which only staff can read.
    const resolved = await service.resolve(world.businesses.a1.tenant);
    expect(resolved.values["alerts.recipients"][0]).toMatchObject({
      phone: "+15125550142",
      channels: ["email", "sms"],
    });
    const [entry] = await historyOf(target, "alerts.recipients");
    expect(JSON.stringify(entry?.value)).toContain("dana@summit.test");
  });

  it("lets staff remove a stray row: an unknown key, or a setting at a scope it does not allow", async () => {
    const target = businessOf("a1");
    await t.admin.insert(settingValues).values([
      { ...world.businesses.a1.tenant, scope: "business", key: "voice.volume", value: 11 },
      {
        ...world.businesses.a1.tenant,
        scope: "business",
        key: "data.audit_log_retention_days",
        value: 90,
      },
    ]);
    const view = await service.viewForUser(world.users.aMember, target);
    expect(view.issues.map((issue) => issue.key).sort()).toEqual([
      "data.audit_log_retention_days",
      "voice.volume",
    ]);
    const stray = view.entries.find((entry) => entry.key === "data.audit_log_retention_days");
    expect(stray).toMatchObject({
      editable: false,
      denial: "scope_not_allowed",
      resettable: true,
      override: { value: 90, inForce: false },
    });
    const result = await service.updateForUser(world.users.aMember, {
      target,
      changes: [
        { key: "voice.volume", reset: true },
        { key: "data.audit_log_retention_days", reset: true },
      ],
    });
    expect(result.applied.map((change) => change.operation)).toEqual(["reset", "reset"]);
    expect(await storedRows(target)).toEqual([]);
    expect((await service.viewForUser(world.users.aMember, target)).issues).toEqual([]);
  });

  it("the client-login switch writes the column that row-level security reads", async () => {
    const a1 = businessOf("a1");
    const owner = world.users.a1Owner;
    const enabledFor = async () => {
      const access = await t.db.asUser(owner).run((ctx) => loadUserAccess(ctx));
      return access.businesses.find((b) => b.businessId === a1.businessId)?.enabled;
    };
    expect(await enabledFor()).toBe(true);

    const off = await service.updateForUser(world.users.aAdmin, {
      target: a1,
      changes: [{ key: "client_portal.enabled", value: false }],
    });
    expect(off.applied).toEqual([{ key: "client_portal.enabled", operation: "set", version: 1 }]);
    expect(await enabledFor()).toBe(false);
    expect(
      (await service.resolve(world.businesses.a1.tenant)).values["client_portal.enabled"],
    ).toBe(false);
    await expect(service.viewForUser(owner, a1)).rejects.toBeInstanceOf(TenantAccessError);

    await service.updateForUser(world.users.aMember, {
      target: a1,
      changes: [{ key: "client_portal.enabled", value: true }],
    });
    expect(await enabledFor()).toBe(true);
    const on = await service.resolve(world.businesses.a1.tenant);
    expect(on.sources["client_portal.enabled"]).toMatchObject({ scope: "business", version: 2 });

    // A reset goes back to the default: off.
    await service.updateForUser(world.users.aAdmin, {
      target: a1,
      changes: [{ key: "client_portal.enabled", reset: true }],
    });
    expect(await enabledFor()).toBe(false);
    // It is a business-only setting.
    const error = await failure(
      service.updateForUser(world.users.aAdmin, {
        target: globalOf("a"),
        changes: [{ key: "client_portal.enabled", value: true }],
      }),
    );
    expect(problemsOf(error)[0]?.reason).toBe("scope_not_allowed");
  });
});

describe("store: writes by client users", () => {
  const botName = (value: string) => [{ key: "persona.bot_name", value }];

  it("an owner changes a client-editable setting of their own business", async () => {
    const target = businessOf("a1");
    const owner = world.users.a1Owner;
    const result = await service.updateForUser(owner, { target, changes: botName("Casey") });
    expect(result.applied).toEqual([{ key: "persona.bot_name", operation: "set", version: 1 }]);
    const [row] = await storedRows(target, "persona.bot_name");
    expect(row).toMatchObject({ value: "Casey", updatedBy: owner.id });
    const [entry] = await historyOf(target, "persona.bot_name");
    expect(entry).toMatchObject({ changedBy: owner.id, value: "Casey" });
    const audit = await auditOf(target.agencyId, "persona.bot_name");
    expect(audit.at(-1)).toMatchObject({
      actorType: "user",
      actorUserId: owner.id,
      businessId: target.businessId,
      after: "Casey",
    });
  });

  it("an owner cannot change a setting that is not client-editable, or one of each kind mixed", async () => {
    const target = businessOf("a1");
    for (const key of [
      "routing.mode",
      "pricing.disclosure",
      "model.reply.model",
      "client_portal.edit_settings",
    ]) {
      const error = await failure(
        service.updateForUser(world.users.a1Owner, {
          target,
          changes: [{ key, value: SETTINGS[key as keyof typeof SETTINGS].default }],
        }),
      );
      expect(error, key).toBeInstanceOf(SettingsPermissionError);
      expect((error as SettingsPermissionError).details).toMatchObject({
        key,
        reason: "not_client_editable",
      });
    }
    await expect(
      service.updateForUser(world.users.a1Owner, {
        target,
        changes: [...botName("Casey"), { key: "routing.mode", value: "always_contact_later" }],
      }),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    await expect(
      service.updateForUser(world.users.a1Owner, {
        target,
        changes: [{ key: "routing.mode", reset: true }],
      }),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    expect(await storedRows(target)).toEqual([]);
  });

  it("client staff may edit only when the business's permission includes them", async () => {
    const target = businessOf("a1");
    const staff = world.users.a1Staff;
    const denied = await failure(
      service.updateForUser(staff, { target, changes: botName("Robin") }),
    );
    expect(denied).toBeInstanceOf(SettingsPermissionError);
    expect((denied as SettingsPermissionError).details).toMatchObject({
      reason: "client_editing_off",
    });

    await service.updateForUser(world.users.aAdmin, {
      target,
      changes: [{ key: "client_portal.edit_settings", value: "owner_and_staff" }],
    });
    const allowed = await service.updateForUser(staff, { target, changes: botName("Robin") });
    expect(allowed.applied[0]?.operation).toBe("set");

    // And the agency can switch client editing off altogether, for the owner too.
    await service.updateForUser(world.users.aAdmin, {
      target: globalOf("a"),
      changes: [{ key: "client_portal.edit_settings", value: "nobody" }],
    });
    await service.updateForUser(world.users.aAdmin, {
      target,
      changes: [{ key: "client_portal.edit_settings", reset: true }],
    });
    for (const user of [staff, world.users.a1Owner]) {
      await expect(
        service.updateForUser(user, { target, changes: botName("Sky") }),
      ).rejects.toBeInstanceOf(SettingsPermissionError);
    }
    const [row] = await storedRows(target, "persona.bot_name");
    expect(row?.value).toBe("Robin");
  });

  it("a client user reaches no other business, no agency scope, and nothing with logins off", async () => {
    const { a1Owner, a3Owner, b1Owner } = world.users;
    const attempts: [string, () => Promise<unknown>][] = [
      [
        "another business of the agency",
        () => service.updateForUser(a1Owner, { target: businessOf("a2"), changes: botName("X") }),
      ],
      [
        "a business of another agency",
        () => service.updateForUser(a1Owner, { target: businessOf("b1"), changes: botName("X") }),
      ],
      [
        "the agency scope",
        () => service.updateForUser(a1Owner, { target: globalOf("a"), changes: botName("X") }),
      ],
      [
        "the segment scope",
        () => service.updateForUser(a1Owner, { target: segmentOf("a"), changes: botName("X") }),
      ],
      [
        "a business with client logins off",
        () => service.updateForUser(a3Owner, { target: businessOf("a3"), changes: botName("X") }),
      ],
      ["viewing another business", () => service.viewForUser(a1Owner, businessOf("a2"))],
      ["viewing the agency scope", () => service.viewForUser(a1Owner, globalOf("a"))],
      ["viewing with client logins off", () => service.viewForUser(a3Owner, businessOf("a3"))],
      ["history of another business", () => service.historyForUser(b1Owner, businessOf("a1"))],
    ];
    for (const [what, attempt] of attempts) {
      expect(await failure(attempt()), what).toBeInstanceOf(TenantAccessError);
    }
    expect(await t.admin.select().from(settingValues)).toEqual([]);
  });

  it("a client user cannot use the staff path: row-level security and the store both refuse", async () => {
    const target = businessOf("a1");
    await expect(
      t.db
        .asUser(world.users.a1Owner)
        .run((ctx) => applySettingChangesAsUser(ctx, { target, changes: botName("Casey") })),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    // Even without the store: the tables are closed to client users.
    await expect(
      t.db.asUser(world.users.a1Owner).run(({ tx }) =>
        tx.insert(settingValues).values({
          ...world.businesses.a1.tenant,
          scope: "business",
          key: "persona.bot_name",
          value: "Casey",
        }),
      ),
    ).rejects.toBeInstanceOf(TenantAccessError);
    const visible = await t.db
      .asUser(world.users.a1Owner)
      .run(({ tx }) => tx.select().from(settingVersions));
    expect(visible).toEqual([]);
  });

  it("a client user sees only client-editable settings, values and history", async () => {
    const target = businessOf("a1");
    await seed(target, { "persona.bot_name": "Casey", "routing.mode": "always_contact_later" });
    await seed(globalOf("a"), { "voice.tone": "professional" });

    const view = await service.viewForUser(world.users.a1Owner, target);
    expect(view.role).toBe("client_owner");
    expect(view.entries.length).toBeGreaterThan(20);
    for (const entry of view.entries) {
      expect(SETTINGS[entry.key].clientEditable, entry.key).toBe(true);
      expect(entry.editable, entry.key).toBe(true);
    }
    expect(view.entries.find((entry) => entry.key === "persona.bot_name")).toMatchObject({
      value: "Casey",
      source: { scope: "business" },
      inherited: { value: "Alex", source: { scope: "default" } },
      resettable: true,
    });
    expect(view.entries.find((entry) => entry.key === "voice.tone")).toMatchObject({
      value: "professional",
      source: { scope: "global" },
      override: null,
    });
    expect(view.entries.some((entry) => entry.key === "routing.mode")).toBe(false);

    const staffView = await service.viewForUser(world.users.a1Staff, target);
    expect(staffView.role).toBe("client_staff");
    expect(
      staffView.entries.every((entry) => !entry.editable && entry.denial === "client_editing_off"),
    ).toBe(true);

    const history = await service.historyForUser(world.users.a1Owner, target);
    expect(history.map((entry) => entry.key)).toContain("persona.bot_name");
    expect(history.map((entry) => entry.key)).not.toContain("routing.mode");
  });
});

describe("store: writes by the system", () => {
  it("a business scope writes its own business, with the job as the author", async () => {
    const target = businessOf("a1");
    const result = await t.db.forBusiness(target.businessId).run((ctx) =>
      applySettingChanges(ctx, {
        target,
        actor: { type: "system", label: "onboarding" },
        changes: [{ key: "hours.after_hours_mode", value: "take_message" }],
      }),
    );
    expect(result.applied[0]).toMatchObject({ operation: "set", version: 1 });
    const [row] = await storedRows(target, "hours.after_hours_mode");
    expect(row).toMatchObject({ value: "take_message", updatedBy: null });
    const [entry] = await historyOf(target, "hours.after_hours_mode");
    expect(entry?.changedBy).toBeNull();
    const audit = await auditOf(target.agencyId, "hours.after_hours_mode");
    expect(audit.at(-1)).toMatchObject({
      actorType: "system",
      actorLabel: "onboarding",
      actorUserId: null,
    });
  });

  it("a business scope cannot write the agency, a segment or another business", async () => {
    const { businessId } = world.businesses.a1.tenant;
    const change = [{ key: "voice.tone", value: "direct" }];
    for (const target of [globalOf("a"), segmentOf("a"), businessOf("a2"), businessOf("b1")]) {
      await expect(
        t.db
          .forBusiness(businessId)
          .run((ctx) => applySettingChanges(ctx, { target, actor: SYSTEM, changes: change })),
      ).rejects.toBeInstanceOf(TenantAccessError);
    }
    await expect(
      t.db
        .forAgency(world.agencies.a.agencyId)
        .run((ctx) =>
          applySettingChanges(ctx, { target: businessOf("b1"), actor: SYSTEM, changes: change }),
        ),
    ).rejects.toBeInstanceOf(TenantAccessError);
    expect(await t.admin.select().from(settingValues)).toEqual([]);
  });

  it("the system still cannot store an invalid value or use a scope a setting does not allow", async () => {
    const error = await failure(
      t.db.forAgency(world.agencies.a.agencyId).run((ctx) =>
        applySettingChanges(ctx, {
          target: globalOf("a"),
          actor: SYSTEM,
          changes: [
            { key: "voice.tone", value: "loud" },
            { key: "alerts.recipients", value: [] },
          ],
        }),
      ),
    );
    expect(problemsOf(error).map((problem) => problem.reason)).toEqual([
      "invalid_value",
      "scope_not_allowed",
    ]);
  });

  it("applies a user's role when the server acts for them", async () => {
    const target = businessOf("a1");
    const act = (
      role: "agency_member" | "client_owner" | "client_staff",
      key: string,
      value: unknown,
    ) =>
      t.db.forBusiness(target.businessId).run((ctx) =>
        applySettingChanges(ctx, {
          target,
          actor: { type: "user", userId: world.users.a1Owner.id, role },
          changes: [{ key, value }],
        }),
      );
    await expect(
      act("client_owner", "routing.mode", "always_contact_later"),
    ).rejects.toBeInstanceOf(SettingsPermissionError);
    await expect(act("client_staff", "persona.bot_name", "Casey")).rejects.toBeInstanceOf(
      SettingsPermissionError,
    );
    await expect(act("client_owner", "persona.bot_name", "Casey")).resolves.toMatchObject({
      applied: [{ operation: "set" }],
    });
    await expect(
      act("agency_member", "routing.mode", "always_contact_later"),
    ).resolves.toMatchObject({
      applied: [{ operation: "set" }],
    });
  });
});

describe("the settings screen", () => {
  it("shows staff every setting of a business with value, source, inherited value and override", async () => {
    await seed(globalOf("a"), { "voice.tone": "professional" });
    await seed(segmentOf("a"), { "voice.tone": "empathetic" });
    await seed(businessOf("a1"), { "voice.tone": "direct" });

    const view = await service.viewForUser(world.users.aMember, businessOf("a1"));
    expect(view.role).toBe("agency_member");
    expect(view.scope).toBe("business");
    expect(view.entries.map((entry) => entry.key)).toEqual(SETTING_KEYS);
    expect(view.entries.find((entry) => entry.key === "voice.tone")).toMatchObject({
      value: "direct",
      source: { scope: "business", version: 1 },
      inherited: { value: "empathetic", source: { scope: "segment" } },
      override: { value: "direct", version: 1, inForce: true },
      editable: true,
      resettable: true,
    });
    expect(view.version).toBe((await service.resolve(world.businesses.a1.tenant)).version);
  });

  it("shows the segment and agency screens, editable by admins only", async () => {
    await seed(globalOf("a"), { "voice.tone": "professional" });
    await seed(segmentOf("a"), { "voice.tone": "empathetic" });

    const segment = await service.viewForUser(world.users.aAdmin, segmentOf("a"));
    expect(segment.entries.find((entry) => entry.key === "voice.tone")).toMatchObject({
      value: "empathetic",
      inherited: { value: "professional", source: { scope: "global" } },
      editable: true,
    });
    // Business-only settings are listed, and marked as not settable here.
    expect(segment.entries.find((entry) => entry.key === "alerts.recipients")).toMatchObject({
      editable: false,
      denial: "scope_not_allowed",
    });

    const global = await service.viewForUser(world.users.aMember, globalOf("a"));
    expect(global.role).toBe("agency_member");
    expect(global.entries.find((entry) => entry.key === "voice.tone")).toMatchObject({
      value: "professional",
      inherited: { value: "friendly", source: { scope: "default" } },
      editable: false,
      denial: "admin_required",
    });
  });

  it("builds a view inside a transaction the caller holds", async () => {
    const target = businessOf("a1");
    const view = await t.db
      .forBusiness(target.businessId)
      .run((ctx) => loadSettingsView(ctx, target, { editor: { kind: "system" } }));
    expect(view.entries).toHaveLength(SETTING_KEYS.length);
  });

  it("returns history newest first, for one key or for the whole target", async () => {
    const target = businessOf("a2");
    await seed(target, { "voice.humor": "light" });
    await seed(target, { "voice.humor": "none", "voice.emoji": "freely" });
    const admin = world.users.aAdmin;
    const one = await service.historyForUser(admin, target, { key: "voice.humor" });
    expect(one.map((entry) => entry.value).slice(0, 2)).toEqual(["none", "light"]);
    const all = await service.historyForUser(admin, target, { limit: 3 });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((entry) => entry.key))).toEqual(new Set(["voice.humor", "voice.emoji"]));
    expect(all[0]?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("segment presets", () => {
  it("gives a segment its starting values through the store, without overwriting", async () => {
    const { agencyId, segmentId } = world.agencies.a;
    const target = segmentOf("a");
    await seed(target, { "qualification.insurance_claim.weight": 25 });

    const first = await t.db
      .forAgency(agencyId)
      .run((ctx) => applySegmentPreset(ctx, { segmentId, slug: "roofing" }));
    expect(first.preset).toBe("roofing");
    const written = first.applied.filter((change) => change.operation === "set");
    expect(written).toHaveLength(Object.keys(SEGMENT_PRESETS.roofing).length - 1);

    const a1 = await service.resolve(world.businesses.a1.tenant);
    expect(a1.values["qualification.insurance_claim.enabled"]).toBe(true);
    expect(a1.sources["qualification.insurance_claim.enabled"].scope).toBe("segment");
    expect(a1.values["qualification.insurance_claim.weight"]).toBe(25); // kept
    // The other segment of the agency is untouched.
    const a2 = await service.resolve(world.businesses.a2.tenant);
    expect(a2.values["qualification.insurance_claim.enabled"]).toBe(false);

    // Versioned and audited like any change, under the job's name.
    const [entry] = await historyOf(target, "qualification.insurance_claim.enabled");
    expect(entry).toMatchObject({
      version: 1,
      changedBy: null,
      note: "Starting values for roofing",
    });
    const audit = await auditOf(agencyId, "qualification.insurance_claim.enabled");
    expect(audit[0]).toMatchObject({ actorType: "system", actorLabel: "segment-preset" });

    // Again: nothing to do.
    const again = await t.db
      .forAgency(agencyId)
      .run((ctx) => applySegmentPreset(ctx, { segmentId, slug: "roofing" }));
    expect(again.applied).toEqual([]);
    // A trade without a preset starts from the registry defaults.
    const none = await t.db
      .forAgency(agencyId)
      .run((ctx) => applySegmentPreset(ctx, { segmentId: hvacSegmentId, slug: "pest-control" }));
    expect(none).toEqual({ preset: null, applied: [] });
  });
});

describe("demo settings", () => {
  it("load after the demo data, and can be loaded again", async () => {
    await seedDemoData(t.db);
    const first = await seedDemoSettings(t.db);
    expect(first.written).toBeGreaterThan(25);

    const roofing = await service.resolve({
      agencyId: DEMO.agencyId,
      businessId: DEMO.businesses.roofing,
    });
    expect(roofing.issues).toEqual([]);
    expect(roofing.values["persona.bot_name"]).toBe("Riley");
    expect(roofing.sources["persona.role_title"].scope).toBe("global");
    expect(roofing.sources["qualification.insurance_claim.enabled"].scope).toBe("segment");
    expect(roofing.values["qualification.service_area.zip_codes"]).toContain("80215");
    expect(roofing.values["client_portal.enabled"]).toBe(true);

    const hvac = await service.resolve({
      agencyId: DEMO.agencyId,
      businessId: DEMO.businesses.hvac,
    });
    expect(hvac.issues).toEqual([]);
    expect(hvac.values["routing.mode"]).toBe("always_contact_later");
    expect(hvac.values["qualification.insurance_claim.enabled"]).toBe(false);
    expect(hvac.values["qualification.financing.enabled"]).toBe(true);
    expect(hvac.values["client_portal.enabled"]).toBe(false);

    // The demo users can use the settings screen right away.
    const view = await service.viewForUser(
      { id: DEMO.users.clientOwner.id, email: DEMO.users.clientOwner.email },
      { scope: "business", agencyId: DEMO.agencyId, businessId: DEMO.businesses.roofing },
    );
    expect(view.role).toBe("client_owner");

    // `pnpm db:seed` again: the agency is recreated, the settings written afresh.
    await seedDemoData(t.db);
    const second = await seedDemoSettings(t.db);
    expect(second.written).toBe(first.written);
  });
});
