/**
 * @repo/scheduling (owner: C12)
 *
 * Availability, Google and Outlook calendars, Calendly, booking, rescheduling, cancelling and
 * reminders. Server only. ARCHITECTURE §2 "As built (C12)" describes it.
 *
 * - `schedulingActionHandlers(deps)`: the `offer_times`, `book_meeting` and `cancel_meeting`
 *   handlers, registered in the pipeline's domain composition.
 * - `createSchedulingJobs(deps)`: `scheduling-reminders`, `scheduling-meeting-requested`,
 *   `scheduling-reminder-sweep`, registered in apps/web.
 * - `createSchedulingConnectionService(deps)`: connect, list, choose calendars, disconnect
 *   (the admin panel, C16) and `createCalendlyWebhookHandler(deps)` (the webhook route).
 */
export * from "./availability";
export { createGoogleCalendarClient, googleEventId } from "./calendars/google";
export { createMicrosoftCalendarClient } from "./calendars/microsoft";
export type {
  CalendarAccount,
  CalendarClient,
  CalendarInfo,
  CalendarProviderId,
  EventDraft,
} from "./calendars/types";
export { type CalendlyClient, createCalendlyClient } from "./calendly/client";
export { verifyCalendlySignature } from "./calendly/webhook";
export { CalendarApiError, type FetchLike } from "./http";
export {
  CALENDAR_OAUTH_COOKIE,
  type CalendarOAuthProvider,
  type CalendarOAuthState,
  type MicrosoftOAuthApp,
  type OAuthApp,
} from "./oauth";
export {
  type BookingRequest,
  type BookingService,
  createBookingService,
  dryRunVerdict,
  STALE_HOLD_MINUTES,
} from "./server/bookings";
export {
  type CalendlyWebhookRequest,
  type CalendlyWebhookResponse,
  createCalendlyWebhookHandler,
} from "./server/calendly-hook";
export {
  CalendarConfig,
  type ConnectionView,
  createSchedulingConnectionService,
  type OAuthStart,
  type SchedulingConnectionService,
  type SchedulingProvider,
} from "./server/connections";
export {
  type OutboundMessages,
  publicUrl,
  SCHEDULING_ROUTES,
  type SchedulingDeps,
} from "./server/deps";
export { schedulingConfigFromEnv } from "./server/env";
export { eventDraft, meetingTypeLabel, plainLine } from "./server/event-text";
export { type SchedulingActionHandler, schedulingActionHandlers } from "./server/handlers";
export {
  createSchedulingJobs,
  MEETING_REQUESTED_FUNCTION_ID,
  type PlannedReminder,
  planReminders,
  quietHoursEnd,
  REMINDER_SWEEP_FUNCTION_ID,
  REMINDERS_FUNCTION_ID,
  reminderText,
  type SchedulingJobOptions,
} from "./server/jobs";
export { meetingLabel } from "./time";
