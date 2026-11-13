import { preflight } from "@/server/widget/http";
import { configHandler } from "@/server/widget/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The widget's appearance and behaviour, for a site on the business's allowed list. */
export const GET = configHandler();
export const OPTIONS = preflight;
