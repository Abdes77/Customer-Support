/**
 * Test helpers for scheduling: fakes of Google Calendar, Microsoft Graph, Calendly and their
 * OAuth endpoints behind one `fetch`, and Calendly webhook fixtures. Never import from
 * product code.
 */
export {
  createFakeCalendarApis,
  type FakeCalendarApis,
  type FakeGoogleEvent,
  type FakeGraphEvent,
} from "./fakes";
export { calendlyInviteeDelivery, calendlySignatureHeader } from "./fixtures";
