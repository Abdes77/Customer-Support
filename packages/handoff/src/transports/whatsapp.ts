import { z } from "zod";

import {
  type FetchLike,
  networkFailure,
  type TransportResult,
  type WhatsAppTransport,
  withTimeout,
} from "./types";

/**
 * Alert WhatsApp messages through the agency's own WhatsApp Cloud API number (DECISIONS 19):
 * `POST https://graph.facebook.com/{version}/{phone-number-id}/messages` with an approved
 * template whose body has one parameter (`ALERT_WHATSAPP_TEMPLATE`, for example "staff_alert"
 * with the body "New alert: {{1}}"). A message a business starts must be a template; staff
 * never wrote to the number first. Meta refuses newlines, tabs and runs of spaces in a
 * parameter, so the text is one line. Kept to one tiny call here because a domain package may
 * not import `@repo/channel-meta` (BUILD_PLAN layers); the request is the shape C9 verified.
 */

const GRAPH_BASE = "https://graph.facebook.com";
const TIMEOUT_MS = 15_000;
const MAX_PARAMETER = 1000;

const Sent = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) }).loose();
const Failure = z
  .object({ error: z.object({ code: z.number().optional(), message: z.string().optional() }) })
  .loose();

export function whatsappParameter(text: string): string {
  const line = text
    .replace(/[\r\n\t]+/g, " · ")
    .replace(/ {2,}/g, " ")
    .trim();
  return line.length <= MAX_PARAMETER ? line : `${line.slice(0, MAX_PARAMETER - 1)}…`;
}

export function createWhatsAppAlertTransport(config: {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly template: string;
  readonly language: string;
  readonly graphVersion: string;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
}): WhatsAppTransport {
  return {
    async send({ to, text }): Promise<TransportResult> {
      const url = `${config.baseUrl ?? GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(
        config.phoneNumberId,
      )}/messages`;
      let response: Response;
      try {
        response = await withTimeout(config.fetch, TIMEOUT_MS)(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: to.replace(/^\+/, ""),
            type: "template",
            template: {
              name: config.template,
              language: { code: config.language },
              components: [
                { type: "body", parameters: [{ type: "text", text: whatsappParameter(text) }] },
              ],
            },
          }),
        });
      } catch (error) {
        return networkFailure(error);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (response.ok) {
        const parsed = Sent.safeParse(json);
        return { ok: true, providerId: parsed.success ? parsed.data.messages[0]!.id : null };
      }
      const failure = Failure.safeParse(json);
      const code = failure.success ? failure.data.error.code : undefined;
      return {
        ok: false,
        retryable:
          response.status === 429 ||
          response.status >= 500 ||
          code === 4 ||
          code === 80007 ||
          code === 130429,
        code: code === undefined ? `http_${response.status}` : `meta_${code}`,
        message: `WhatsApp refused the alert (HTTP ${response.status}).`,
      };
    },
  };
}
