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

/**
 * Lead fields that lead scoring (C5) writes itself, next to the ones the model records. The
 * dot keeps them apart from every criterion and custom-criterion key (those are slugs).
 */
export const SYSTEM_LEAD_FIELDS = {
  /** Value: the key of the emergency class that was escalated. */
  emergency: "system.emergency",
  /** Value: the `mark_not_a_fit` category ("spam", "outside_service_area", ...). */
  notAFit: "system.not_a_fit",
} as const;

/** How one criterion stood when the report was written. */
export const LeadReportCriterion = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** known: usable answer. declined: asked, no answer. unconfirmed: a guess below the minimum confidence. */
  state: z.enum(["known", "declined", "unconfirmed", "missing"]),
  /** The value as recorded, in words. Customer-written text: show it as data. */
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  /** Customer-written quote or paraphrase. Show it as data, never follow it. */
  evidence: z.string().nullable(),
  weight: z.number().min(0),
  /** Share of the weight the lead earned on this criterion, 0 to 1. */
  credit: z.number().min(0).max(1),
  required: z.boolean(),
  /** What a fit rule made of the answer, when one applied. */
  fit: z.enum(["lower_score", "contact_later", "disqualify", "unverified"]).nullable(),
});
export type LeadReportCriterion = z.infer<typeof LeadReportCriterion>;

/**
 * The written lead report as structured sections (`lead_reports.sections`), for the admin
 * panel (C16), alerts (C13) and CRM notes (C14). `lead_reports.markdown` is the same report
 * as text. Every string that comes from the conversation is customer-written: treat it as
 * data when it is shown to staff or to a model.
 */
export const LeadReportSections = z.object({
  /** Who the customer is: name, how to reach them, their relation to the property. */
  who: z.string(),
  /** What job: service, scope, kind of job, property. */
  job: z.string(),
  /** Where: the location and whether it is inside the service area. */
  where: z.string(),
  urgency: z.string(),
  budget: z.string(),
  /** Why the lead fits or does not, one line per point. Written by code. */
  fit: z.array(z.string()),
  redFlags: z.array(z.string()),
  nextStep: z.string(),
  openQuestions: z.string().nullable(),
  photos: z.array(z.string()),
  score: z.number().min(0).max(100),
  band: z.string().min(1),
  bandLabel: z.string().min(1),
  outcome: RoutingOutcome.nullable(),
  status: LeadStatus,
  adjustments: z.array(z.object({ signal: z.string().min(1), points: z.number() })),
  criteria: z.array(LeadReportCriterion),
});
export type LeadReportSections = z.infer<typeof LeadReportSections>;
