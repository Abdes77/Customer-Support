import { preflight } from "@/server/widget/http";
import { sessionHandler } from "@/server/widget/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Starts a visitor session, or resumes the one whose token the browser kept. */
export const POST = sessionHandler();
export const OPTIONS = preflight;
