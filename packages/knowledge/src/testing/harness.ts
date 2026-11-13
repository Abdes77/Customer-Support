import { randomBytes } from "node:crypto";

import type { ModelClient } from "@repo/ai";
import { createScriptedModelClient, type ScriptedModelClient } from "@repo/ai/testing";
import { type AgencyId, createLogger, type LogRecord } from "@repo/core";
import { agencyMemberships, businesses, type BusinessTenant, type UserIdentity } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, type JobDefinition, type LocalJobRunner } from "@repo/jobs";

/**
 * A database, an in-process job runner and a scripted model for the tests of this package.
 * `newAgency()` gives each test its own agency with staff and businesses, so tests that
 * count playbook versions or imports do not see each other's rows.
 */

export interface TestAgency {
  readonly agencyId: AgencyId;
  readonly admin: UserIdentity;
  readonly member: UserIdentity;
  /** A signed-in user with no membership in this agency. */
  readonly outsider: UserIdentity;
  /** Creates a business of the agency (status "onboarding", no segment). */
  newBusiness(options?: {
    readonly name?: string;
    readonly state?: string | null;
    readonly websiteUrl?: string | null;
    readonly externalRef?: string | null;
  }): Promise<BusinessTenant>;
}

export interface KnowledgeHarness {
  readonly t: TestDatabase;
  readonly runner: LocalJobRunner;
  readonly model: ScriptedModelClient;
  readonly logs: LogRecord[];
  readonly logger: ReturnType<typeof createLogger>;
  /** The clock the code under test uses; tests move it. */
  now: Date;
  readonly clock: () => Date;
  register(jobs: readonly JobDefinition[]): void;
  newAgency(): Promise<TestAgency>;
  dispose(): Promise<void>;
}

const unique = (prefix: string) => `${prefix}-${randomBytes(5).toString("hex")}`;

export async function createKnowledgeHarness(
  options: { readonly model?: ModelClient } = {},
): Promise<KnowledgeHarness> {
  const t = await createTestDatabase();
  const logs: LogRecord[] = [];
  const logger = createLogger({ level: "debug", sink: (record) => logs.push(record) });
  const runner = createLocalJobRunner({ logger, retryDelayMs: () => 5 });
  const model = (options.model as ScriptedModelClient | undefined) ?? createScriptedModelClient();

  const harness: KnowledgeHarness = {
    t,
    runner,
    model,
    logs,
    logger,
    now: new Date("2026-11-12T15:00:00.000Z"),
    clock: () => harness.now,
    register(jobs) {
      runner.register(jobs);
    },

    async newAgency() {
      const slug = unique("agency");
      const { id: agencyId } = await t.db.platform.createAgency({ name: `Agency ${slug}`, slug });
      const user = async (name: string): Promise<UserIdentity> => {
        const created = await t.db.localAuth.upsertUser({ email: `${name}@${slug}.test` });
        return { id: created.id, email: created.email };
      };
      const admin = await user("admin");
      const member = await user("member");
      const outsider = await user("outsider");
      await t.admin.insert(agencyMemberships).values([
        { agencyId, userId: admin.id, role: "agency_admin" },
        { agencyId, userId: member.id, role: "agency_member" },
      ]);
      return {
        agencyId,
        admin,
        member,
        outsider,
        async newBusiness(business = {}) {
          const businessSlug = unique("biz");
          const [row] = await t.admin
            .insert(businesses)
            .values({
              agencyId,
              name: business.name ?? `Business ${businessSlug}`,
              slug: businessSlug,
              state: business.state === undefined ? "CO" : business.state,
              websiteUrl: business.websiteUrl ?? null,
              externalRef: business.externalRef ?? null,
            })
            .returning({ id: businesses.id });
          if (row === undefined) throw new Error("Business insert returned no row");
          return { agencyId, businessId: row.id };
        },
      };
    },

    async dispose() {
      runner.stop();
      await t.dispose();
    },
  };
  return harness;
}
