/**
 * @repo/handoff (owner: C13)
 *
 * Alerts, the emergency escalation chain, human takeover and follow-up nudges. Server only.
 * ARCHITECTURE §2 "As built (C13)" describes it.
 *
 * - `handoffDomainParts(deps)`: the `escalate_emergency`, `handoff_to_human` and
 *   `schedule_follow_up` handlers, the turn observer (takeover on handoff, nudge planning),
 *   the inbound observer (opt-out and opt-in words, a reply stops follow-ups, takeover
 *   activity), the opt-out guard and the quiet-hours send gate; registered in the pipeline's
 *   domain composition.
 * - `createHandoffJobs(deps)`: alert subscribers to `lead.*` and `message.send_failed`, the
 *   emergency start and chain, the idle takeover release, follow-ups and the sweeper;
 *   registered in apps/web.
 * - `createHandoffService(deps)`: takeover, release, manual replies, opt-out, escalations,
 *   follow-ups, test alerts and the emergency readiness for the admin panel (C15, C16).
 * - `createTwilioWebhookHandlers(deps)` and the acknowledgement page functions for the routes.
 */
export {
  clockOf,
  HANDOFF_ROUTES,
  type HandoffDeps,
  type HandoffDomainDeps,
  type OutboundMessages,
  publicUrl,
} from "./deps";
export {
  createHandoffInboundObserver,
  createHandoffTurnObserver,
  createOptOutGate,
  createOptOutGuard,
  createQuietHoursGate,
  escalateEmergencyHandler,
  handoffActionHandlers,
  handoffDomainParts,
  handoffToHumanHandler,
  scheduleFollowUpHandler,
} from "./domain";
export { createHandoffJobs, HANDOFF_FUNCTION_IDS, type HandoffJobOptions } from "./jobs";
export {
  createHandoffService,
  type EscalationView,
  type FollowUpView,
  type HandoffService,
  type TakeoverView,
} from "./service";
export {
  acknowledgeByCall,
  acknowledgeByLink,
  acknowledgeBySms,
  acknowledgeByUser,
  type AckPageView,
  ackPageView,
} from "./emergency/ack";
export {
  type AckResult,
  acknowledgeEscalation,
  emergencyAlertText,
  finishChain,
  loadEscalation,
  runChainStep,
  startEscalation,
} from "./emergency/escalation";
export {
  CALL_WAIT_MINUTES,
  type ChainContact,
  type ChainPolicy,
  type ChainStep,
  chainFromSettings,
  planSteps,
  policyFromSettings,
} from "./emergency/policy";
export {
  createTwilioWebhookHandlers,
  type TwilioRequest,
  type TwilioResponse,
  type TwilioWebhookHandlers,
} from "./emergency/webhooks";
export {
  ackToken,
  type AlertChannel,
  deliverAlert,
  type DeliveryOutcome,
  escalationTwiml,
  parseAckToken,
} from "./alerts/deliver";
export {
  type AlertRecipient,
  alertSendTime,
  conversationLink,
  planLeadAlerts,
  recipientsFor,
} from "./alerts/plan";
export {
  ALERT_KINDS,
  type AlertKind,
  alertVariables,
  type RenderedAlert,
  renderLeadAlert,
} from "./alerts/render";
export {
  botRoundsSinceCustomer,
  cancelFollowUps,
  FollowUpPayload,
  followUpBlocker,
  followUpSendTime,
  nudgeDelayMinutes,
  planFollowUp,
  windowAllows,
} from "./follow-ups/plan";
export {
  applyKeywords,
  liftOptOut,
  matchKeyword,
  normalizeKeyword,
  LIMIT_REACHED_NOTICE,
  OPTED_OUT_NOTICE,
  optOutRestriction,
  recordOptOut,
} from "./opt-out";
export { activeLock, releaseTakeover, startTakeover, touchTakeover } from "./takeover/locks";
export {
  customerTimeZone,
  followUpsNeedBusinessHours,
  nextAllowedMoment,
  nextOpening,
  parseIsoDuration,
  quietHoursEnd,
  windowEnd,
} from "./time";
export { timeZoneOfPhone } from "./area-codes";
export { type EmergencyReadiness, emergencyReadiness, type ReadinessProblem } from "./readiness";
export { escapeXml, inertLinks, plainBlock, plainLine } from "./text";
export { loadConversationFacts, type ConversationFacts } from "./facts";
export { alertTransportsFromEnv, twilioAuthTokenFromEnv } from "./env";
export { createSmtpAlertTransport } from "./transports/smtp";
export {
  createTwilioClient,
  type TwilioConfig,
  twilioSignature,
  verifyTwilioSignature,
} from "./transports/twilio";
export { createWhatsAppAlertTransport, whatsappParameter } from "./transports/whatsapp";
export {
  type AlertTransports,
  type EmailTransport,
  type FetchLike,
  NO_TRANSPORTS,
  type SmsTransport,
  type TransportResult,
  type VoiceTransport,
  type WhatsAppTransport,
} from "./transports/types";
