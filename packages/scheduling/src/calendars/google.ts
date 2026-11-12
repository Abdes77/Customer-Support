import { z } from "zod";

import type { CalendarEvent, CalendarEventStatus } from "../availability";
import { apiJson, apiRequest, CalendarApiError, type FetchLike } from "../http";
import type { CalendarClient, CreatedEvent } from "./types";

/*
 * Google Calendar API v3 (docs read on 2026-11-12: events resource, events.list,
 * events.insert). Busy times come from `events.list` with `singleEvents=true`, because the
 * free/busy endpoint cannot tell a tentative or an all-day event from a busy one. Only the
 * fields that say when an event is and whether it blocks time are requested.
 */

const BASE = "https://www.googleapis.com/calendar/v3";

/**
 * The event id of a booking: client-chosen ids may use base32hex (0-9, a-v), 5 to 1024
 * characters; a UUID's hex digits qualify. A repeated insert of the same booking gets 409.
 */
export function googleEventId(bookingId: string): string {
  return `hsrb${bookingId.replaceAll("-", "").toLowerCase()}`;
}

const DateOrTime = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const GoogleEvent = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    transparency: z.string().optional(),
    eventType: z.string().optional(),
    start: DateOrTime.optional(),
    end: DateOrTime.optional(),
    attendees: z
      .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
      .optional(),
    htmlLink: z.string().optional(),
  })
  .passthrough();

const EventPage = z.object({
  items: z.array(GoogleEvent).default([]),
  nextPageToken: z.string().optional(),
});

function statusOf(event: z.infer<typeof GoogleEvent>): CalendarEventStatus {
  if (event.transparency === "transparent") return "free";
  if (event.eventType === "workingLocation") return "free";
  const self = event.attendees?.find((attendee) => attendee.self === true);
  if (self?.responseStatus === "declined") return "free";
  if (event.status === "tentative") return "tentative";
  if (self?.responseStatus === "tentative" || self?.responseStatus === "needsAction") {
    return "tentative";
  }
  return "busy";
}

/** Google's event as the availability code reads it; null for one it cannot place. */
export function normalizeGoogleEvent(event: z.infer<typeof GoogleEvent>): CalendarEvent | null {
  if (event.status === "cancelled") return null;
  const status = statusOf(event);
  if (event.start?.date !== undefined && event.end?.date !== undefined) {
    return { allDay: true, startDate: event.start.date, endDate: event.end.date, status };
  }
  if (event.start?.dateTime === undefined || event.end?.dateTime === undefined) return null;
  return { allDay: false, start: event.start.dateTime, end: event.end.dateTime, status };
}

function calendarPath(calendarId: string): string {
  return `${BASE}/calendars/${encodeURIComponent(calendarId)}`;
}

export function createGoogleCalendarClient(fetchImpl: FetchLike): CalendarClient {
  const vendor = "google_calendar" as const;
  return {
    provider: vendor,

    async account(token) {
      const primary = await apiJson(
        fetchImpl,
        vendor,
        { method: "GET", url: `${calendarPath("primary")}?fields=id,timeZone`, token },
        z.object({ id: z.string().min(1), timeZone: z.string().optional() }),
      );
      return { address: primary.id, timeZone: primary.timeZone ?? null };
    },

    async listCalendars(token) {
      const page = await apiJson(
        fetchImpl,
        vendor,
        {
          method: "GET",
          url: `${BASE}/users/me/calendarList?minAccessRole=reader&maxResults=250&fields=items(id,summary,primary,accessRole)`,
          token,
        },
        z.object({
          items: z
            .array(
              z.object({
                id: z.string(),
                summary: z.string().optional(),
                primary: z.boolean().optional(),
                accessRole: z.string().optional(),
              }),
            )
            .default([]),
        }),
      );
      return page.items.map((item) => ({
        id: item.id,
        name: item.summary ?? item.id,
        primary: item.primary === true,
        canWrite: item.accessRole === "owner" || item.accessRole === "writer",
      }));
    },

    async events(token, input) {
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const url = new URL(`${calendarPath(input.calendarId)}/events`);
        url.searchParams.set("timeMin", input.from.toISOString());
        url.searchParams.set("timeMax", input.to.toISOString());
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("showDeleted", "false");
        url.searchParams.set("maxResults", "2500");
        url.searchParams.set(
          "fields",
          "items(status,transparency,eventType,start,end,attendees(self,responseStatus)),nextPageToken",
        );
        if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
        const result = await apiJson(
          fetchImpl,
          vendor,
          { method: "GET", url: url.toString(), token },
          EventPage,
        );
        for (const item of result.items) {
          const event = normalizeGoogleEvent(item);
          if (event !== null) out.push(event);
        }
        pageToken = result.nextPageToken;
        if (pageToken === undefined) break;
      }
      return out;
    },

    async createEvent(token, input): Promise<CreatedEvent> {
      const id = googleEventId(input.bookingId);
      const { event } = input;
      const updates = input.notifyAttendees && event.attendees.length > 0 ? "all" : "none";
      const body = {
        id,
        summary: event.title,
        description: event.description,
        ...(event.location === null ? {} : { location: event.location }),
        start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
        end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
        attendees: event.attendees.map((attendee) => ({
          email: attendee.email,
          ...(attendee.name === null ? {} : { displayName: attendee.name }),
        })),
        extendedProperties: { private: { hsrbBookingId: input.bookingId } },
        reminders: { useDefault: true },
      };
      try {
        const created = await apiJson(
          fetchImpl,
          vendor,
          {
            method: "POST",
            url: `${calendarPath(input.calendarId)}/events?sendUpdates=${updates}`,
            token,
            json: body,
          },
          GoogleEvent,
        );
        return { id: created.id ?? id, url: created.htmlLink ?? null };
      } catch (error) {
        // Created by an earlier attempt that lost its answer: the same booking, the same id.
        if (!(error instanceof CalendarApiError) || !error.conflict) throw error;
        const existing = await apiJson(
          fetchImpl,
          vendor,
          { method: "GET", url: `${calendarPath(input.calendarId)}/events/${id}`, token },
          GoogleEvent,
        );
        if (existing.status === "cancelled") {
          throw new CalendarApiError(vendor, "The event of this booking was deleted.", {
            status: 409,
            retryable: false,
          });
        }
        return { id, url: existing.htmlLink ?? null };
      }
    },

    async moveEvent(token, input) {
      const updates = input.notifyAttendees ? "all" : "none";
      await apiRequest(fetchImpl, vendor, {
        method: "PATCH",
        url: `${calendarPath(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?sendUpdates=${updates}`,
        token,
        json: {
          start: { dateTime: input.start.toISOString(), timeZone: input.timeZone },
          end: { dateTime: input.end.toISOString(), timeZone: input.timeZone },
        },
      });
    },

    async cancelEvent(token, input) {
      const updates = input.notifyAttendees ? "all" : "none";
      try {
        await apiRequest(fetchImpl, vendor, {
          method: "DELETE",
          url: `${calendarPath(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?sendUpdates=${updates}`,
          token,
        });
      } catch (error) {
        if (error instanceof CalendarApiError && error.notFound) return;
        throw error;
      }
    },
  };
}
