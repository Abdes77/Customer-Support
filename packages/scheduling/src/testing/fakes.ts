import { randomUUID } from "node:crypto";

import type { FetchLike } from "../http";

/*
 * In-memory stand-ins for Google Calendar, Microsoft Graph calendars, Calendly and their
 * OAuth token endpoints, behind one injectable `fetch`. They answer in the shapes of the
 * vendors' documentation (read on 2026-11-12), check the bearer token, and record every
 * write so tests can assert what was sent. Never used by product code.
 */

export interface FakeGoogleEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  transparency?: "opaque" | "transparent";
  eventType?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
  summary?: string;
  description?: string;
  location?: string;
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
}

export interface FakeGraphEvent {
  id: string;
  subject?: string;
  body?: { contentType: string; content: string };
  showAs: string;
  isAllDay: boolean;
  isCancelled: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  responseStatus?: { response: string };
  attendees?: unknown[];
  location?: { displayName: string };
  transactionId?: string;
  webLink?: string;
}

export interface FakeRequestLog {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface FakeCalendarApis {
  readonly fetch: FetchLike;
  readonly requests: FakeRequestLog[];
  readonly google: {
    /** Valid access tokens. */
    readonly tokens: Set<string>;
    readonly address: string;
    readonly calendars: Map<string, FakeGoogleEvent[]>;
    /** Set to make the next write fail with this status once. */
    failNextWrite: number | null;
  };
  readonly graph: {
    readonly tokens: Set<string>;
    readonly address: string;
    readonly calendars: Map<string, FakeGraphEvent[]>;
    failNextWrite: number | null;
  };
  readonly calendly: {
    readonly tokens: Set<string>;
    readonly userUri: string;
    readonly organization: string;
    readonly eventTypes: { uri: string; name: string; scheduling_url: string; active: boolean }[];
    readonly links: { owner: string; booking_url: string }[];
    readonly webhooks: Map<string, Record<string, unknown>>;
    readonly cancelled: { uuid: string; reason: string }[];
  };
  /** What the OAuth token endpoints hand out next (access token, refresh token). */
  readonly oauth: {
    readonly issued: { provider: string; grant: string; refreshToken: string | null }[];
    /** Refresh tokens the endpoints accept. */
    readonly refreshTokens: Set<string>;
    nextAccessToken: () => string;
  };
}

const GOOGLE = "https://www.googleapis.com/calendar/v3";
const GRAPH = "https://graph.microsoft.com/v1.0";
const CALENDLY = "https://api.calendly.com";

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearer(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  const value = headers.get("authorization");
  return value?.startsWith("Bearer ") === true ? value.slice(7) : null;
}

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return Object.fromEntries(new URLSearchParams(init.body));
  }
}

function instantOf(value: { dateTime?: string; date?: string }): number {
  if (value.dateTime !== undefined) {
    const text = /[zZ]|[+-]\d{2}:\d{2}$/.test(value.dateTime)
      ? value.dateTime
      : `${value.dateTime}Z`;
    return Date.parse(text);
  }
  return Date.parse(`${value.date ?? "1970-01-01"}T00:00:00Z`);
}

