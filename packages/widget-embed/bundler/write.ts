/**
 * pnpm --filter @repo/widget-embed build
 *
 * Bundles the widget and writes src/bundle.generated.ts, which the app serves. Run it after
 * changing anything in src/browser; `pnpm verify` fails while the file is stale.
 */
import { writeFile } from "node:fs/promises";

import { bundleWidget, GENERATED, generatedModule, GZIP_BUDGET_BYTES } from "./bundle";

const bundle = await bundleWidget();
await writeFile(GENERATED, generatedModule(bundle), "utf8");
process.stdout.write(
  `Wrote src/bundle.generated.ts: ${bundle.rawBytes} bytes, ${bundle.gzipBytes} bytes gzipped (budget ${GZIP_BUDGET_BYTES}).\n`,
);
