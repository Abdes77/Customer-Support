import { z } from "zod";

import { apiJson, apiRequest, CalendarApiError, type FetchLike } from "../http";

/*
 * Calendly API v2 (docs read on 2026-11-12: Create Single-Use Scheduling Link, Create Webhook
 * Subscription, Webhook Signatures, the Invitee resource). The scheduling-link endpoint takes
 * the event type's API URI, so the public page address from `scheduling.calendly_event_type`
 * is matched against the user's event types first.
 */

export const CALENDLY_API = "https://api.calendly.com";
const VENDOR = "calendly" as const;

export interface CalendlyUser {
  readonly uri: string;
  readonly name: string | null;
  readonly organization: string;
  readonly schedulingUrl: string | null;
}

export interface CalendlyEventType {
  readonly uri: string;
  readonly name: string;
  readonly schedulingUrl: string;
  readonly active: boolean;
}

/** "https://calendly.com/Acme/estimate/?x" → "calendly.com/acme/estimate", for comparing. */
export function normalizeSchedulingUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The uuid at the end of a Calendly resource URI. */
export function calendlyUuid(uri: string): string | null {
  const match = /\/([A-Za-z0-9-]{1,64})\/?$/.exec(uri);
  return match?.[1] ?? null;
}

export interface CalendlyClient {
  me(token: string): Promise<CalendlyUser>;
  eventTypes(token: string, userUri: string): Promise<CalendlyEventType[]>;
  /** A link that books one meeting of the event type, then stops working. */
  createSchedulingLink(token: string, eventTypeUri: string): Promise<string>;
  createWebhook(
    token: string,
    input: {
      readonly url: string;
      readonly organization: string;
      readonly user: string;
      readonly signingKey: string | null;
    },
  ): Promise<string>;
  deleteWebhook(token: string, webhookUri: string): Promise<void>;
  cancelEvent(token: string, eventUri: string, reason: string): Promise<void>;
}

export function createCalendlyClient(fetchImpl: FetchLike): CalendlyClient {
  return {
    async me(token) {
      const body = await apiJson(
        fetchImpl,
        VENDOR,
        { method: "GET", url: `${CALENDLY_API}/users/me`, token },
        z.object({
          resource: z.object({
            uri: z.string().min(1),
            name: z.string().nullish(),
            current_organization: z.string().min(1),
            scheduling_url: z.string().nullish(),
          }),
        }),
      );
      return {
        uri: body.resource.uri,
        name: body.resource.name ?? null,
        organization: body.resource.current_organization,
        schedulingUrl: body.resource.scheduling_url ?? null,
      };
    },

    async eventTypes(token, userUri) {
      const out: CalendlyEventType[] = [];
      let next: string | null =
        `${CALENDLY_API}/event_types?user=${encodeURIComponent(userUri)}&count=100`;
      for (let page = 0; page < 10 && next !== null; page += 1) {
        if (!next.startsWith(`${CALENDLY_API}/`)) break;
        const body: {
          collection: {
            uri: string;
            name?: string | null | undefined;
            scheduling_url: string;
            active?: boolean | undefined;
          }[];
          pagination?: { next_page?: string | null | undefined } | undefined;
        } = await apiJson(
          fetchImpl,
          VENDOR,
          { method: "GET", url: next, token },
          z.object({
            collection: z.array(
              z.object({
                uri: z.string(),
                name: z.string().nullish(),
                scheduling_url: z.string(),
                active: z.boolean().optional(),
              }),
            ),
            pagination: z.object({ next_page: z.string().nullish() }).optional(),
          }),
        );
        for (const item of body.collection) {
          out.push({
            uri: item.uri,
            name: item.name ?? "Event",
            schedulingUrl: item.scheduling_url,
            active: item.active !== false,
          });
        }
        next = body.pagination?.next_page ?? null;
      }
      return out;
    },

    async createSchedulingLink(token, eventTypeUri) {
      const body = await apiJson(
        fetchImpl,
        VENDOR,
        {
          method: "POST",
          url: `${CALENDLY_API}/scheduling_links`,
          token,
          json: { max_event_count: 1, owner: eventTypeUri, owner_type: "EventType" },
        },
        z.object({ resource: z.object({ booking_url: z.string().min(1) }) }),
      );
      return body.resource.booking_url;
    },

    async createWebhook(token, input) {
      const body = await apiJson(
        fetchImpl,
        VENDOR,
        {
          method: "POST",
          url: `${CALENDLY_API}/webhook_subscriptions`,
          token,
          json: {
            url: input.url,
            events: ["invitee.created", "invitee.canceled"],
            organization: input.organization,
            user: input.user,
            scope: "user",
            ...(input.signingKey === null ? {} : { signing_key: input.signingKey }),
          },
        },
        z.object({ resource: z.object({ uri: z.string().min(1) }) }),
      );
      return body.resource.uri;
    },

    async deleteWebhook(token, webhookUri) {
      if (!webhookUri.startsWith(`${CALENDLY_API}/webhook_subscriptions/`)) return;
      try {
        await apiRequest(fetchImpl, VENDOR, { method: "DELETE", url: webhookUri, token });
      } catch (error) {
        if (error instanceof CalendarApiError && error.notFound) return;
        throw error;
      }
    },

    async cancelEvent(token, eventUri, reason) {
      const uuid = calendlyUuid(eventUri);
      if (uuid === null || !eventUri.startsWith(`${CALENDLY_API}/scheduled_events/`)) {
        throw new CalendarApiError(VENDOR, "Not a Calendly event.", { retryable: false });
      }
      try {
        await apiRequest(fetchImpl, VENDOR, {
          method: "POST",
          url: `${CALENDLY_API}/scheduled_events/${uuid}/cancellation`,
          token,
          json: { reason: reason.slice(0, 200) },
        });
      } catch (error) {
        // Already cancelled (Calendly answers 403 "Event already canceled" or 404).
        if (error instanceof CalendarApiError && (error.notFound || error.status === 403)) {
          if (error.notFound || /cancel/i.test(error.message)) return;
        }
        throw error;
      }
    },
  };
}
