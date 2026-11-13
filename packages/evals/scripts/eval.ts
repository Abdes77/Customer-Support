/**
 * `pnpm eval`: the evaluation suite (see `pnpm eval --help` and docs/ARCHITECTURE.md,
 * "As built (C7)").
 *
 * With ANTHROPIC_API_KEY (from the shell or the root .env.local) the Claude API writes the
 * replies, plays the customers and judges them. Without it the run is a mock run: stand-ins
 * for all three, which checks the harness and the rules the engine enforces in code.
 */
import path from "node:path";

import { getEnv } from "@repo/core/env";

import { main } from "../src/cli";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(repoRoot, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const env = getEnv();
const code = await main(process.argv.slice(2), {
  print: (line) => console.log(line),
  apiKey: env.ANTHROPIC_API_KEY,
  baseUrl: env.ANTHROPIC_BASE_URL,
  repoRoot,
});
process.exitCode = code;
// A conversation that ran into its time limit can leave a model call in flight; the run is
// over and its results are written, so do not let that call keep the process open.
setTimeout(() => process.exit(code), 5000).unref();
