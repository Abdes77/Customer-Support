/**
 * pnpm --filter @repo/knowledge api-key --slug agency-slug --name "Lead-gen sync"
 *   [--business <business id>] [--read-only]
 *
 * Creates a key for the import API (`/api/v1/knowledge/*`) from the command line, for the
 * first integration on a new installation, before the admin panel has a screen for it. The
 * key is printed once and cannot be shown again: only its hash is stored. Revoke a key in
 * the admin panel, or by setting `revoked_at` on its row.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { BusinessId, ConfigError, ValidationError } from "@repo/core";
import { getEnv } from "@repo/core/env";
import { createDatabase } from "@repo/db";

import { createApiKeyAsSystem } from "../src/import/api-keys";
import { IMPORT_SCOPE_READ, IMPORT_SCOPE_WRITE } from "../src/import/http";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      business: { type: "string" },
      "read-only": { type: "boolean" },
    },
  });
  if (values.slug === undefined || values.name === undefined) {
    throw new ValidationError(
      'Usage: pnpm --filter @repo/knowledge api-key --slug agency-slug --name "Lead-gen sync" [--business <id>] [--read-only]',
    );
  }
  const businessId = values.business === undefined ? null : BusinessId.safeParse(values.business);
  if (businessId !== null && !businessId.success) {
    throw new ValidationError("--business is the id of a business (a UUID).");
  }
  const env = getEnv();
  if (env.DATABASE_URL === undefined) throw new ConfigError("Set DATABASE_URL.");
  const db = createDatabase({ url: env.DATABASE_URL, max: 2, applicationName: "hsrb-api-key" });
  try {
    const agency = await db.platform.findAgencyBySlug(values.slug);
    if (agency === null) throw new ValidationError(`There is no agency "${values.slug}".`);
    const created = await createApiKeyAsSystem(db, {
      agencyId: agency.id,
      name: values.name,
      businessId: businessId?.data ?? null,
      scopes: values["read-only"] === true ? [IMPORT_SCOPE_READ] : [IMPORT_SCOPE_WRITE],
    });
    console.log(`Created API key "${created.name}" (${created.prefix}) for ${agency.name}.`);
    console.log(
      `Scopes: ${created.scopes.join(", ")}${created.businessId === null ? "" : `; business ${created.businessId}`}`,
    );
    console.log("\nThe key, shown this once:\n");
    console.log(created.key);
    console.log("\nSend it as: Authorization: Bearer <key>");
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
