import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderSettingsDocs } from "../src/docs";

/** Usage: pnpm settings:docs. Rewrites docs/SETTINGS.md at the repository root from the registry. */
const target = path.resolve(import.meta.dirname, "../../../docs/SETTINGS.md");
writeFileSync(target, renderSettingsDocs());
console.log(`Wrote ${target}`);
