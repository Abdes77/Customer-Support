import { preflight } from "@/server/widget/http";
import { profileHandler } from "@/server/widget/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The pre-chat details (name, phone, email) the business asks for. */
export const POST = profileHandler();
export const OPTIONS = preflight;
