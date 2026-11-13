import type { CalendarEvent } from "../availability";

export type CalendarProviderId = "google_calendar" | "outlook_calendar";

export interface CalendarAccount {
  /** The account's address (Google's primary calendar id, Microsoft's mail or UPN). */
  readonly address: string;
  /** IANA time zone of the account, when the provider says. */
  readonly timeZone: string | null;
}

export interface CalendarInfo {
  readonly id: string;
  /** The calendar's name as its owner sees it (shown to agency staff only). */
  readonly name: string;
  readonly primary: boolean;
  readonly canWrite: boolean;
}

export interface EventAttendee {
  readonly email: string;
  readonly name: string | null;
}

/** A meeting to put in the business's calendar. Every text is already plain data. */
export interface EventDraft {
  readonly title: string;
  readonly description: string;
  readonly location: string | null;
  readonly start: Date;
  readonly end: Date;
  /** The business's IANA time zone, for how the event shows in the calendar. */
  readonly timeZone: string;
  readonly attendees: readonly EventAttendee[];
}

export interface CreatedEvent {
  readonly id: string;
  /** Link to the event in the calendar's web app, when the provider gives one. */
  readonly url: string | null;
}

/**
 * One calendar provider. Stateless: the caller hands in a valid access token. Every write
 * is safe to repeat: `createEvent` with the same booking id returns the event created the
 * first time (Google: an event id derived from the booking; Graph: `transactionId`);
 * `moveEvent` sets absolute times; `cancelEvent` of an event already gone is done.
 */
export interface CalendarClient {
  readonly provider: CalendarProviderId;
  account(token: string): Promise<CalendarAccount>;
  listCalendars(token: string): Promise<CalendarInfo[]>;
  /** Events between two instants, only their times and whether they block time. */
  events(
    token: string,
    input: {
      readonly calendarId: string;
      readonly from: Date;
      readonly to: Date;
      readonly timeZone: string;
    },
  ): Promise<CalendarEvent[]>;
  createEvent(
    token: string,
    input: {
      readonly calendarId: string;
      readonly bookingId: string;
      readonly event: EventDraft;
      readonly notifyAttendees: boolean;
    },
  ): Promise<CreatedEvent>;
  moveEvent(
    token: string,
    input: {
      readonly calendarId: string;
      readonly eventId: string;
      readonly start: Date;
      readonly end: Date;
      readonly timeZone: string;
      readonly notifyAttendees: boolean;
    },
  ): Promise<void>;
  cancelEvent(
    token: string,
    input: {
      readonly calendarId: string;
      readonly eventId: string;
      readonly notifyAttendees: boolean;
    },
  ): Promise<void>;
}
