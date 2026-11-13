import { z } from "zod";

import { ChannelId } from "../contracts/channel";
import { RoutingOutcome } from "../contracts/lead";
import {
  AgencyId,
  BusinessId,
  ContactId,
  ConversationId,
  IsoDateTime,
  LeadId,
  TraceId,
} from "../ids";

/**
 * Lead events (emitted by C5; consumed by C12 scheduling, C13 alerts and escalation,
 * C14 connectors and C16 analytics).
 *
 * Payloads carry ids and classifications only, never customer text: event payloads are
 * stored by the job platform, so subscribers load details from the database under tenant
 * scope. `eventId` is the idempotency key; delivery is at least once.
 */
const LeadEventBase = z.object({
  eventId: z.uuid(),
  occurredAt: IsoDateTime,
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  conversationId: ConversationId,
  contactId: ContactId,
  leadId: LeadId,
  channel: ChannelId,
  /** 0 to 100 at the moment of the event. */
  score: z.number().min(0).max(100),
  band: z.string().min(1),
});

/** The lead crossed the qualification threshold. The report is ready to read. */
export const LeadQualifiedEvent = LeadEventBase.extend({
  routing: RoutingOutcome,
});
export type LeadQualifiedEvent = z.infer<typeof LeadQualifiedEvent>;

/** Routing chose "book a meeting" and the customer is being offered times or a link. */
export const LeadMeetingRequestedEvent = LeadEventBase.extend({
  bookingMode: z.enum(["calendar", "calendly_link", "manual"]),
});
export type LeadMeetingRequestedEvent = z.infer<typeof LeadMeetingRequestedEvent>;

/** The conversation is handed to a person: "we'll contact you", a request, or a rule. */
export const LeadHandoffEvent = LeadEventBase.extend({
  routing: RoutingOutcome,
  trigger: z.enum(["routing", "customer_request", "bot_decision", "rule"]),
  urgency: z.enum(["normal", "high"]),
});
export type LeadHandoffEvent = z.infer<typeof LeadHandoffEvent>;

/** The lead is not a fit and was told so politely. */
export const LeadDisqualifiedEvent = LeadEventBase.extend({
  /** Short machine-readable reason, for example "out_of_area" or "not_decision_maker". */
  reasonCode: z.string().min(1),
});
export type LeadDisqualifiedEvent = z.infer<typeof LeadDisqualifiedEvent>;

/** An emergency was detected. Starts the escalation chain immediately. */
export const LeadEmergencyEvent = LeadEventBase.extend({
  /** Emergency class key from the emergency settings, for example "gas_leak". */
  emergencyClass: z.string().min(1),
});
export type LeadEmergencyEvent = z.infer<typeof LeadEmergencyEvent>;

/** The names of the lead events, for the outbox table's CHECK constraint and for filters. */
export const LEAD_EVENT_NAMES = [
  "lead.qualified",
  "lead.meeting_requested",
  "lead.handoff",
  "lead.disqualified",
  "lead.emergency",
] as const;
export type LeadEventName = (typeof LEAD_EVENT_NAMES)[number];

export const LEAD_EVENTS = {
  "lead.qualified": LeadQualifiedEvent,
  "lead.meeting_requested": LeadMeetingRequestedEvent,
  "lead.handoff": LeadHandoffEvent,
  "lead.disqualified": LeadDisqualifiedEvent,
  "lead.emergency": LeadEmergencyEvent,
} as const satisfies Record<LeadEventName, z.ZodType>;
