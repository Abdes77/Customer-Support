import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import { businesses, eq, knowledgeItems, playbookVersions } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createApiKeyAsSystem } from "@repo/knowledge";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";

import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

/*
 * The import API as the app serves it: the route modules, with the database of a test and
 * the app's own composition behind them.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;

vi.mock("@/server/knowledge", () => ({
  getKnowledge: () => server.knowledge,
  importApiDeps: () => ({ db: t.db, logger: quiet }),
}));

beforeAll(async () => {
  t = await createTestDatabase();
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({}),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789abcdef",
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

async function tenant() {
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [business] = await t.admin
    .insert(businesses)
    .values({ agencyId, name: "Summit Roofing", slug: "summit", externalRef: "crm-1" })
    .returning({ id: businesses.id });
  const { key } = await createApiKeyAsSystem(t.db, { agencyId, name: "Lead-gen sync" });
  return { agencyId, businessId: business!.id, key };
}

describe("/api/v1/knowledge", () => {
  it("imports JSON and CSV with an API key, reports the run, and refuses everyone else", async () => {
    const { businessId, key } = await tenant();
    const { POST: importJson } = await import("./import/route");
    const { POST: importCsv } = await import("./import/csv/route");
    const { GET: importStatus } = await import("./imports/[id]/route");
    const auth = { authorization: `Bearer ${key}` };

    const unauthenticated = await importJson(
      new Request("http://localhost:3000/api/v1/knowledge/import", { method: "POST", body: "{}" }),
    );
    expect(unauthenticated.status).toBe(401);

    const json = await importJson(
      new Request("http://localhost:3000/api/v1/knowledge/import", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          businesses: [
            {
              externalRef: "crm-1",
              facts: [{ category: "services", title: "Services", content: "Roof repair." }],
            },
          ],
        }),
      }),
    );
    expect(json.status).toBe(200);
    const result = (await json.json()) as { importRunId: string; status: string };
    expect(result.status).toBe("succeeded");

    const csv = await importCsv(
      new Request("http://localhost:3000/api/v1/knowledge/import/csv?external_ref=crm-1", {
        method: "POST",
        headers: { ...auth, "content-type": "text/csv" },
        body: "Warranty,Financing\n10-year workmanship warranty,Plans through a lending partner\n",
      }),
    );
    expect(csv.status).toBe(200);
    const malformed = await importCsv(
      new Request("http://localhost:3000/api/v1/knowledge/import/csv?external_ref=crm-1", {
        method: "POST",
        headers: { ...auth, "content-type": "text/csv" },
        body: 'Warranty\n"never closed\n',
      }),
    );
    expect(malformed.status).toBe(422);

    const status = await importStatus(
      new Request(`http://localhost:3000/api/v1/knowledge/imports/${result.importRunId}`, {
        headers: auth,
      }),
      { params: Promise.resolve({ id: result.importRunId }) },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "succeeded", kind: "api" });
    const missing = await importStatus(
      new Request("http://localhost:3000/api/v1/knowledge/imports/nope", { headers: auth }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(missing.status).toBe(404);

    const facts = await t.admin
      .select({ category: knowledgeItems.category, source: knowledgeItems.source })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.businessId, businessId))
      .orderBy(knowledgeItems.category);
    expect(facts).toEqual([
      { category: "financing", source: "csv_import" },
      { category: "services", source: "api" },
      { category: "warranties", source: "csv_import" },
    ]);
  });

  it("runs the knowledge jobs with the app's own composition: a starter playbook without a key", async () => {
    expect(server.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining(["knowledge-playbook-generate", "knowledge-import"]),
    );
    expect(server.modelMode).toBe("offline");
    const { id: agencyId } = await t.db.platform.createAgency({ name: "Other", slug: "other" });
    const [business] = await t.admin
      .insert(businesses)
      .values({ agencyId, name: "Bug Busters", slug: "bug-busters" })
      .returning({ id: businesses.id });
    const admin = await t.db.localAuth.upsertUser({ email: "admin@other.test" });
    await t.db.forAgency(agencyId).run(async (ctx) => {
      const { agencyMemberships } = await import("@repo/db");
      await ctx.tx
        .insert(agencyMemberships)
        .values({ agencyId, userId: admin.id, role: "agency_admin" });
    });

    const assigned = await server.knowledge.playbooks.assignSegment(
      { id: admin.id },
      { businessId: business!.id, segment: { name: "Pest Control" } },
    );
    expect(assigned.playbook.status).toBe("generating");
    await runner.idle();
    const versions = await t.admin
      .select({
        version: playbookVersions.version,
        origin: playbookVersions.origin,
        isActive: playbookVersions.isActive,
      })
      .from(playbookVersions)
      .where(eq(playbookVersions.segmentId, assigned.segment.id));
    // No ANTHROPIC_API_KEY on this machine: the built-in starter document, marked as such.
    expect(versions).toEqual([{ version: 1, origin: "starter", isActive: true }]);
    const again = await server.knowledge.playbooks.assignSegment(
      { id: admin.id },
      { businessId: business!.id, segment: { name: "Pest Control" } },
    );
    expect(again.playbook).toEqual({ status: "reused", version: 1 });
  });
});
