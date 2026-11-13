import { type Env, getEnv } from "@repo/core/env";

import { createSmtpAlertTransport } from "./transports/smtp";
import { createTwilioClient } from "./transports/twilio";
import { type AlertTransports, type FetchLike } from "./transports/types";
import { createWhatsAppAlertTransport } from "./transports/whatsapp";

/**
 * The alert transports this deployment has, from the environment: Twilio (SMS and calls)
 * with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`; email with
 * `ALERT_SMTP_URL` and `ALERT_EMAIL_FROM`; WhatsApp with `ALERT_WHATSAPP_PHONE_NUMBER_ID`,
 * `ALERT_WHATSAPP_ACCESS_TOKEN` and `ALERT_WHATSAPP_TEMPLATE`. A missing one is null: its
 * alerts are recorded as `not_configured` and the emergency chain moves on.
 */
export function alertTransportsFromEnv(
  options: { readonly env?: Env; readonly fetch?: FetchLike } = {},
): AlertTransports {
  const env = options.env ?? getEnv();
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const twilio =
    env.TWILIO_ACCOUNT_SID !== undefined &&
    env.TWILIO_AUTH_TOKEN !== undefined &&
    env.TWILIO_FROM_NUMBER !== undefined
      ? createTwilioClient({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          fromNumber: env.TWILIO_FROM_NUMBER,
          messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
          fetch: fetchFn,
        })
      : null;
  return {
    sms: twilio?.sms ?? null,
    voice: twilio?.voice ?? null,
    email:
      env.ALERT_SMTP_URL !== undefined && env.ALERT_EMAIL_FROM !== undefined
        ? createSmtpAlertTransport({ url: env.ALERT_SMTP_URL, from: env.ALERT_EMAIL_FROM })
        : null,
    whatsapp:
      env.ALERT_WHATSAPP_PHONE_NUMBER_ID !== undefined &&
      env.ALERT_WHATSAPP_ACCESS_TOKEN !== undefined &&
      env.ALERT_WHATSAPP_TEMPLATE !== undefined
        ? createWhatsAppAlertTransport({
            phoneNumberId: env.ALERT_WHATSAPP_PHONE_NUMBER_ID,
            accessToken: env.ALERT_WHATSAPP_ACCESS_TOKEN,
            template: env.ALERT_WHATSAPP_TEMPLATE,
            language: env.ALERT_WHATSAPP_TEMPLATE_LANGUAGE,
            graphVersion: env.META_GRAPH_API_VERSION,
            fetch: fetchFn,
          })
        : null,
  };
}

/** Twilio's auth token checks its webhooks; null when Twilio is not configured. */
export function twilioAuthTokenFromEnv(env: Env = getEnv()): string | null {
  return env.TWILIO_AUTH_TOKEN ?? null;
}
