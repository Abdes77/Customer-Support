import { describe, expect, it } from "vitest";

import { SEGMENT_PRESET_IDS, SEGMENT_PRESETS, segmentPresetFor } from "./presets";
import { resolveSettings, settingsWith } from "./resolve";
import { checkSettingValue } from "./validate";

describe("segment presets", () => {
  it.each(SEGMENT_PRESET_IDS)("%s holds only valid values of settings a segment may set", (id) => {
    const preset = SEGMENT_PRESETS[id];
    expect(Object.keys(preset).length).toBeGreaterThanOrEqual(3);
    for (const [key, value] of Object.entries(preset)) {
      const checked = checkSettingValue(key, value, "segment");
      expect(checked.ok, `${id} ${key}: ${checked.ok ? "" : checked.message}`).toBe(true);
      // Already tidy: what is declared is what gets stored.
      expect(checked.ok && checked.value, `${id} ${key}`).toEqual(value);
    }
    expect(() => settingsWith(preset, "segment")).not.toThrow();
  });

  it("a preset is a segment default: a business override still wins", () => {
    const rows = (values: object) =>
      Object.entries(values).map(([key, value]) => ({ key, value, version: 1, updatedAt: null }));
    const resolved = resolveSettings({
      segment: rows(SEGMENT_PRESETS.remodeling),
      business: rows({ "qualification.budget.ask_mode": "never" }),
    });
    expect(resolved.values["qualification.budget.ask_mode"]).toBe("never");
    expect(resolved.values["qualification.budget.weight"]).toBe(20);
    expect(resolved.sources["qualification.budget.weight"].scope).toBe("segment");
    expect(resolved.values["scheduling.slot_minutes"]).toBe(90);
  });

  it("the trades differ where they should", () => {
    expect(SEGMENT_PRESETS.roofing["qualification.insurance_claim.enabled"]).toBe(true);
    expect(SEGMENT_PRESETS.remodeling["qualification.budget.ask_mode"]).toBe("offer_bands");
    expect(SEGMENT_PRESETS.plumbing["qualification.budget.ask_mode"]).toBe("never");
  });

  it("finds a preset by slug, however the slug is written", () => {
    for (const [slug, id] of [
      ["roofing", "roofing"],
      ["Roofing", "roofing"],
      ["hvac", "hvac"],
      ["heating-and-cooling", "hvac"],
      ["Heating & Cooling", "hvac"],
      ["plumbers", "plumbing"],
      ["electricians", "electrical"],
      ["kitchen-bath-remodeling", "remodeling"],
      ["kitchen_and_bath_remodeling", "remodeling"],
      [" Kitchen & Bath ", "remodeling"],
    ] as const) {
      expect(segmentPresetFor(slug)?.id, slug).toBe(id);
    }
    for (const slug of [
      "pest-control",
      "landscaping",
      "",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(segmentPresetFor(slug), slug).toBeNull();
    }
  });
});
