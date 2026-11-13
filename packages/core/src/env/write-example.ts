import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderEnvExample } from "./example";

/** Usage: pnpm env:example. Rewrites .env.example at the repository root from the spec. */
const target = path.resolve(import.meta.dirname, "../../../../.env.example");
writeFileSync(target, renderEnvExample());
console.log(`Wrote ${target}`);
