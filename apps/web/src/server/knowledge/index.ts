import { logger as rootLogger } from "@repo/core";
import { getDatabase } from "@repo/db";
import type { ImportApiDeps, KnowledgeServices } from "@repo/knowledge";

import { getServerPipeline } from "@/server/pipeline";

/**
 * Playbooks and business knowledge for the app (C6). The services are built with the
 * pipeline (`@/server/pipeline`), so that a playbook generation or a website crawl asked for
 * here reaches the same job runner the rest of the app uses.
 *
 * - `getKnowledge().playbooks`: segments, versions, diff, rollback, overrides, onboarding a
 *   business in a segment.
 * - `getKnowledge().knowledge`: facts, CSV import, website crawl.
 * - `getKnowledge().apiKeys`: keys for the import API.
 *
 * Every method takes the signed-in user and checks the role itself; a screen still calls
 * `requireAccess()` first.
 */
export function getKnowledge(): KnowledgeServices {
  return getServerPipeline().knowledge;
}

/** What the import API routes (`/api/v1/knowledge/*`) need. They authenticate by API key. */
export function importApiDeps(): ImportApiDeps {
  return { db: getDatabase(), logger: rootLogger.child({ component: "import-api" }) };
}
