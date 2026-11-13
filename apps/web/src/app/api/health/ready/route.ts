import { NextResponse } from "next/server";

import { deploymentInfo, getEnv } from "@repo/core/env";
import { logger } from "@repo/core";

import { authorizedForDetails, checkReadiness, readinessBody } from "@/server/health";

export const dynamic = "force-dynamic";

/**
 * Readiness (C17): 200 when this deployment can serve customers safely, 503 when a check
 * failed (database, jobs, Claude API, required variables, a development-only switch in a
 * production build others can reach). Each check's name and status are public; the details
 * (which variables, which businesses' emergencies reach nobody) need
 * `Authorization: Bearer <HEALTH_CHECK_TOKEN>`, except on a developer machine.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const headers = { "cache-control": "no-store" };
  try {
    const report = await checkReadiness();
    const detailed =
      deploymentInfo().environment === "local" || authorizedForDetails(request, getEnv());
    return NextResponse.json(readinessBody(report, detailed), {
      status: report.status === "ready" ? 200 : 503,
      headers,
    });
  } catch (error) {
    logger.error("health.readiness_failed", { error });
    return NextResponse.json({ status: "not_ready", checks: [] }, { status: 503, headers });
  }
}
