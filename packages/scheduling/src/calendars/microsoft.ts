import { z } from "zod";

import type { CalendarEvent, CalendarEventStatus } from "../availability";
import { localMoment } from "../time";
import { apiJson, apiRequest, CalendarApiError, type FetchLike } from "../http";
import type { CalendarClient } from "./types";

/*
 * Outlook calendars through Microsoft Graph v1.0 (docs read on 2026-11-12: event resource,
 * calendarView, POST /events with `transactionId`). Busy times come from `calendarView`
 * (recurring events expanded), selecting only `showAs`, `isAllDay`, `isCancelled`, the times
 * and the owner's response. Times are asked for in UTC.
 */

const BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_CALENDAR = "default";

const DateTimeZone = z.object({ dateTime: z.string(), timeZone: z.string().optional() });

const GraphEvent = z
  .object({
    id: z.string().optional(),
    showAs: z.string().optional(),
    isAllDay: z.boolean().optional(),
    isCancelled: z.boolean().optional(),
    start: DateTimeZone.optional(),
    end: DateTimeZone.optional(),
    responseStatus: z.object({ response: z.string().optional() }).nullish(),
    webLink: z.string().optional(),
  })
  .passthrough();

const EventPage = z.object({
  value: z.array(GraphEvent).default([]),
  "@odata.nextLink": z.string().optional(),
});

function statusOf(event: z.infer<typeof GraphEvent>): CalendarEventStatus {
  const showAs = event.showAs ?? "busy";
  if (showAs === "free" || showAs === "workingElsewhere") return "free";
  const response = event.responseStatus?.response;
  if (response === "declined") return "free";
  if (showAs === "tentative" || response === "tentativelyAccepted" || response === "notResponded") {
    return "tentative";
  }
  return "busy";
}

/** Graph's "2026-11-12T14:00:00.0000000" in UTC as an ISO instant. */
function utcInstant(value: string): string {
  const trimmed = value.replace(/(\.\d{3})\d*$/, "$1");
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
}

/**
 * The local date an all-day event starts or ends on. Graph keeps all-day events at midnight
 * of their own zone; asked for in UTC, a midnight comes back as is or shifted by the zone's
 * offset, so a midnight is read as the date it names and any other time as the business's
 * local date of that instant.
 */
function allDayDate(value: string, timeZone: string): string {
  if (value.includes("T00:00:00")) return value.slice(0, 10);
  return localMoment(new Date(utcInstant(value)), timeZone).date;
}

export function normalizeGraphEvent(
  event: z.infer<typeof GraphEvent>,
  timeZone: string,
): CalendarEvent | null {
  if (event.isCancelled === true || event.start === undefined || event.end === undefined) {
    return null;
  }
  const status = statusOf(event);
  if (event.isAllDay === true) {
    return {
      allDay: true,
      startDate: allDayDate(event.start.dateTime, timeZone),
      endDate: allDayDate(event.end.dateTime, timeZone),
      status,
    };
  }
  return {
    allDay: false,
    start: utcInstant(event.start.dateTime),
    end: utcInstant(event.end.dateTime),
    status,
  };
}

function calendarPath(calendarId: string): string {
  return calendarId === DEFAULT_CALENDAR
    ? `${BASE}/me/calendar`
    : `${BASE}/me/calendars/${encodeURIComponent(calendarId)}`;
}

/** Graph wants a local date-time and a zone; UTC keeps the instant exact. */
function graphTime(instant: Date): { dateTime: string; timeZone: string } {
  return { dateTime: instant.toISOString().slice(0, 19), timeZone: "UTC" };
}

