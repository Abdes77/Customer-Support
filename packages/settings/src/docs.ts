import { SETTING_SCOPES } from "@repo/core";

import { SETTING_CATEGORIES, type SettingDefinition } from "./define";
import { type AnyField, describeField } from "./fields";
import { SETTING_DEFINITIONS, settingsByCategory } from "./registry";
import { TEMPLATE_VARIABLES } from "./templates";

/**
 * Renders docs/SETTINGS.md from the registry. `pnpm settings:docs` writes the file and a
 * test fails when the file and the registry differ, so the document cannot go stale.
 */

const INLINE_LIMIT = 70;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function code(text: string): string {
  // A value with a backtick needs a longer fence; none of the defaults has one today.
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function scopesText(definition: SettingDefinition): string {
  return definition.scopes.length === SETTING_SCOPES.length ? "all" : definition.scopes.join(", ");
}

function shortType(field: AnyField): string {
  const full = describeField(field);
  if (full.length <= INLINE_LIMIT) return full;
  switch (field.kind) {
    case "list":
      return `list (up to ${field.maxItems}) of ${field.item.kind === "object" ? "entries" : describeField(field.item)}, see below`;
    case "object":
      return "group of values, see below";
    case "nullable":
      return `${shortType(field.inner)}, or empty`;
    default:
      return full;
  }
}

/** JSON that keeps short arrays and objects on one line and breaks only the long ones. */
function compactJson(value: unknown, indent = ""): string {
  const inline = JSON.stringify(value);
  if (inline.length + indent.length <= 96 || value === null || typeof value !== "object") {
    return inline;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => `${inner}${compactJson(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, inner)}`,
  );
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

/** The structure of a field as a nested list, for fields too large for a table cell. */
function outline(field: AnyField, indent: string): string[] {
  if (field.widget === "weekly_hours") {
    return [
      `${indent}- one entry per weekday, \`monday\` to \`sunday\`: a list of up to 4 open intervals \`{ "open": "HH:MM", "close": "HH:MM" }\` in order; an empty list means closed.`,
    ];
  }
  switch (field.kind) {
    case "object":
      return field.properties.flatMap((property) => {
        const nested = property.field.kind === "object" || isStructuredList(property.field);
        const help = property.help === null ? "" : ` ${property.help}`;
        return nested
          ? [
              `${indent}- \`${property.name}\` (${property.label}):${help}`,
              ...outline(property.field, `${indent}  `),
            ]
          : [
              `${indent}- \`${property.name}\` (${property.label}): ${describeField(property.field)}.${help}`,
            ];
      });
    case "list":
      return [
        `${indent}- each ${field.itemLabel} (up to ${field.maxItems}):`,
        ...outline(field.item, `${indent}  `),
      ];
    case "nullable":
      return outline(field.inner, indent);
    default:
      return [`${indent}- ${describeField(field)}`];
  }
}

function isStructuredList(field: AnyField): boolean {
  return field.kind === "list" && (field.item.kind === "object" || field.item.kind === "list");
}

function settingRow(definition: SettingDefinition): string {
  const json = JSON.stringify(definition.default);
  const defaultText = json.length <= INLINE_LIMIT ? code(json) : "see below";
  return `| ${[
    code(definition.key),
    `**${cell(definition.label)}.** ${cell(definition.help)}`,
    cell(shortType(definition.field)),
    cell(defaultText),
    scopesText(definition),
    definition.clientEditable ? "yes" : "",
  ].join(" | ")} |`;
}

function settingDetails(definition: SettingDefinition): string[] {
  const lines: string[] = [];
  const longType = describeField(definition.field).length > INLINE_LIMIT;
  const json = JSON.stringify(definition.default);
  const longDefault = json.length > INLINE_LIMIT;
  if (!longType && !longDefault) return lines;
  lines.push(`<details><summary><code>${definition.key}</code></summary>`, "");
  if (longType) {
    lines.push("Structure:", "", ...outline(definition.field, ""), "");
  }
  if (longDefault) {
    lines.push("Default:", "", "```json", compactJson(definition.default), "```", "");
  }
  lines.push("</details>", "");
  return lines;
}

const INTRO = `# Settings

GENERATED from the registry in \`packages/settings/src/registry\` by \`pnpm settings:docs\`.
Do not edit by hand: change the registry and run the command. A test fails when this file and
the registry differ.

Everything a business might want different is a setting. This file lists every setting, and
says how settings are resolved, read, changed and added.

## How a value is resolved

Every setting has a default in the registry. A value can be overridden at three scopes, and
the most specific one wins:

1. the registry default,
2. **global**: the agency's own default for all its businesses,
3. **segment**: the default for one industry segment of the agency (set with its playbook),
4. **business**: the override of one business.

The resolver returns, for one business, every value, where each value came from
(\`sources\`), and a \`version\`: a fingerprint of the values that is recorded with every turn,
model call and routing decision.

- **Scopes.** The Scopes column says where a setting may be overridden. "all" means global,
  segment and business. Values that describe one business (its ZIP codes, its alert
  recipients) are business only; agency policy is global only.
- **Client may edit.** A "yes" means the business's own users may change the setting for their
  business, when \`client_portal.edit_settings\` allows it for their role. Client users see
  only these settings. Everything else is changed by agency staff: any staff member at the
  business scope, an agency admin at the global and segment scopes.
- **Stored values are never trusted.** Rows can be written without the store (agency staff can
  reach business-level rows through Supabase's REST API). The resolver validates every row it
  reads. A row with an unknown key, at a scope its setting does not allow, or with a value
  that fails validation is skipped: the value falls back to the next scope down, and the row
  is reported in \`issues\`, logged, and shown as "not in force" on the settings screen.
- **Changes are versioned and audited.** Every change through the store gets the next version
  number of its key at that scope, a row in the append-only table \`setting_versions\` (value,
  previous value, author, note) and an entry in the audit log. A reset removes the override
  and is recorded the same way. Sensitive settings (contact lists, webhook addresses) are
  recorded in the audit log without their values.
- **Two values live in columns of the business.** Its time zone is
  \`businesses.timezone\` and is not a setting. \`client_portal.enabled\` is a setting on
  screen and in code, but its value is the column \`businesses.client_portal_enabled\`,
  because row-level security reads it: the resolver reports the column and the store writes it.

## Using settings in code

\`\`\`ts
import { type AppSettings, channelSetting, settingsWith } from "@repo/settings";
import { createSettingsResolver, loadSettings } from "@repo/settings/server";

// Once per turn. Keep the snapshot; do not resolve again in the middle of a turn.
const settings = await createSettingsResolver({ db }).resolve({ agencyId, businessId });
// ...or inside a transaction you already hold:
const same = await loadSettings(ctx, { agencyId, businessId });

settings.values["pricing.disclosure"];                              // "never" | "ranges" | "exact"
settings.sources["pricing.disclosure"];                             // { scope, version, updatedAt }
channelSetting(settings.values, "follow_up.max_nudges", channel);  // per-channel settings
settings.version;                                                   // store it with what you decide

// Tests and evaluation profiles: defaults plus overrides, validated.
const profile = settingsWith({ "pricing.disclosure": "ranges", "voice.emoji": "never" });
\`\`\`

- \`@repo/settings\` is safe in the browser (registry, types, pure resolver, access rules).
  \`@repo/settings/server\` holds everything that touches the database.
- Changing settings for a signed-in user:
  \`createSettingsService({ db }).updateForUser(user, { target, changes, note })\`. From a job:
  \`applySettingChanges(ctx, { target, changes, actor })\`. Never write \`setting_values\` yourself.
- The settings screen: \`service.viewForUser(user, target)\` returns, per setting, the value in
  force, its source, the inherited value, the scope's own override and whether the user may
  edit or reset it. Draw the control from the setting's \`field\`: switch on \`kind\` (boolean,
  text, number, select, multi_select, list, object, nullable) and recurse into \`item\`,
  \`properties\` and \`inner\`; \`blankValue(field)\` gives the starting value of a new list
  entry, \`checkSettingValue(key, value, scope)\` validates in the browser with the same rules
  as the store. A definition holds a Zod schema, so pass setting keys, not definitions, from
  server components to client components, and look the definition up there with
  \`findSetting(key)\`.
- Text settings with placeholders are filled with \`renderTemplate(text, values)\`.
- Never read settings in a client user's database context: row-level security hides the
  rows from them, so the engine refuses instead of quietly returning defaults. Use the
  service (\`viewForUser\`) or the business's system scope after checking their role;
  \`clientPermissionAllows(values["client_portal.view_leads"], role)\` answers the
  \`client_portal.*\` permissions.
- Segment starting values: \`applySegmentPreset(ctx, { segmentId, slug })\` writes the preset
  of a known trade (\`SEGMENT_PRESETS\`: roofing, hvac, plumbing, electrical, remodeling) as
  ordinary segment overrides when a segment is first served.
- \`pnpm db:seed\` loads demo settings for the demo agency after the demo data.

## Adding a setting

1. Add one entry to the file of its category in \`packages/settings/src/registry\`, with
   \`setting({ label, help, field, default, scopes?, clientEditable?, sensitive? })\`. The key
   starts with the category id. Build the field with \`f\` (\`f.boolean()\`, \`f.text()\`,
   \`f.integer()\`, \`f.select()\`, \`f.multiSelect()\`, \`f.list()\`, \`f.object()\`,
   \`f.nullable()\`); the type of the value follows from it.
2. Run \`pnpm settings:docs\`.
3. Use it: \`settings.values["your.key"]\` is typed. The settings screen shows it without any
   UI change.

Prefer several small settings over one large object, so that a business can override one
knob and inherit the rest. Changing the shape of an existing setting makes stored overrides
of the old shape invalid (they are skipped, not migrated): add a new key instead, or migrate
the stored rows in the same change.
`;

/** The whole of docs/SETTINGS.md. */
export function renderSettingsDocs(): string {
  const groups = settingsByCategory();
  const lines: string[] = [INTRO];

  lines.push("## Placeholders", "");
  lines.push(
    "Text settings whose type lists placeholders may contain them as `{{name}}`. Using a",
    "placeholder a setting does not list is a validation error.",
    "",
    "| Placeholder | Filled with |",
    "| --- | --- |",
  );
  for (const [name, description] of Object.entries(TEMPLATE_VARIABLES)) {
    lines.push(`| \`{{${name}}}\` | ${cell(description)} |`);
  }
  lines.push("");

  lines.push("## Catalogue", "");
  lines.push(
    `${SETTING_DEFINITIONS.length} settings in ${groups.length} categories.`,
    "",
    "| Category | Settings | What it covers |",
    "| --- | --- | --- |",
  );
  for (const { category, settings } of groups) {
    lines.push(
      `| [${category.label}](#${category.id}) | ${settings.length} | ${cell(category.description)} |`,
    );
  }
  lines.push("");

  for (const { category, settings } of groups) {
    lines.push(`<a id="${category.id}"></a>`, "", `### ${category.label}`, "");
    lines.push(category.description, "");
    lines.push(
      "| Key | Setting | Type | Default | Scopes | Client may edit |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const definition of settings) lines.push(settingRow(definition));
    lines.push("");
    for (const definition of settings) lines.push(...settingDetails(definition));
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Categories that have no settings yet, for the registry test. */
export function emptyCategories(): string[] {
  const used = new Set(SETTING_DEFINITIONS.map((definition) => definition.category));
  return SETTING_CATEGORIES.filter((category) => !used.has(category.id)).map(
    (category) => category.id,
  );
}
