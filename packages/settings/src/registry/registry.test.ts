import { describe, expect, it } from "vitest";

import {
  CHANNEL_IDS,
  INTEGRATION_IDS,
  KNOWLEDGE_CATEGORIES,
  ROUTING_OUTCOMES,
  SETTING_SCOPES,
} from "@repo/core";

import {
  CUSTOMER_CHANNELS,
  defineCategory,
  setting,
  SETTING_CATEGORIES,
  type SettingDefinition,
} from "../define";
import { emptyCategories } from "../docs";
import { type AnyField, f, templateVariablesIn, walkField } from "../fields";
import { canonicalJson } from "../hash";
import { TEMPLATE_VARIABLES } from "../templates";
import {
  type AppSettings,
  CRM_IDS,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  findSetting,
  getSetting,
  isSettingKey,
  MODEL_TASKS,
  QUALIFICATION_CRITERIA,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  SETTINGS,
  settingsByCategory,
  settingsInCategory,
} from "./index";

const CATEGORY_IDS = SETTING_CATEGORIES.map((category) => category.id) as readonly string[];

describe("every declaration", () => {
  it("there is a catalogue worth the name, and every category is used", () => {
    expect(SETTING_DEFINITIONS.length).toBeGreaterThan(300);
    expect(emptyCategories()).toEqual([]);
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
  });

  it.each(SETTING_DEFINITIONS.map((definition) => [definition.key, definition] as const))(
    "%s is well-formed",
    (key, definition) => {
      // Key: lower snake case segments, starting with the category.
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(CATEGORY_IDS).toContain(definition.category);
      expect(key.startsWith(`${definition.category}.`)).toBe(true);
      expect(SETTINGS[key as keyof typeof SETTINGS]).toBe(definition);

      // Text a person reads.
      expect(definition.label.trim()).toBe(definition.label);
      expect(definition.label.length).toBeGreaterThan(1);
      expect(definition.label.length).toBeLessThanOrEqual(80);
      expect(definition.help.length).toBeGreaterThan(15);
      expect(definition.help.trim().endsWith(".") || definition.help.trim().endsWith('"')).toBe(
        true,
      );

      // Scopes: at least one, no duplicates, in precedence order, only known ones.
      expect(definition.scopes.length).toBeGreaterThan(0);
      expect([...definition.scopes]).toEqual(
        SETTING_SCOPES.filter((scope) => definition.scopes.includes(scope)),
      );
      // A client user edits their own business, so a client-editable setting must allow it.
      if (definition.clientEditable) expect(definition.scopes).toContain("business");

      // The default is valid, already tidy, plain JSON, and frozen.
      const parsed = definition.schema.safeParse(definition.default);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(parsed.data).toEqual(definition.default);
      expect(JSON.parse(JSON.stringify(definition.default))).toEqual(definition.default);
      if (typeof definition.default === "object" && definition.default !== null) {
        expect(Object.isFrozen(definition.default)).toBe(true);
      }
      // The schema is the field's schema: validation and form cannot drift apart.
      expect(definition.schema).toBe(definition.field.schema);
    },
  );

  it.each(SETTING_DEFINITIONS.map((definition) => [definition.key, definition] as const))(
    "%s can be drawn from its field alone",
    (_key, definition) => {
      walkField(definition.field, (field: AnyField, path) => {
        const where = `${definition.key} ${path.join(".")}`;
        switch (field.kind) {
          case "select":
          case "multi_select":
            expect(field.options.length, where).toBeGreaterThan(0);
            for (const option of field.options) {
              expect(option.label.length, where).toBeGreaterThan(0);
              expect(option.value, where).toMatch(/^[a-z0-9][a-z0-9_]*$/i);
            }
            break;
          case "number":
            expect(field.max, where).toBeGreaterThanOrEqual(field.min);
            break;
          case "text":
            expect(field.maxLength, where).toBeGreaterThanOrEqual(Math.max(field.minLength, 1));
            for (const name of field.variables ?? []) {
              expect(Object.keys(TEMPLATE_VARIABLES), where).toContain(name);
            }
            break;
          case "list":
            expect(field.itemLabel.length, where).toBeGreaterThan(0);
            expect(field.maxItems, where).toBeGreaterThanOrEqual(Math.max(field.minItems, 1));
            if (typeof field.unique === "string") {
              expect(field.item.kind, where).toBe("object");
              const names =
                field.item.kind === "object" ? field.item.properties.map((p) => p.name) : [];
              expect(names, where).toContain(field.unique);
            }
            break;
          case "object":
            expect(field.properties.length, where).toBeGreaterThan(0);
            for (const property of field.properties) {
              expect(property.label.length, where).toBeGreaterThan(0);
              expect(property.name, where).toMatch(/^[a-z][a-z0-9_]*$/);
            }
            break;
          case "nullable":
            expect(field.nullLabel.length, where).toBeGreaterThan(0);
            expect(field.inner.kind, where).not.toBe("nullable");
            break;
          case "boolean":
            break;
        }
      });
    },
  );

  it("a text default uses only the placeholders its field allows", () => {
    for (const definition of SETTING_DEFINITIONS) {
      if (definition.field.kind !== "text" || definition.field.variables === null) continue;
      for (const name of templateVariablesIn(definition.default as string)) {
        expect(definition.field.variables, definition.key).toContain(name);
      }
    }
  });

  it("sensitive settings hold business or agency data, never a default with content", () => {
    const sensitive = SETTING_DEFINITIONS.filter((definition) => definition.sensitive);
    expect(sensitive.map((definition) => definition.key).sort()).toEqual([
      "alerts.agency_recipients",
      "alerts.recipients",
      "emergency.escalation_chain",
      "emergency.fallback_contacts",
      "integrations.agency_webhooks",
      "integrations.webhooks",
    ]);
    for (const definition of sensitive) expect(definition.default).toEqual([]);
  });
});

