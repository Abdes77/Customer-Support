import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SETTING_CATEGORIES } from "./define";
import { renderSettingsDocs } from "./docs";
import { SETTING_DEFINITIONS } from "./registry";

const DOCS_PATH = path.resolve(import.meta.dirname, "../../../docs/SETTINGS.md");

describe("docs/SETTINGS.md", () => {
  const rendered = renderSettingsDocs();

  it("is what the registry renders (run `pnpm settings:docs` after changing a setting)", () => {
    expect(readFileSync(DOCS_PATH, "utf8")).toBe(rendered);
  });

  it("lists every setting with its key, label, default, scopes and client flag", () => {
    const rows = new Map(
      rendered
        .split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => [line.slice(3, line.indexOf("`", 3)), line] as const),
    );
    for (const definition of SETTING_DEFINITIONS) {
      const line = rows.get(definition.key);
      expect(line, definition.key).toBeDefined();
      const cells = line!.split(" | ");
      expect(cells[1], definition.key).toContain(`**${definition.label.replace(/\|/g, "\\|")}.**`);
      expect(cells.at(-2), definition.key).toBe(
        definition.scopes.length === 3 ? "all" : definition.scopes.join(", "),
      );
      expect(cells.at(-1), definition.key).toBe(definition.clientEditable ? "yes |" : " |");
      const json = JSON.stringify(definition.default);
      if (json.length <= 70) {
        expect(line, definition.key).toContain(`\`${json.replace(/\|/g, "\\|")}\``);
      } else {
        expect(rendered, definition.key).toContain(
          `<details><summary><code>${definition.key}</code></summary>`,
        );
      }
    }
    // Exactly one row per setting, plus the placeholder table.
    expect([...rows.keys()].filter((key) => !key.startsWith("{{"))).toHaveLength(
      SETTING_DEFINITIONS.length,
    );
  });

  it("has a section per category and states the totals", () => {
    for (const category of SETTING_CATEGORIES) {
      expect(rendered).toContain(`### ${category.label}`);
      expect(rendered).toContain(`<a id="${category.id}"></a>`);
    }
    expect(rendered).toContain(
      `${SETTING_DEFINITIONS.length} settings in ${SETTING_CATEGORIES.length} categories.`,
    );
  });

  it("is deterministic and ends with a single newline", () => {
    expect(renderSettingsDocs()).toBe(rendered);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });
});
