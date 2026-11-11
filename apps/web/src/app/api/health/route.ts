import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "web";
  readonly time: string;
}

/**
 * Liveness check: answers as long as the app can serve a request. It deliberately touches no
 * database or vendor; C17 adds a readiness check with dependency status next to it.
 */
export function GET(): NextResponse<HealthResponse> {
  return NextResponse.json(
    { status: "ok", service: "web", time: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
