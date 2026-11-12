import { preflight } from "@/server/widget/http";
import { listMessagesHandler, postMessageHandler } from "@/server/widget/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Storing a photo and ingesting take well under this.
export const maxDuration = 30;

/** The visitor's conversation since a cursor, and whether a reply is being written. */
export const GET = listMessagesHandler();
/** A visitor's message: JSON for text, multipart form data for a photo. */
export const POST = postMessageHandler();
export const OPTIONS = preflight;
