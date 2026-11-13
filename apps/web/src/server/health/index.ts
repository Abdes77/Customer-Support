import { deploymentInfo, developmentModeRequested, getEnv, nodeEnv } from "@repo/core/env";
import { alerts, and, eq, getDatabase, gt, inArray, sql } from "@repo/db";
import { countUnansweredMessages } from "@repo/pipeline";

import { errorReportingEnabled } from "../observability";
import { getServerPipeline } from "../pipeline";
import { createReadinessCache, evaluateReadiness, type ReadinessFacts } from "./readiness";

export {
  authorizedForDetails,
  evaluateReadiness,
  mayReadDetails,
  readinessBody,
} from "./readiness";

/** The readiness facts of this process: its environment, its pipeline and its database. */
export function readinessFacts(now: () => Date = () => new Date()): ReadinessFacts {
  const env = getEnv();
  const deployment = deploymentInfo();
  const db = getDatabase();
  const server = getServerPipeline();
  return {
    env,
    deployment,
    runtime: nodeEnv(),
    developmentMode: developmentModeRequested(),
    jobs: server.mode,
    model: server.modelMode,
    testChannel: server.testChannel !== null,
    widget: server.widget !== null,
    errorReporting: errorReportingEnabled(),
    activeBusinesses: () => db.directory.listBusinesses({ statuses: ["active"] }),
    emergencyReady: (tenant) => server.handoff.service.readiness(tenant),
    stuckWork: (tenant) =>
      db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
        const since = new Date(now().getTime() - 86_400_000);
        const [row] = await ctx.tx
          .select({ total: sql<number>`count(*)::int` })
          .from(alerts)
          .where(
            and(
              eq(alerts.channel, "in_app"),
              inArray(alerts.kind, ["send_stuck", "ingest_stuck"]),
              gt(alerts.createdAt, since),
            ),
          );
        return row?.total ?? 0;
      }),
    unansweredMessages: (tenant) =>
      db
        .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
        .run((ctx) => countUnansweredMessages(ctx, now())),
  };
}

const cachedReadiness = createReadinessCache({
  evaluate: () => evaluateReadiness(readinessFacts()),
  now: () => Date.now(),
});

/** This process's readiness, evaluated at most once every few seconds (the route is public). */
export async function checkReadiness() {
  return cachedReadiness();
}