describe("the catalogue covers what the spec asks for", () => {
  it("every qualification criterion has a switch, a weight and a required flag", () => {
    expect([...QUALIFICATION_CRITERIA]).toEqual([
      "service_type",
      "job_scope",
      "service_area",
      "timeline",
      "decision_maker",
      "budget",
      "property_type",
      "insurance_claim",
      "financing",
      "photos",
    ]);
    for (const criterion of QUALIFICATION_CRITERIA) {
      expect(findSetting(`qualification.${criterion}.enabled`)?.field.kind).toBe("boolean");
      expect(findSetting(`qualification.${criterion}.weight`)?.field.kind).toBe("number");
      expect(findSetting(`qualification.${criterion}.required`)?.field.kind).toBe("boolean");
    }
    // Service area by ZIP code and by radius; budget bands; thresholds on top.
    expect(isSettingKey("qualification.service_area.zip_codes")).toBe(true);
    expect(isSettingKey("qualification.service_area.radius_miles")).toBe(true);
    expect(isSettingKey("qualification.budget.bands")).toBe(true);
    expect(SETTINGS["scoring.thresholds"].default).toEqual({ hot: 70, warm: 40 });
  });

  it("routing offers the three outcomes per band, and the always-contact-later mode", () => {
    for (const key of ["routing.hot_outcome", "routing.warm_outcome", "routing.cold_outcome"]) {
      const field = findSetting(key)?.field;
      expect(field?.kind === "select" && field.options.map((option) => option.value)).toEqual([
        ...ROUTING_OUTCOMES,
      ]);
    }
    const mode = SETTINGS["routing.mode"].field;
    expect(mode.kind === "select" && mode.options.map((option) => option.value)).toEqual([
      "by_score_band",
      "always_contact_later",
    ]);
  });

  it("pricing disclosure is never, ranges or exact, and never by default", () => {
    const field = SETTINGS["pricing.disclosure"].field;
    expect(field.kind === "select" && field.options.map((option) => option.value)).toEqual([
      "never",
      "ranges",
      "exact",
    ]);
    expect(SETTINGS["pricing.disclosure"].default).toBe("never");
  });

  it("the bot never has an option to deny being an AI", () => {
    const field = SETTINGS["persona.ai_disclosure"].field;
    expect(field.kind === "select" && field.options.map((option) => option.value)).toEqual([
      "upfront",
      "when_asked",
    ]);
  });

  it("per-channel settings exist for every customer channel", () => {
    expect([...CUSTOMER_CHANNELS].sort()).toEqual(
      CHANNEL_IDS.filter((channel) => channel !== "test").sort(),
    );
    for (const base of [
      "voice.opening_message",
      "voice.max_reply_characters",
      "conversation.reply_wait_seconds",
      "follow_up.max_nudges",
      "follow_up.delays_minutes",
    ]) {
      for (const channel of CUSTOMER_CHANNELS) {
        expect(isSettingKey(`${base}.${channel}`), `${base}.${channel}`).toBe(true);
      }
    }
  });

  it("model and effort are settings per task, with the product default", () => {
    for (const task of MODEL_TASKS) {
      const model = getSetting(`model.${task}.model`);
      expect(model.default).toBe(DEFAULT_MODEL);
      expect(model.schema.safeParse("claude-opus-5-5").success).toBe(true);
      expect(model.schema.safeParse("gpt-4o").success).toBe(false);
      const effort = getSetting(`model.${task}.effort`);
      expect(EFFORT_LEVELS).toContain(effort.default);
    }
    expect(DEFAULT_MODEL).toBe("claude-fable-5-2");
  });

  it("emergency classes cover the spec's examples, life safety first", () => {
    const classes = SETTINGS["emergency.classes"].default;
    const keys = classes.map((entry) => entry.key);
    for (const key of ["gas_leak", "fire_or_smoke", "electrical_hazard", "flooding", "no_heat"]) {
      expect(keys).toContain(key);
    }
    const firstUrgent = classes.findIndex((entry) => entry.severity === "urgent");
    expect(classes.slice(0, firstUrgent).every((e) => e.severity === "life_safety")).toBe(true);
    expect(classes.slice(firstUrgent).every((e) => e.severity === "urgent")).toBe(true);
    for (const entry of classes) expect(entry.safety_instructions.length).toBeGreaterThan(40);
  });

  it("stays in step with the vocabularies of @repo/core", () => {
    for (const crm of CRM_IDS) {
      expect(INTEGRATION_IDS).toContain(crm);
      expect(isSettingKey(`integrations.field_mapping.${crm}`)).toBe(true);
    }
    const core = SETTINGS["knowledge.core_categories"].field;
    expect(core.kind === "multi_select" && core.options.map((option) => option.value)).toEqual([
      ...KNOWLEDGE_CATEGORIES,
    ]);
  });

  it("client users can edit day-to-day settings and none of the agency's levers", () => {
    const editable = (key: string) => findSetting(key)?.clientEditable;
    for (const key of [
      "hours.weekly",
      "persona.bot_name",
      "alerts.recipients",
      "emergency.escalation_chain",
      "qualification.service_area.zip_codes",
      "channels.widget.primary_color",
    ]) {
      expect(editable(key), key).toBe(true);
    }
    for (const category of ["scoring", "routing", "model", "limits", "data", "client_portal"]) {
      for (const definition of settingsInCategory(category as never)) {
        if (definition.key === "routing.contact_later_timeframe") continue;
        if (definition.key === "routing.disqualify_referral") continue;
        expect(definition.clientEditable, definition.key).toBe(false);
      }
    }
    for (const key of [
      "persona.ai_disclosure",
      "pricing.disclosure",
      "channels.widget.allowed_origins",
      "guardrails.extra_rules",
    ]) {
      expect(editable(key), key).toBe(false);
    }
  });
});

