import { z } from "zod";

import { IsoDateTime, LeadId } from "../ids";

/**
 * Lead vocabulary shared by the engine (C4), scoring and routing (C5), alerts (C13),
 * connectors (C14) and the admin panel (C16). C5 owns it and may extend it additively.
 */

export const LEAD_STATUSES = [
  "new",
  "qualifying",
  "qualified",
  "meeting_requested",
  "meeting_booked",
  "handed_off",
  "disqualified",
] as const;
export const LeadStatus = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatus>;

/** What the customer is told once the score is known. Driven entirely by routing settings. */
export const ROUTING_OUTCOMES = ["book_meeting", "contact_later", "disqualify"] as const;
export const RoutingOutcome = z.enum(ROUTING_OUTCOMES);
export type RoutingOutcome = z.infer<typeof RoutingOutcome>;

/** One qualification criterion as currently known, with the evidence it rests on. */
export const LeadFieldValue = z.object({
  /** Criterion key from the settings registry, for example "timeline" or "budget_band". */
  key: z.string().min(1),
  value: z.json(),
  /** 0 = guess, 1 = stated outright by the customer. */
  confidence: z.number().min(0).max(1),
  /** Short quote or paraphrase from the conversation that supports the value. */
  evidence: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type LeadFieldValue = z.infer<typeof LeadFieldValue>;

export const RoutingDecision = z.object({
  outcome: RoutingOutcome,
  /** 0 to 100, computed from criterion weights in settings. */
  score: z.number().min(0).max(100),
  /** Key of the score band that matched, as declared in settings. */
  band: z.string().min(1),
  /** Human-readable reasons, safe to show in the admin panel. */
  reasons: z.array(z.string()),
  decidedAt: IsoDateTime,
  /** `ResolvedSettings.version` the decision was computed under. */
  settingsVersion: z.string().min(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

/** The lead as the engine sees it at the start of a turn. */
export const LeadSnapshot = z.object({
  /** Null until the first field is recorded. */
  id: LeadId.nullable(),
  status: LeadStatus,
  fields: z.record(z.string(), LeadFieldValue),
  routing: RoutingDecision.nullable(),
});
export type LeadSnapshot = z.infer<typeof LeadSnapshot>;
