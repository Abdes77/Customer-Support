/**
 * pnpm demo:setup [--slug agency-slug] [--agency "Agency name"]
 *
 * Stores the sample businesses of the public demo site (`/demo`) in an agency: one per trade
 * (roofing, HVAC, plumbing, electrical, kitchen and bath remodeling), each with its facts, its
 * trade's playbook, the website chat and the "Public demo page" setting on. Safe to run
 * again: it updates what it wrote and keeps what a person changed in the admin panel.
 *
 * Without --slug the agency is "demo" (created as "Demo agency" when it does not exist yet).
 * Name your own agency's slug to keep the samples next to your clients; then every agency
 * admin sees the demo conversations and leads in the inbox.
 *
 * Reads DATABASE_URL from the environment or the repository's .env.local, like `pnpm db:*`.
 * It works on any database, production included: it only ever touches the sample businesses.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, ValidationError } from "@repo/core";
import { getEnv } from "@repo/core/env";
import { createDatabase } from "@repo/db";

import { provisionDemo } from "../src/server/demo/provision";

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
  const { values } = parseArgs({
    // pnpm passes a literal "--" through when the command is written with one.
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: { slug: { type: "string" }, agency: { type: "string" } },
  });
  const slug = values.slug ?? "demo";
  const env = getEnv();
  if (env.DATABASE_URL === undefined) throw new ConfigError("Set DATABASE_URL.");
  const db = createDatabase({ url: env.DATABASE_URL, max: 2, applicationName: "hsrb-demo" });
  try {
    let agency = await db.platform.findAgencyBySlug(slug);
    if (agency === null) {
      const name = values.agency ?? (values.slug === undefined ? "Demo agency" : undefined);
      if (name === undefined) {
        throw new ValidationError(
          `There is no agency "${slug}". Add --agency "Name" to create it.`,
        );
      }
      agency = { id: (await db.platform.createAgency({ name, slug })).id, name };
      console.log(`Created agency "${name}" (${slug}).`);
    }

    const businesses = await provisionDemo({ db, agencyId: agency.id });
    console.log(`\nSample businesses in "${agency.name}":`);
    for (const business of businesses) {
      const facts = `${business.facts.created} facts added, ${business.facts.updated} updated, ${business.facts.kept} kept`;
      console.log(
        `  ${business.created ? "created" : "updated"}  ${business.name} (${business.segment}): ${facts}; playbook ${
          business.playbook === "stored" ? "starter stored" : "already there"
        }`,
      );
    }
    const appUrl = (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    console.log(`\nThe demo site: ${appUrl}/demo`);
    for (const business of businesses) console.log(`  ${appUrl}/demo/${business.slug}`);
    if (businesses.some((business) => business.playbook === "stored")) {
      console.log(
        '\nThe trades got the built-in starter playbook. For one researched by the model, open the\ntrade under Playbooks in the admin panel and choose "Generate again".',
      );
    }
    console.log(
      `\nTo see the demo conversations and leads in the admin panel, be an admin of this agency:\n  pnpm db:create-admin --slug ${slug} --email you@example.com`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