export function createMicrosoftCalendarClient(fetchImpl: FetchLike): CalendarClient {
  const vendor = "outlook_calendar" as const;
  return {
    provider: vendor,

    async account(token) {
      const me = await apiJson(
        fetchImpl,
        vendor,
        { method: "GET", url: `${BASE}/me?$select=mail,userPrincipalName`, token },
        z.object({ mail: z.string().nullish(), userPrincipalName: z.string().nullish() }),
      );
      const address = me.mail ?? me.userPrincipalName;
      if (address === null || address === undefined || address.length === 0) {
        throw new CalendarApiError(vendor, "The Microsoft account has no address.", {
          retryable: false,
        });
      }
      return { address, timeZone: null };
    },

    async listCalendars(token) {
      const page = await apiJson(
        fetchImpl,
        vendor,
        {
          method: "GET",
          url: `${BASE}/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=100`,
          token,
        },
        z.object({
          value: z
            .array(
              z.object({
                id: z.string(),
                name: z.string().optional(),
                isDefaultCalendar: z.boolean().optional(),
                canEdit: z.boolean().optional(),
              }),
            )
            .default([]),
        }),
      );
      return page.value.map((item) => ({
        id: item.isDefaultCalendar === true ? DEFAULT_CALENDAR : item.id,
        name: item.name ?? "Calendar",
        primary: item.isDefaultCalendar === true,
        canWrite: item.canEdit !== false,
      }));
    },

    async events(token, input) {
      const out: CalendarEvent[] = [];
      const first = new URL(`${calendarPath(input.calendarId)}/calendarView`);
      first.searchParams.set("startDateTime", input.from.toISOString());
      first.searchParams.set("endDateTime", input.to.toISOString());
      first.searchParams.set("$select", "showAs,isAllDay,isCancelled,start,end,responseStatus");
      first.searchParams.set("$top", "250");
      let next: string | undefined = first.toString();
      for (let page = 0; page < 20 && next !== undefined; page += 1) {
        // Follow only Graph's own paging links.
        if (!next.startsWith(`${BASE}/`)) break;
        const result: z.infer<typeof EventPage> = await apiJson(
          fetchImpl,
          vendor,
          { method: "GET", url: next, token, headers: { prefer: 'outlook.timezone="UTC"' } },
          EventPage,
        );
        for (const item of result.value) {
          const event = normalizeGraphEvent(item, input.timeZone);
          if (event !== null) out.push(event);
        }
        next = result["@odata.nextLink"];
      }
      return out;
    },

    async createEvent(token, input) {
      const { event } = input;
      const created = await apiJson(
        fetchImpl,
        vendor,
        {
          method: "POST",
          url: `${calendarPath(input.calendarId)}/events`,
          token,
          json: {
            subject: event.title,
            // Plain text: nothing the customer wrote is rendered as HTML.
            body: { contentType: "text", content: event.description },
            start: graphTime(event.start),
            end: graphTime(event.end),
            ...(event.location === null ? {} : { location: { displayName: event.location } }),
            // Graph invites the attendees it is given; the caller lists them only when the
            // customer is to be invited.
            attendees: event.attendees.map((attendee) => ({
              emailAddress: {
                address: attendee.email,
                ...(attendee.name === null ? {} : { name: attendee.name }),
              },
              type: "required",
            })),
            // A retried create of the same booking returns the event created the first time.
            transactionId: input.bookingId,
            isReminderOn: true,
            allowNewTimeProposals: false,
          },
        },
        GraphEvent,
      );
      if (created.id === undefined) {
        throw new CalendarApiError(vendor, "Graph returned an event without an id.", {
          retryable: true,
        });
      }
      return { id: created.id, url: created.webLink ?? null };
    },

    async moveEvent(token, input) {
      await apiRequest(fetchImpl, vendor, {
        method: "PATCH",
        url: `${BASE}/me/events/${encodeURIComponent(input.eventId)}`,
        token,
        json: { start: graphTime(input.start), end: graphTime(input.end) },
      });
    },

    async cancelEvent(token, input) {
      try {
        // Deleting a meeting from the organizer's calendar sends the attendees a cancellation.
        await apiRequest(fetchImpl, vendor, {
          method: "DELETE",
          url: `${BASE}/me/events/${encodeURIComponent(input.eventId)}`,
          token,
        });
      } catch (error) {
        if (error instanceof CalendarApiError && error.notFound) return;
        throw error;
      }
    },
  };
}
