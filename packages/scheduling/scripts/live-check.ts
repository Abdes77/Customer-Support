/**
 * Live check of a calendar account (HUMAN_TODO 32) with the app's own clients. The access
 * token is read from standard input, never from the command line, and never printed.
 *
 *   pnpm --filter @repo/scheduling live:check --provider google|microsoft [--calendar <id>]
 *     [--time-zone America/Chicago] [--write]
 *   pnpm --filter @repo/scheduling live:check --provider calendly --event-type <page URL>
 *
 * Google or Microsoft: shows the account, its calendars, and the next seven days as the
 * availability code reads them (busy, tentative, free, all-day; no titles). With `--write`
 * it creates a test event three days from now at 3:00 AM UTC, creates it again (the second
 * create must return the same event: idempotency), moves it by an hour and deletes it.
 * Calendly: shows the user and the event types, finds the one of `--event-type` and creates
 * a single-use link (open it, but book nothing you do not want).
 *
 * A token for a quick check: Google's OAuth Playground (scopes calendar.readonly and
 * calendar.events), Microsoft Graph Explorer (Calendars.ReadWrite), a Calendly personal
 * access token. The full flow goes through the app's connect routes (HUMAN_TODO 32).
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  createCalendlyClient,
  createGoogleCalendarClient,
  createMicrosoftCalendarClient,
} from "../src";
import { normalizeSchedulingUrl } from "../src/calendly/client";

async function readToken(): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await lines.question("Access token, then Enter: ");
  lines.close();
  return answer.trim();
}

const fetchImpl = (input: string, init?: RequestInit) => fetch(input, init);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      calendar: { type: "string" },
      "time-zone": { type: "string", default: "America/Chicago" },
      write: { type: "boolean", default: false },
      "event-type": { type: "string" },
    },
  });
  const provider = values.provider;
  if (provider !== "google" && provider !== "microsoft" && provider !== "calendly") {
    throw new Error("--provider google|microsoft|calendly is required.");
  }
  const token = await readToken();

  if (provider === "calendly") {
    const client = createCalendlyClient(fetchImpl);
    const me = await client.me(token);
    console.log(`user: ${me.uri}\norganization: ${me.organization}`);
    const types = await client.eventTypes(token, me.uri);
    for (const type of types)
      console.log(`event type: ${type.schedulingUrl} (${type.active ? "active" : "inactive"})`);
    const wanted = normalizeSchedulingUrl(values["event-type"] ?? "");
    const match = types.find((type) => normalizeSchedulingUrl(type.schedulingUrl) === wanted);
    if (match === undefined) {
      console.log(
        "No event type matches --event-type: the setting scheduling.calendly_event_type must be one of the above.",
      );
      return;
    }
    console.log(`single-use link: ${await client.createSchedulingLink(token, match.uri)}`);
    return;
  }

  const client =
    provider === "google"
      ? createGoogleCalendarClient(fetchImpl)
      : createMicrosoftCalendarClient(fetchImpl);
  const account = await client.account(token);
  console.log(`account: ${account.address} (time zone ${account.timeZone ?? "not given"})`);
  const calendars = await client.listCalendars(token);
  for (const calendar of calendars) {
    console.log(
      `calendar: ${calendar.id}${calendar.primary ? " (primary)" : ""}${calendar.canWrite ? "" : " (read only)"}`,
    );
  }
  const calendarId = values.calendar ?? (provider === "google" ? "primary" : "default");
  const now = new Date();
  const events = await client.events(token, {
    calendarId,
    from: now,
    to: new Date(now.getTime() + 7 * 86_400_000),
    timeZone: values["time-zone"],
  });
  for (const event of events) {
    console.log(
      event.allDay
        ? `all day ${event.startDate} to ${event.endDate}: ${event.status}`
        : `${event.start} to ${event.end}: ${event.status}`,
    );
  }
  if (!values.write) return;
  const day = new Date(now.getTime() + 3 * 86_400_000);
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 3, 0));
  const end = new Date(start.getTime() + 30 * 60_000);
  const bookingId = randomUUID();
  const draft = {
    title: "Live check (delete me)",
    description: "Created by the home-services reply bot's live check. It deletes it itself.",
    location: null,
    start,
    end,
    timeZone: values["time-zone"],
    attendees: [],
  };
  const created = await client.createEvent(token, {
    calendarId,
    bookingId,
    event: draft,
    notifyAttendees: false,
  });
  const again = await client.createEvent(token, {
    calendarId,
    bookingId,
    event: draft,
    notifyAttendees: false,
  });
  console.log(
    `created ${created.id}; repeated create ${again.id === created.id ? "returned the same event" : "MADE A SECOND EVENT"}`,
  );
  await client.moveEvent(token, {
    calendarId,
    eventId: created.id,
    start: new Date(start.getTime() + 3_600_000),
    end: new Date(end.getTime() + 3_600_000),
    timeZone: values["time-zone"],
    notifyAttendees: false,
  });
  console.log("moved by an hour");
  await client.cancelEvent(token, { calendarId, eventId: created.id, notifyAttendees: false });
  if (again.id !== created.id)
    await client.cancelEvent(token, { calendarId, eventId: again.id, notifyAttendees: false });
  console.log("deleted");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The live check failed.");
  process.exitCode = 1;
});
