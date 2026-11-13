import { NextResponse } from "next/server";

import { deploymentInfo, getEnv, nodeEnv } from "@repo/core/env";
import { logger } from "@repo/core";

import { checkReadiness, mayReadDetails, readinessBody } from "@/server/health";

export const dynamic = "force-dynamic";

/**
 * Readiness (C17): 200 when this deployment can serve customers safely, 503 when a check
 * failed (database, jobs, Claude API, required variables, a development-only switch in a
 * production build others can reach). The verdict is public and is all an anonymous caller
 * gets; the checks (which one failed, which variables, which businesses' emergencies reach
 * nobody) need `Authorization: Bearer <HEALTH_CHECK_TOKEN>`, except on a developer machine.
 * One evaluation answers every request for a few seconds.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const headers = { "cache-control": "no-store" };
  try {
    const report = await checkReadiness();
    const detailed = mayReadDetails(request, {
      env: getEnv(),
      deployment: deploymentInfo(),
      runtime: nodeEnv(),
    });
    return NextResponse.json(readinessBody(report, detailed), {
      status: report.status === "ready" ? 200 : 503,
      headers,
    });
  } catch (error) {
    logger.error("health.readiness_failed", { error });
    return NextResponse.json({ status: "not_ready" }, { status: 503, headers });
  }
}
