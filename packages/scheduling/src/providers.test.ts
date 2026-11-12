import { describe, expect, it } from "vitest";

import {
  createGoogleCalendarClient,
  googleEventId,
  normalizeGoogleEvent,
} from "./calendars/google";
import { createMicrosoftCalendarClient, normalizeGraphEvent } from "./calendars/microsoft";
import { createCalendlyClient, normalizeSchedulingUrl } from "./calendly/client";
import {
  linkWithToken,
  parseCalendlyDelivery,
  trackingToken,
  verifyCalendlySignature,
} from "./calendly/webhook";
import { CalendarApiError } from "./http";
import {
  createOAuthState,
  exchangeCode,
  googleAuthorizationUrl,
  readCookieValue,
  refreshAccessToken,
  verifyOAuthState,
} from "./oauth";
import {
  calendlyInviteeDelivery,
  calendlySignatureHeader,
  createFakeCalendarApis,
} from "./testing";

const NOW = new Date("2026-11-12T16:00:00.000Z");

describe("Google Calendar events", () => {
  it("reads busy, tentative, free, declined, working-location and all-day events", () => {
    expect(
      normalizeGoogleEvent({
        status: "confirmed",
        start: { dateTime: "2026-11-12T09:00:00-06:00" },
        end: { dateTime: "2026-11-12T10:00:00-06:00" },
      }),
    ).toEqual({
      allDay: false,
      start: "2026-11-12T09:00:00-06:00",
      end: "2026-11-12T10:00:00-06:00",
      status: "busy",
    });
    const timed = {
      start: { dateTime: "2026-11-12T15:00:00Z" },
      end: { dateTime: "2026-11-12T16:00:00Z" },
    };
    expect(normalizeGoogleEvent({ ...timed, status: "tentative" })?.status).toBe("tentative");
    expect(normalizeGoogleEvent({ ...timed, transparency: "transparent" })?.status).toBe("free");
    expect(normalizeGoogleEvent({ ...timed, eventType: "workingLocation" })?.status).toBe("free");
    expect(
      normalizeGoogleEvent({ ...timed, attendees: [{ self: true, responseStatus: "declined" }] })
        ?.status,
    ).toBe("free");
    expect(
      normalizeGoogleEvent({ ...timed, attendees: [{ self: true, responseStatus: "needsAction" }] })
        ?.status,
    ).toBe("tentative");
    expect(normalizeGoogleEvent({ ...timed, status: "cancelled" })).toBeNull();
    expect(
      normalizeGoogleEvent({
        start: { date: "2026-11-13" },
        end: { date: "2026-11-14" },
        transparency: "transparent",
      }),
    ).toEqual({ allDay: true, startDate: "2026-11-13", endDate: "2026-11-14", status: "free" });
  });

  it("derives a valid, stable event id from the booking id", () => {
    const id = googleEventId("4d6f8b0d-2f4b-4d6f-b8d0-5f7b9d1f3b13");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(id).toBe(googleEventId("4d6f8b0d-2f4b-4d6f-b8d0-5f7b9d1f3b13"));
  });

  it("creates an event once even when the create is repeated", async () => {
    const fake = createFakeCalendarApis();
    const client = createGoogleCalendarClient(fake.fetch);
    const input = {
      calendarId: "primary",
      bookingId: "4d6f8b0d-2f4b-4d6f-b8d0-5f7b9d1f3b13",
      notifyAttendees: false,
      event: {
        title: "On-site estimate: Pat Lee",
        description: "Report",
        location: null,
        start: new Date("2026-11-13T15:00:00Z"),
        end: new Date("2026-11-13T16:00:00Z"),
        timeZone: "America/Chicago",
        attendees: [],
      },
    };
    const first = await client.createEvent("google-token", input);
    const second = await client.createEvent("google-token", input);
    expect(second.id).toBe(first.id);
    expect(fake.google.calendars.get("primary")).toHaveLength(1);
    await expect(
      client.events("bad-token", { calendarId: "primary", from: NOW, to: NOW, timeZone: "UTC" }),
    ).rejects.toMatchObject({
      authFailed: true,
    });
  });
});

