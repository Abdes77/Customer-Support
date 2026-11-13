import { getServerPipeline } from "@/server/pipeline";
import { createWebhookHandler } from "@/server/pipeline/webhook-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Ingest stores and emits only; it answers well within this (ARCHITECTURE §2, step 7).
export const maxDuration = 30;

const handle = createWebhookHandler(() => getServerPipeline().pipeline);

/** Subscription handshakes (Meta's hub.challenge) and anything else a provider sends by GET. */
export const GET = handle;

/** Inbound messages, delivery statuses and signals, verified by the channel's adapter. */
export const POST = handle;
