import { describe, expect, it } from "vitest";

import { type EngineTurnInput, type SettingsResolver, ValidationError } from "@repo/core";

import { fingerprint } from "./hash";
import { type AppSettings, SETTING_DEFINITIONS, SETTING_KEYS, SETTINGS } from "./registry";
import {
  type AppResolvedSettings,
  buildSettingsView,
  channelSetting,
  defaultSettings,
  resolveSettings,
  settingsWith,
  type StoredSetting,
} from "./resolve";
import { checkSettingValue, parseSettingValue, summarizeProblems } from "./validate";

const AT = "2026-11-11T18:30:00.000Z";

function row(key: string, value: unknown, version = 1): StoredSetting {
  return { key, value, version, updatedAt: AT };
}

describe("defaults", () => {
  it("resolves every setting to its registry default, with source 'default'", () => {
    const resolved = defaultSettings();
    expect(Object.keys(resolved.values)).toEqual(SETTING_KEYS);
    for (const definition of SETTING_DEFINITIONS) {
      const key = definition.key as keyof typeof resolved.values;
      expect(resolved.values[key]).toBe(definition.default);
      expect(resolved.sources[key]).toEqual({ scope: "default", version: null, updatedAt: null });
    }
    expect(resolved.issues).toEqual([]);
    expect(resolved.version).toBe(fingerprint(resolved.values));
    expect(resolved.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("the snapshot cannot be edited", () => {
    const resolved = resolveSettings({ business: [row("voice.banned_phrases", ["cheap"])] });
    expect(Object.isFrozen(resolved.values)).toBe(true);
    expect(Object.isFrozen(resolved.sources)).toBe(true);
    expect(() => {
      (resolved.values as { "voice.tone": string })["voice.tone"] = "direct";
    }).toThrow(TypeError);
    expect(() => resolved.values["voice.banned_phrases"].push("free")).toThrow(TypeError);
    expect(() => {
      (resolved.values["scoring.thresholds"] as { hot: number }).hot = 99;
    }).toThrow(TypeError);
    // Editing a snapshot must never reach the registry.
    expect(SETTINGS["scoring.thresholds"].default).toEqual({ hot: 70, warm: 40 });
  });
});

describe("precedence", () => {
  it("default < global < segment < business, per setting", () => {
    const resolved = resolveSettings({
      global: [
        row("voice.tone", "professional", 3),
        row("voice.emoji", "never", 1),
        row("persona.bot_name", "Sam", 2),
      ],
      segment: [row("voice.tone", "empathetic", 5), row("voice.emoji", "freely", 2)],
      business: [row("voice.tone", "direct", 7)],
    });
    expect(resolved.values["voice.tone"]).toBe("direct");
    expect(resolved.sources["voice.tone"]).toEqual({
      scope: "business",
      version: 7,
      updatedAt: AT,
    });
    expect(resolved.values["voice.emoji"]).toBe("freely");
    expect(resolved.sources["voice.emoji"]).toEqual({
      scope: "segment",
      version: 2,
      updatedAt: AT,
    });
    expect(resolved.values["persona.bot_name"]).toBe("Sam");
    expect(resolved.sources["persona.bot_name"].scope).toBe("global");
    expect(resolved.values["voice.humor"]).toBe("none");
    expect(resolved.sources["voice.humor"].scope).toBe("default");
    expect(resolved.issues).toEqual([]);
  });

  it("does not depend on the order in which layers or rows are given", () => {
    const global = [row("voice.tone", "professional"), row("voice.emoji", "never")];
    const business = [row("voice.tone", "direct")];
    const a = resolveSettings({ global, business });
    const b = resolveSettings({ business, global: [...global].reverse() });
    expect(b.values).toEqual(a.values);
    expect(b.version).toBe(a.version);
  });

  it("an override replaces the whole value: lists and objects are not merged", () => {
    const resolved = resolveSettings({
      global: [row("voice.banned_phrases", ["cheap", "guarantee"])],
      business: [row("voice.banned_phrases", ["honestly"])],
    });
    expect(resolved.values["voice.banned_phrases"]).toEqual(["honestly"]);
  });

  it("an explicit null overrides a value where the setting allows null", () => {
    const resolved = resolveSettings({
      global: [row("handoff.auto_release_minutes", 30)],
      business: [row("handoff.auto_release_minutes", null)],
    });
    expect(resolved.values["handoff.auto_release_minutes"]).toBeNull();
    expect(resolved.sources["handoff.auto_release_minutes"].scope).toBe("business");
  });

  it("stores the tidied value, as the store would have", () => {
    const resolved = resolveSettings({
      business: [
        row("qualification.contact_details", ["phone", "name"]),
        row("emergency.phone", "(512) 555-0142"),
      ],
    });
    expect(resolved.values["qualification.contact_details"]).toEqual(["name", "phone"]);
    expect(resolved.values["emergency.phone"]).toBe("+15125550142");
  });
});

describe("the version", () => {
  it("changes exactly when a resolved value changes", () => {
    const base = defaultSettings().version;
    expect(resolveSettings({}).version).toBe(base);
    // An override equal to the default changes the source, not the value.
    const same = resolveSettings({ business: [row("voice.tone", "friendly")] });
    expect(same.sources["voice.tone"].scope).toBe("business");
    expect(same.version).toBe(base);
    const changed = resolveSettings({ business: [row("voice.tone", "direct")] });
    expect(changed.version).not.toBe(base);
    // The same value from another scope is the same snapshot.
    expect(resolveSettings({ global: [row("voice.tone", "direct", 9)] }).version).toBe(
      changed.version,
    );
    // A skipped row does not change it.
    expect(resolveSettings({ business: [row("voice.tone", "loud")] }).version).toBe(base);
  });
});

describe("stored rows are not trusted", () => {
  it("skips an invalid value and falls back to the next layer down", () => {
    const resolved = resolveSettings({
      global: [row("voice.tone", "professional", 2)],
      segment: [row("voice.tone", "shouting", 4)],
      business: [row("voice.tone", 42, 6)],
    });
    expect(resolved.values["voice.tone"]).toBe("professional");
    expect(resolved.sources["voice.tone"]).toEqual({ scope: "global", version: 2, updatedAt: AT });
    expect(resolved.issues.map(({ key, scope, reason }) => ({ key, scope, reason }))).toEqual([
      { key: "voice.tone", scope: "segment", reason: "invalid_value" },
      { key: "voice.tone", scope: "business", reason: "invalid_value" },
    ]);
  });

  it("falls back to the registry default when every layer is invalid", () => {
    const resolved = resolveSettings({
      global: [row("scoring.thresholds", { hot: 30, warm: 60 })],
      business: [row("scoring.thresholds", { hot: 80 })],
    });
    expect(resolved.values["scoring.thresholds"]).toEqual({ hot: 70, warm: 40 });
    expect(resolved.sources["scoring.thresholds"].scope).toBe("default");
    expect(resolved.issues).toHaveLength(2);
    expect(resolved.issues[0]?.message).toContain("The hot threshold must be above");
  });

  it.each([
    ["a wrong type", "qualification.budget.weight", "heavy"],
    ["a number out of range", "qualification.budget.weight", 500],
    ["a fraction where a whole number is required", "qualification.max_questions", 2.5],
    ["null where null is not allowed", "voice.tone", null],
    ["an object with an unknown property", "scoring.thresholds", { hot: 70, warm: 40, extra: 1 }],
    ["a list with a bad entry", "qualification.service_area.zip_codes", ["78701", "nope"]],
    ["a duplicate in a unique list", "qualification.service_area.zip_codes", ["78701", "78701"]],
    ["a template with an unknown placeholder", "persona.ai_disclosure_wording", "I am {{name}}"],
    ["text beyond the limit", "persona.bot_name", "x".repeat(41)],
    [
      "an http webhook",
      "integrations.webhooks",
      [{ name: "Zap", url: "http://hooks.example.com/1", events: ["handoff"], active: true }],
    ],
    ["a model that is not Claude", "model.reply.model", "gpt-4o"],
    ["an effort that does not exist", "model.reply.effort", "extreme"],
    ["undefined", "voice.tone", undefined],
  ])("skips %s", (_what, key, value) => {
    const resolved = resolveSettings({ business: [row(key, value)] });
    const definition = SETTINGS[key as keyof typeof SETTINGS];
    expect(resolved.values[key as keyof typeof resolved.values]).toBe(definition.default);
    expect(resolved.sources[key as keyof typeof resolved.sources].scope).toBe("default");
    expect(resolved.issues).toHaveLength(1);
    expect(resolved.issues[0]).toMatchObject({ key, scope: "business", reason: "invalid_value" });
  });

  it("an issue names the setting and the rule, never the stored value", () => {
    const secret = "sk-live-do-not-log";
    const resolved = resolveSettings({ business: [row("voice.tone", secret)] });
    expect(JSON.stringify(resolved.issues)).not.toContain(secret);
    expect(resolved.issues[0]?.message).toBe(
      '"Tone": Choose one of: friendly, professional, casual, empathetic, direct, upbeat.',
    );
  });

  it("skips unknown keys, including ones that look like object internals", () => {
    const resolved = resolveSettings({
      business: [row("voice.volume", 11), row("__proto__", { polluted: true }), row("toString", 1)],
    });
    expect(resolved.issues.map((issue) => issue.reason)).toEqual([
      "unknown_key",
      "unknown_key",
      "unknown_key",
    ]);
    expect(Object.keys(resolved.values)).toEqual(SETTING_KEYS);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(resolved.version).toBe(defaultSettings().version);
  });
});

describe("scope rules", () => {
  it("skips a row stored at a scope its setting does not allow", () => {
    const resolved = resolveSettings({
      // Business-only settings stored agency-wide and for a segment.
      global: [row("qualification.service_area.zip_codes", ["78701"])],
      segment: [row("alerts.recipients", [])],
      // Global-only settings stored for one business.
      business: [
        row("limits.agency_daily_spend_usd", 1_000_000),
        row("data.audit_log_retention_days", 90),
      ],
    });
    expect(resolved.values["qualification.service_area.zip_codes"]).toEqual([]);
    expect(resolved.values["limits.agency_daily_spend_usd"]).toBeNull();
    expect(resolved.values["data.audit_log_retention_days"]).toBe(1095);
    expect(resolved.issues.map(({ key, scope, reason }) => ({ key, scope, reason }))).toEqual([
      { key: "qualification.service_area.zip_codes", scope: "global", reason: "scope_not_allowed" },
      { key: "alerts.recipients", scope: "segment", reason: "scope_not_allowed" },
      { key: "limits.agency_daily_spend_usd", scope: "business", reason: "scope_not_allowed" },
      { key: "data.audit_log_retention_days", scope: "business", reason: "scope_not_allowed" },
    ]);
  });

  it("uses the same row at a scope the setting allows", () => {
    const resolved = resolveSettings({
      global: [row("limits.agency_daily_spend_usd", 500)],
      business: [row("qualification.service_area.zip_codes", ["78701"])],
    });
    expect(resolved.values["limits.agency_daily_spend_usd"]).toBe(500);
    expect(resolved.values["qualification.service_area.zip_codes"]).toEqual(["78701"]);
    expect(resolved.issues).toEqual([]);
  });

  it("every setting is honoured at each scope it allows and at no other", () => {
    for (const definition of SETTING_DEFINITIONS) {
      for (const scope of ["global", "segment", "business"] as const) {
        const resolved = resolveSettings({ [scope]: [row(definition.key, definition.default)] });
        const source = resolved.sources[definition.key as keyof typeof resolved.sources];
        const allowed = definition.scopes.includes(scope);
        expect(source.scope, `${definition.key} at ${scope}`).toBe(allowed ? scope : "default");
        expect(resolved.issues.length, `${definition.key} at ${scope}`).toBe(allowed ? 0 : 1);
      }
    }
  });
});

describe("checkSettingValue and parseSettingValue", () => {
  it("returns the tidied value or the reason", () => {
    expect(checkSettingValue("voice.tone", "direct")).toMatchObject({ ok: true, value: "direct" });
    expect(checkSettingValue("voice.nope", 1)).toMatchObject({ ok: false, reason: "unknown_key" });
    expect(checkSettingValue("alerts.recipients", [], "global")).toMatchObject({
      ok: false,
      reason: "scope_not_allowed",
    });
    expect(checkSettingValue("alerts.recipients", [], "business").ok).toBe(true);
    expect(parseSettingValue("emergency.phone", "512-555-0142")).toBe("+15125550142");
    expect(() => parseSettingValue("voice.tone", "loud")).toThrow(ValidationError);
  });

  it("summarizes problems with their place in the value", () => {
    const checked = checkSettingValue("hours.weekly", {
      ...SETTINGS["hours.weekly"].default,
      monday: [{ open: "09:00", close: "08:00" }],
      tuesday: [{ open: "25:00", close: "26:00" }],
    });
    expect(checked.ok).toBe(false);
    expect(summarizeProblems([])).toBe("The value is not valid.");
    expect(
      summarizeProblems([
        { path: ["monday", 0, "close"], message: "Too early." },
        { path: [], message: "Other." },
      ]),
    ).toBe("monday > #1 > close: Too early. (and 1 more)");
  });
});

describe("settingsWith", () => {
  it("gives defaults plus valid overrides, and throws on an invalid one", () => {
    const settings = settingsWith({ "pricing.disclosure": "ranges", "voice.emoji": "never" });
    expect(settings.values["pricing.disclosure"]).toBe("ranges");
    expect(settings.sources["pricing.disclosure"]).toEqual({
      scope: "business",
      version: null,
      updatedAt: null,
    });
    expect(settings.values["voice.tone"]).toBe("friendly");
    expect(() => settingsWith({ "voice.tone": "loud" as never })).toThrow(ValidationError);
    expect(() => settingsWith({ "alerts.recipients": [] }, "global")).toThrow(ValidationError);
    expect(
      settingsWith({ "limits.agency_daily_spend_usd": 50 }, "global").values[
        "limits.agency_daily_spend_usd"
      ],
    ).toBe(50);
  });
});

describe("channelSetting", () => {
  it("reads the value for a channel; the test channel uses the website chat's", () => {
    const { values } = settingsWith({
      "follow_up.max_nudges.whatsapp": 4,
      "follow_up.max_nudges.widget": 0,
    });
    expect(channelSetting(values, "follow_up.max_nudges", "whatsapp")).toBe(4);
    expect(channelSetting(values, "follow_up.max_nudges", "widget")).toBe(0);
    expect(channelSetting(values, "follow_up.max_nudges", "test")).toBe(0);
    expect(channelSetting(values, "follow_up.max_nudges", "email")).toBe(3);
    const delays: number[] = channelSetting(values, "follow_up.delays_minutes", "email");
    expect(delays).toEqual([1440, 4320, 10_080]);
    const opening: string = channelSetting(values, "voice.opening_message", "instagram");
    expect(opening).toBe("");
  });
});

describe("buildSettingsView", () => {
  const layers = {
    global: [row("voice.tone", "professional", 2), row("voice.emoji", "never", 1)],
    segment: [row("voice.tone", "empathetic", 4)],
    business: [row("voice.tone", "direct", 6), row("voice.humor", "slapstick", 1)],
  };
  const admin = { editor: { kind: "user", role: "agency_admin" } } as const;
  const entry = (view: ReturnType<typeof buildSettingsView>, key: string) =>
    view.entries.find((candidate) => candidate.key === key)!;

  it("shows value, source, inherited value and own override at the business scope", () => {
    const view = buildSettingsView("business", layers, admin);
    expect(view.entries.map((candidate) => candidate.key)).toEqual(SETTING_KEYS);
    expect(entry(view, "voice.tone")).toMatchObject({
      value: "direct",
      source: { scope: "business", version: 6 },
      inherited: { value: "empathetic", source: { scope: "segment", version: 4 } },
      override: { value: "direct", version: 6, inForce: true, problem: null },
      editable: true,
      resettable: true,
    });
    expect(entry(view, "voice.emoji")).toMatchObject({
      value: "never",
      source: { scope: "global" },
      inherited: { value: "never", source: { scope: "global" } },
      override: null,
      editable: true,
      resettable: false,
    });
    expect(view.version).toBe(resolveSettings(layers).version);
  });

  it("shows an invalid override as stored but not in force, and still resettable", () => {
    const view = buildSettingsView("business", layers, admin);
    expect(entry(view, "voice.humor")).toMatchObject({
      value: "none",
      source: { scope: "default" },
      override: { value: "slapstick", inForce: false },
      resettable: true,
    });
    expect(entry(view, "voice.humor").override?.problem).toContain("Humor");
    expect(view.issues.map((issue) => issue.key)).toEqual(["voice.humor"]);
  });

  it("at the segment and global scopes only the layers up to that scope count", () => {
    const segment = buildSettingsView("segment", layers, admin);
    expect(entry(segment, "voice.tone")).toMatchObject({
      value: "empathetic",
      inherited: { value: "professional", source: { scope: "global" } },
      override: { value: "empathetic", version: 4 },
    });
    const global = buildSettingsView("global", layers, admin);
    expect(entry(global, "voice.tone")).toMatchObject({
      value: "professional",
      inherited: { value: "friendly", source: { scope: "default" } },
      override: { value: "professional", version: 2 },
    });
    expect(entry(global, "voice.humor").override).toBeNull();
    expect(global.issues).toEqual([]);
  });

  it("marks what the viewer may edit, and can limit what the viewer sees", () => {
    const member = buildSettingsView("global", layers, {
      editor: { kind: "user", role: "agency_member" },
    });
    expect(entry(member, "voice.tone")).toMatchObject({
      editable: false,
      denial: "admin_required",
      resettable: false,
    });
    const business = buildSettingsView("business", layers, admin);
    expect(entry(business, "limits.agency_daily_spend_usd")).toMatchObject({
      editable: false,
      denial: "scope_not_allowed",
    });
    const client = buildSettingsView("business", layers, {
      editor: { kind: "user", role: "client_owner" },
      clientEditing: "owner",
      only: (key) => SETTINGS[key].clientEditable,
    });
    expect(client.entries.length).toBeGreaterThan(20);
    expect(client.entries.every((candidate) => SETTINGS[candidate.key].clientEditable)).toBe(true);
    expect(client.entries.every((candidate) => candidate.editable)).toBe(true);
    expect(client.entries.some((candidate) => candidate.key === "routing.mode")).toBe(false);
  });
});

describe("the contracts of @repo/core", () => {
  it("a resolved snapshot is what the engine and the resolver contract expect", () => {
    const snapshot: AppResolvedSettings = defaultSettings();
    // Both the typed and the untyped form of the engine input accept it.
    const typed: Pick<EngineTurnInput<AppSettings>, "settings"> = { settings: snapshot };
    const untyped: Pick<EngineTurnInput, "settings"> = { settings: snapshot };
    const resolver: SettingsResolver<AppSettings> = { resolve: async () => snapshot };
    expect(typed.settings.version).toBe(untyped.settings.version);
    expect(resolver).toBeDefined();
  });
});
