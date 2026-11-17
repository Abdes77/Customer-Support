import { preflight } from "@/server/widget/http";
import { demoLeadHandler } from "@/server/widget/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * The lead the assistant is building from the visitor's own conversation: score, answers,
 * routing and report. Exists only for a business whose public demo page is switched on
 * (`channels.widget.demo_page`); for every other business it answers 404.
 */
export const GET = demoLeadHandler();
export const OPTIONS = preflight;
