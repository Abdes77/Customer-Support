import { createHmac } from "node:crypto";

import { ExternalServiceError } from "@repo/core";

/**
 * Live updates for the visitor's browser. What travels is a poke ("something changed in your
 * conversation"), never message text: the browser then fetches the new messages through the
 * authenticated API. So a leaked topic name reveals nothing, and the Realtime channel needs
 * no access to any table (ARCHITECTURE §3).
 */
export type WidgetPokeEvent = "message" | "typing";

export interface WidgetNotifier {
  notify(topic: string, event: WidgetPokeEvent): Promise<void>;
}

/** Used when no Realtime service is configured: the browser polls instead. */
export const silentNotifier: WidgetNotifier = { async notify() {} };

/**
 * The broadcast topic of one visitor: an HMAC of the connection and the visitor id, so it
 * cannot be guessed from anything the visitor or anyone else sees.
 */
export function visitorTopic(secret: string, connectionId: string, visitorId: string): string {
  const digest = createHmac("sha256", secret)
    .update("hsrb-widget-topic\n")
    .update(`${connectionId}:${visitorId}`)
    .digest("hex");
  return `widget-${digest.slice(0, 40)}`;
}

/**
 * Supabase Realtime broadcast through its REST endpoint
 * (`POST {url}/realtime/v1/api/broadcast`), with the service-role key. Server only.
 */
export function createRealtimeNotifier(options: {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): WidgetNotifier {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/realtime/v1/api/broadcast`;
  return {
    async notify(topic, event) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          apikey: options.serviceRoleKey,
          authorization: `Bearer ${options.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ topic, event: "poke", payload: { kind: event }, private: false }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        throw new ExternalServiceError(`Realtime broadcast failed with ${response.status}.`, {
          provider: "supabase_realtime",
          retryable: response.status >= 500 || response.status === 429,
        });
      }
    },
  };
}