describe("Outlook calendar events", () => {
  const timed = {
    start: { dateTime: "2026-11-12T15:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-12T16:00:00.0000000", timeZone: "UTC" },
  };

  it("reads showAs, the owner's response and all-day events", () => {
    expect(normalizeGraphEvent({ ...timed, showAs: "busy" }, "America/Chicago")).toEqual({
      allDay: false,
      start: "2026-11-12T15:00:00.000Z",
      end: "2026-11-12T16:00:00.000Z",
      status: "busy",
    });
    expect(normalizeGraphEvent({ ...timed, showAs: "oof" }, "UTC")?.status).toBe("busy");
    expect(normalizeGraphEvent({ ...timed, showAs: "tentative" }, "UTC")?.status).toBe("tentative");
    expect(normalizeGraphEvent({ ...timed, showAs: "free" }, "UTC")?.status).toBe("free");
    expect(normalizeGraphEvent({ ...timed, showAs: "workingElsewhere" }, "UTC")?.status).toBe(
      "free",
    );
    expect(
      normalizeGraphEvent(
        { ...timed, showAs: "busy", responseStatus: { response: "declined" } },
        "UTC",
      )?.status,
    ).toBe("free");
    expect(normalizeGraphEvent({ ...timed, isCancelled: true }, "UTC")).toBeNull();
    // An all-day event comes back at midnight of its own zone, or shifted into UTC.
    expect(
      normalizeGraphEvent(
        {
          isAllDay: true,
          showAs: "free",
          start: { dateTime: "2026-11-13T00:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-14T00:00:00.0000000", timeZone: "UTC" },
        },
        "America/Chicago",
      ),
    ).toEqual({ allDay: true, startDate: "2026-11-13", endDate: "2026-11-14", status: "free" });
    expect(
      normalizeGraphEvent(
        {
          isAllDay: true,
          showAs: "oof",
          start: { dateTime: "2026-11-13T06:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-14T06:00:00.0000000", timeZone: "UTC" },
        },
        "America/Chicago",
      ),
    ).toEqual({ allDay: true, startDate: "2026-11-13", endDate: "2026-11-14", status: "busy" });
  });

  it("creates an event once per booking through transactionId, as text", async () => {
    const fake = createFakeCalendarApis();
    const client = createMicrosoftCalendarClient(fake.fetch);
    const input = {
      calendarId: "default",
      bookingId: "5d6f8b0d-2f4b-4d6f-b8d0-5f7b9d1f3b13",
      notifyAttendees: true,
      event: {
        title: "Visit",
        description: "<script>alert(1)</script>",
        location: null,
        start: new Date("2026-11-13T15:00:00Z"),
        end: new Date("2026-11-13T16:00:00Z"),
        timeZone: "America/Chicago",
        attendees: [{ email: "pat@example.com", name: "Pat" }],
      },
    };
    const first = await client.createEvent("graph-token", input);
    expect((await client.createEvent("graph-token", input)).id).toBe(first.id);
    const stored = fake.graph.calendars.get("default")!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toEqual({ contentType: "text", content: "<script>alert(1)</script>" });
    expect(stored[0]!.start).toEqual({ dateTime: "2026-11-13T15:00:00", timeZone: "UTC" });
    await client.cancelEvent("graph-token", {
      calendarId: "default",
      eventId: first.id,
      notifyAttendees: true,
    });
    // A second cancel of an event that is gone is done, not an error.
    await client.cancelEvent("graph-token", {
      calendarId: "default",
      eventId: first.id,
      notifyAttendees: true,
    });
  });
});