export function createFakeCalendarApis(
  options: { readonly googleAddress?: string; readonly graphAddress?: string } = {},
): FakeCalendarApis {
  const requests: FakeRequestLog[] = [];
  let counter = 0;
  const apis: FakeCalendarApis = {
    fetch: async (input, init) => handle(String(input), init),
    requests,
    google: {
      tokens: new Set(["google-token"]),
      address: options.googleAddress ?? "owner@summit.example",
      calendars: new Map([["primary", []]]),
      failNextWrite: null,
    },
    graph: {
      tokens: new Set(["graph-token"]),
      address: options.graphAddress ?? "owner@lakeside.example",
      calendars: new Map([["default", []]]),
      failNextWrite: null,
    },
    calendly: {
      tokens: new Set(["calendly-token"]),
      userUri: `${CALENDLY}/users/USER0000000001`,
      organization: `${CALENDLY}/organizations/ORG000000000001`,
      eventTypes: [
        {
          uri: `${CALENDLY}/event_types/ETYPE0000000001`,
          name: "Free estimate",
          scheduling_url: "https://calendly.com/summit-roofing/estimate",
          active: true,
        },
      ],
      links: [],
      webhooks: new Map(),
      cancelled: [],
    },
    oauth: {
      issued: [],
      refreshTokens: new Set(),
      nextAccessToken: () => `access-${(counter += 1)}`,
    },
  };

  async function handle(url: string, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = bodyOf(init);
    requests.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return token("google", body);
    if (url.startsWith("https://login.microsoftonline.com/")) return token("microsoft", body);
    if (url.startsWith("https://auth.calendly.com/oauth/token")) return token("calendly", body);
    if (url.startsWith(GOOGLE)) return google(method, url, init, body);
    if (url.startsWith(GRAPH)) return graph(method, url, init, body);
    if (url.startsWith(CALENDLY)) return calendly(method, url, init, body);
    return json(404, { error: "unknown host" });
  }

  function token(provider: "google" | "microsoft" | "calendly", body: unknown): Response {
    const form = body as Record<string, string>;
    if (
      form["grant_type"] === "refresh_token" &&
      !apis.oauth.refreshTokens.has(form["refresh_token"] ?? "")
    ) {
      return json(400, { error: "invalid_grant", error_description: "Token has been revoked." });
    }
    const access = apis.oauth.nextAccessToken();
    const refresh =
      provider === "google" && form["grant_type"] === "refresh_token" ? null : `refresh-${access}`;
    if (refresh !== null) apis.oauth.refreshTokens.add(refresh);
    if (provider === "google") apis.google.tokens.add(access);
    if (provider === "microsoft") apis.graph.tokens.add(access);
    if (provider === "calendly") apis.calendly.tokens.add(access);
    apis.oauth.issued.push({ provider, grant: form["grant_type"] ?? "", refreshToken: refresh });
    return json(200, {
      access_token: access,
      expires_in: 3600,
      ...(refresh === null ? {} : { refresh_token: refresh }),
      scope: "granted",
      token_type: "Bearer",
      ...(provider === "calendly"
        ? { owner: apis.calendly.userUri, organization: apis.calendly.organization }
        : {}),
    });
  }

  function google(
    method: string,
    url: string,
    init: RequestInit | undefined,
    body: unknown,
  ): Response {
    if (!apis.google.tokens.has(bearer(init) ?? "")) {
      return json(401, {
        error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" },
      });
    }
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/calendar/v3", "");
    if (path === "/calendars/primary" && method === "GET") {
      return json(200, { id: apis.google.address, timeZone: "America/Chicago" });
    }
    if (path === "/users/me/calendarList") {
      return json(200, {
        items: [...apis.google.calendars.keys()].map((id) => ({
          id: id === "primary" ? apis.google.address : id,
          summary: id === "primary" ? "Main" : id,
          primary: id === "primary",
          accessRole: id === "primary" ? "owner" : "reader",
        })),
      });
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (match === null) return json(404, { error: { code: 404, message: "Not Found" } });
    const calendarId = decodeURIComponent(match[1]!);
    const key = calendarId === apis.google.address ? "primary" : calendarId;
    const events = apis.google.calendars.get(key);
    if (events === undefined) return json(404, { error: { code: 404, message: "Not Found" } });
    const eventId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    if (method !== "GET" && apis.google.failNextWrite !== null) {
      const status = apis.google.failNextWrite;
      apis.google.failNextWrite = null;
      return json(status, { error: { code: status, message: "Backend Error" } });
    }
    if (eventId === null && method === "GET") {
      const from = Date.parse(parsed.searchParams.get("timeMin") ?? "");
      const to = Date.parse(parsed.searchParams.get("timeMax") ?? "");
      const items = events.filter(
        (event) =>
          event.status !== "cancelled" &&
          instantOf(event.end) > from &&
          instantOf(event.start) < to,
      );
      return json(200, { items });
    }
    if (eventId === null && method === "POST") {
      const draft = body as FakeGoogleEvent;
      if (events.some((event) => event.id === draft.id)) {
        return json(409, {
          error: { code: 409, message: "The requested identifier already exists." },
        });
      }
      const created: FakeGoogleEvent = {
        ...draft,
        id: draft.id ?? randomUUID().replaceAll("-", ""),
        status: "confirmed",
        htmlLink: `https://calendar.google.com/event?eid=${draft.id}`,
      };
      events.push(created);
      return json(200, created);
    }
    const event = events.find((item) => item.id === eventId);
    if (event === undefined) return json(404, { error: { code: 404, message: "Not Found" } });
    if (method === "GET") return json(200, event);
    if (method === "PATCH") {
      if (event.status === "cancelled") return json(410, { error: { code: 410, message: "Gone" } });
      Object.assign(event, body as Partial<FakeGoogleEvent>);
      return json(200, event);
    }
    if (method === "DELETE") {
      if (event.status === "cancelled") return json(410, { error: { code: 410, message: "Gone" } });
      event.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    return json(405, { error: { code: 405, message: "Method not allowed" } });
  }

  function graph(
    method: string,
    url: string,
    init: RequestInit | undefined,
    body: unknown,
  ): Response {
    if (!apis.graph.tokens.has(bearer(init) ?? "")) {
      return json(401, {
        error: { code: "InvalidAuthenticationToken", message: "Access token is empty." },
      });
    }
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/v1.0", "");
    if (path === "/me")
      return json(200, { mail: apis.graph.address, userPrincipalName: apis.graph.address });
    if (path === "/me/calendars") {
      return json(200, {
        value: [...apis.graph.calendars.keys()].map((id) => ({
          id: id === "default" ? "AAMkDefault" : id,
          name: id === "default" ? "Calendar" : id,
          isDefaultCalendar: id === "default",
          canEdit: id === "default",
        })),
      });
    }
    if (method !== "GET" && apis.graph.failNextWrite !== null) {
      const status = apis.graph.failNextWrite;
      apis.graph.failNextWrite = null;
      return json(status, { error: { code: "ServiceUnavailable", message: "Try again." } });
    }
    const calendarMatch = /^\/me\/(?:calendar|calendars\/([^/]+))\/(calendarView|events)$/.exec(
      path,
    );
    if (calendarMatch !== null) {
      const key = calendarMatch[1] === undefined ? "default" : decodeURIComponent(calendarMatch[1]);
      const events = apis.graph.calendars.get(key);
      if (events === undefined)
        return json(404, { error: { code: "ErrorItemNotFound", message: "Not found." } });
      if (calendarMatch[2] === "calendarView") {
        const from = Date.parse(parsed.searchParams.get("startDateTime") ?? "");
        const to = Date.parse(parsed.searchParams.get("endDateTime") ?? "");
        return json(200, {
          value: events.filter(
            (event) =>
              !event.isCancelled && instantOf(event.end) > from && instantOf(event.start) < to,
          ),
        });
      }
      if (method === "POST") {
        const draft = body as FakeGraphEvent;
        const existing = events.find(
          (event) =>
            draft.transactionId !== undefined && event.transactionId === draft.transactionId,
        );
        if (existing !== undefined) return json(201, existing);
        const created: FakeGraphEvent = {
          ...draft,
          id: `AAMk${randomUUID().replaceAll("-", "")}`,
          showAs: "busy",
          isAllDay: false,
          isCancelled: false,
          webLink: "https://outlook.office365.com/owa/?itemid=x",
        };
        events.push(created);
        return json(201, created);
      }
    }
    const eventMatch = /^\/me\/events\/([^/]+)$/.exec(path);
    if (eventMatch !== null) {
      const id = decodeURIComponent(eventMatch[1]!);
      const event = [...apis.graph.calendars.values()].flat().find((item) => item.id === id);
      if (event === undefined || event.isCancelled) {
        return json(404, {
          error: { code: "ErrorItemNotFound", message: "The specified object was not found." },
        });
      }
      if (method === "PATCH") {
        Object.assign(event, body as Partial<FakeGraphEvent>);
        return json(200, event);
      }
      if (method === "DELETE") {
        event.isCancelled = true;
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { error: { code: "ErrorItemNotFound", message: "Not found." } });
  }

  function calendly(
    method: string,
    url: string,
    init: RequestInit | undefined,
    body: unknown,
  ): Response {
    if (!apis.calendly.tokens.has(bearer(init) ?? "")) {
      return json(401, { title: "Unauthenticated", message: "The access token is invalid" });
    }
    const parsed = new URL(url);
    const c = apis.calendly;
    if (parsed.pathname === "/users/me") {
      return json(200, {
        resource: {
          uri: c.userUri,
          name: "Summit Roofing",
          current_organization: c.organization,
          scheduling_url: "https://calendly.com/summit-roofing",
          timezone: "America/Chicago",
        },
      });
    }
    if (parsed.pathname === "/event_types") {
      return json(200, { collection: c.eventTypes, pagination: { next_page: null } });
    }
    if (parsed.pathname === "/scheduling_links" && method === "POST") {
      const request = body as { owner?: string; max_event_count?: number };
      if (
        request.max_event_count !== 1 ||
        !c.eventTypes.some((type) => type.uri === request.owner)
      ) {
        return json(400, {
          title: "Invalid Argument",
          message: "The supplied parameters are invalid.",
        });
      }
      const link = {
        owner: request.owner ?? "",
        booking_url: `https://calendly.com/d/${randomUUID().slice(0, 8)}/free-estimate`,
      };
      c.links.push(link);
      return json(201, { resource: { ...link, owner_type: "EventType" } });
    }
    if (parsed.pathname === "/webhook_subscriptions" && method === "POST") {
      const uri = `${CALENDLY}/webhook_subscriptions/${randomUUID()}`;
      c.webhooks.set(uri, body as Record<string, unknown>);
      return json(201, { resource: { uri, state: "active" } });
    }
    if (parsed.pathname.startsWith("/webhook_subscriptions/") && method === "DELETE") {
      const removed = c.webhooks.delete(url);
      return removed
        ? new Response(null, { status: 204 })
        : json(404, { title: "Resource Not Found", message: "" });
    }
    const cancel = /^\/scheduled_events\/([^/]+)\/cancellation$/.exec(parsed.pathname);
    if (cancel !== null && method === "POST") {
      if (c.cancelled.some((item) => item.uuid === cancel[1])) {
        return json(403, { title: "Permission Denied", message: "Event already canceled" });
      }
      c.cancelled.push({ uuid: cancel[1]!, reason: (body as { reason?: string }).reason ?? "" });
      return json(201, { resource: { canceled_by: "Summit Roofing", reason: "" } });
    }
    return json(404, { title: "Resource Not Found", message: "" });
  }

  return apis;
}