describe("lookups", () => {
  it("finds settings by key and groups them by category in display order", () => {
    expect(findSetting("persona.bot_name")?.label).toBe("Bot name");
    expect(findSetting("persona.nope")).toBeUndefined();
    expect(isSettingKey("toString")).toBe(false);
    expect(isSettingKey("__proto__")).toBe(false);
    const groups = settingsByCategory();
    expect(groups.map((group) => group.category.id)).toEqual(CATEGORY_IDS);
    expect(groups.flatMap((group) => group.settings)).toHaveLength(SETTING_DEFINITIONS.length);
    // Registry order is category order: the screen never has to sort.
    expect(groups.flatMap((group) => group.settings.map((s) => s.key))).toEqual(SETTING_KEYS);
  });

  it("types follow the declarations", () => {
    const tone: AppSettings["voice.tone"] = SETTINGS["voice.tone"].default;
    const radius: AppSettings["qualification.service_area.radius_miles"] = null;
    // @ts-expect-error "loud" is not a tone
    const wrong: AppSettings["voice.tone"] = "loud";
    expect([tone, radius, wrong]).toEqual(["friendly", null, "loud"]);
  });
});

describe("adding a setting takes one declaration", () => {
  it("a new category entry gets key, category, defaults and a frozen default", () => {
    const extra = defineCategory("voice", {
      "voice.test_only": setting({
        label: "Test only",
        help: "A setting declared inside a test.",
        field: f.list(f.text({ minLength: 1 }), { itemLabel: "word" }),
        default: ["a"],
      }),
    });
    const definition: SettingDefinition<string[]> = extra["voice.test_only"];
    expect(definition).toMatchObject({
      key: "voice.test_only",
      category: "voice",
      scopes: [...SETTING_SCOPES],
      clientEditable: false,
      sensitive: false,
      group: null,
    });
    expect(Object.isFrozen(definition.default)).toBe(true);
    expect(canonicalJson(definition.default)).toBe('["a"]');
  });
});