describe("Calendly", () => {
  it("creates a single-use link for the event type and adds our tracking token", async () => {
    const fake = createFakeCalendarApis();
    const client = createCalendlyClient(fake.fetch);
    const types = await client.eventTypes("calendly-token", fake.calendly.userUri);
    const wanted = normalizeSchedulingUrl("https://www.calendly.com/Summit-Roofing/estimate/");
    const type = types.find((item) => normalizeSchedulingUrl(item.schedulingUrl) === wanted);
    expect(type?.uri).toBe("https://api.calendly.com/event_types/ETYPE0000000001");
    const link = await client.createSchedulingLink("calendly-token", type!.uri);
    expect(fake.calendly.links).toHaveLength(1);
    const tracked = new URL(linkWithToken(link, "tok_0123456789abcdef"));
    expect(tracked.searchParams.get("utm_content")).toBe("tok_0123456789abcdef");
    expect(tracked.hostname).toBe("calendly.com");
  });

  it("verifies the signature over the raw body, in constant time, within five minutes", () => {
    const body = calendlyInviteeDelivery({
      event: "invitee.created",
      inviteeUuid: "INV1",
      eventUuid: "EVT1",
      start: "2026-11-17T15:00:00.000000Z",
      end: "2026-11-17T16:00:00.000000Z",
      token: "tok_0123456789abcdef",
    });
    const key = "signing-key-0123456789";
    const header = calendlySignatureHeader(key, body, NOW);
    expect(verifyCalendlySignature({ header, rawBody: body, keys: [key], now: NOW }).ok).toBe(true);
    expect(verifyCalendlySignature({ header, rawBody: `${body} `, keys: [key], now: NOW })).toEqual(
      {
        ok: false,
        reason: "mismatch",
      },
    );
    expect(
      verifyCalendlySignature({ header, rawBody: body, keys: ["other-key-0123456"], now: NOW }).ok,
    ).toBe(false);
    expect(
      verifyCalendlySignature({
        header,
        rawBody: body,
        keys: [key],
        now: new Date(NOW.getTime() + 301_000),
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(verifyCalendlySignature({ header: null, rawBody: body, keys: [key], now: NOW }).ok).toBe(
      false,
    );
    expect(
      verifyCalendlySignature({ header: "t=abc,v1=zz", rawBody: body, keys: [key], now: NOW }),
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("parses invitee deliveries and reads our token back", () => {
    const body = calendlyInviteeDelivery({
      event: "invitee.created",
      inviteeUuid: "INV1",
      eventUuid: "EVT1",
      start: "2026-11-17T15:00:00.000000Z",
      end: "2026-11-17T16:00:00.000000Z",
      token: "tok_0123456789abcdef",
    });
    const delivery = parseCalendlyDelivery(body);
    expect(delivery?.kind).toBe("invitee");
    if (delivery?.kind !== "invitee") return;
    expect(trackingToken(delivery.invitee)).toBe("tok_0123456789abcdef");
    expect(delivery.invitee.scheduled_event.start_time).toBe("2026-11-17T15:00:00.000000Z");
    expect(
      parseCalendlyDelivery(
        JSON.stringify({ event: "routing_form_submission.created", payload: {} }),
      ),
    ).toEqual({
      kind: "ignored",
      event: "routing_form_submission.created",
    });
    expect(parseCalendlyDelivery("not json")).toBeNull();
  });
});

describe("OAuth", () => {
  const key = new Uint8Array(32).fill(7);

  it("signs the state, binds it to the cookie and expires it", () => {
    const { state, nonce } = createOAuthState(
      key,
      {
        p: "google_calendar",
        a: "3f2b8c1e-7d4a-4b6f-8e21-5c9a7d1e2f02",
        b: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03",
        u: "user-1",
        r: "/businesses/x",
      },
      NOW,
    );
    expect(verifyOAuthState(key, state, nonce, NOW).ok).toBe(true);
    expect(verifyOAuthState(key, state, "x".repeat(32), NOW)).toEqual({
      ok: false,
      reason: "cookie",
    });
    expect(verifyOAuthState(new Uint8Array(32).fill(8), state, nonce, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifyOAuthState(key, state, nonce, new Date(NOW.getTime() + 11 * 60_000))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(readCookieValue("a.b.c")).toBeNull();
  });

  it("asks Google for calendar scopes with PKCE, and exchanges and refreshes tokens", async () => {
    const url = new URL(
      googleAuthorizationUrl({
        app: { clientId: "client", clientSecret: "secret" },
        redirectUri: "https://app.example/api/oauth/calendar/google/callback",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const fake = createFakeCalendarApis();
    const grant = await exchangeCode(fake.fetch, "calendly", {
      app: { clientId: "client", clientSecret: "secret" },
      code: "code",
      redirectUri: "https://app.example/cb",
      codeVerifier: "v".repeat(50),
      now: NOW,
    });
    expect(grant.owner).toBe(fake.calendly.userUri);
    const refreshed = await refreshAccessToken(fake.fetch, "calendly", {
      app: { clientId: "client", clientSecret: "secret" },
      refreshToken: grant.credentials.refreshToken!,
      now: NOW,
    });
    expect(refreshed.accessToken).not.toBe(grant.credentials.accessToken);
    await expect(
      refreshAccessToken(fake.fetch, "google_calendar", {
        app: { clientId: "client", clientSecret: "secret" },
        refreshToken: "revoked",
        now: NOW,
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof CalendarApiError && error.authFailed);
  });
});
