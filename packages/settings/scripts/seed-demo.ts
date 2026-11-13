/**
 * pnpm db:seed runs this after the demo data of @repo/db: it writes the demo agency's
 * settings (an agency-wide house style, segment starting values, two businesses). It
 * refuses to run against production, like the seed it follows.
 */
import path from "node:path";

import { ConfigError } from "@repo/core";
import { deploymentInfo, getEnv, isProduction } from "@repo/core/env";
import { createDatabase } from "@repo/db";

import { seedDemoSettings } from "../src/server/demo";

function loadRootEnv(): void {
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  if (isProduction() || deploymentInfo().environment === "production") {
    throw new ConfigError("The seed never runs in production.");
  }
  const env = getEnv();
  if (env.DATABASE_URL === undefined) {
    throw new ConfigError(
      "Set DATABASE_URL. Copy .env.example to .env.local for local development.",
    );
  }
  const db = createDatabase({ url: env.DATABASE_URL, max: 2, applicationName: "hsrb-seed" });
  try {
    const { written } = await seedDemoSettings(db);
    console.log(
      `Demo settings loaded: ${written} overrides (agency, two segments, two businesses).`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
