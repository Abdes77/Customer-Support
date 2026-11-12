import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  type FetchLike,
  networkFailure,
  type SmsTransport,
  type TransportResult,
  type VoiceTransport,
  withTimeout,
} from "./types";

/*
 * Twilio's REST API for alert text messages and escalation calls, and the check of Twilio's
 * webhook signatures. Built from Twilio's docs read on 2026-11-12 (Messages and Calls
 * resources, TwiML <Gather>, webhook security); there are no Twilio credentials in the build
 * environment, so the live behaviour is a check in docs/HUMAN_TODO.md.
 *
 * - Requests: `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`
 *   and `.../Calls.json`, form-encoded, HTTP basic auth (account SID, auth token).
 * - Signature: `X-Twilio-Signature` = base64(HMAC-SHA1(auth token, URL + every POST parameter
 *   name and value, sorted by name)). The URL is the one Twilio requested, query included.
 */

export const TWILIO_API_BASE = "https://api.twilio.com";
const TIMEOUT_MS = 15_000;

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  /** E.164 number that sends texts and places calls. */
  readonly fromNumber: string;
  /** Optional Messaging Service that sends texts instead of the bare number. */
  readonly messagingServiceSid: string | null;
  readonly fetch: FetchLike;
  /** Tests point it at a fake. */
  readonly baseUrl?: string;
}

const TwilioResource = z.object({ sid: z.string().min(1) }).loose();
const TwilioError = z
  .object({ code: z.number().optional(), message: z.string().optional() })
  .loose();

async function post(
  config: TwilioConfig,
  resource: "Messages" | "Calls",
  form: Record<string, string>,
): Promise<TransportResult> {
  const url = `${config.baseUrl ?? TWILIO_API_BASE}/2010-04-01/Accounts/${encodeURIComponent(
    config.accountSid,
  )}/${resource}.json`;
  let response: Response;
  try {
    response = await withTimeout(config.fetch, TIMEOUT_MS)(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
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
    const parsed = TwilioResource.safeParse(json);
    return { ok: true, providerId: parsed.success ? parsed.data.sid : null };
  }
  const error = TwilioError.safeParse(json);
  const code = error.success && error.data.code !== undefined ? String(error.data.code) : null;
  return {
    ok: false,
    // 429 and 5xx are worth another try; a 4xx (a bad number, an unverified trial number,
    // a refused credential) will not get better.
    retryable: response.status === 429 || response.status >= 500,
    code: code ?? `http_${response.status}`,
    message: `Twilio refused the ${resource === "Calls" ? "call" : "message"} (HTTP ${response.status}).`,
  };
}

export function createTwilioClient(config: TwilioConfig): {
  readonly sms: SmsTransport;
  readonly voice: VoiceTransport;
} {
  return {
    sms: {
      send: ({ to, body, statusCallbackUrl }) =>
        post(config, "Messages", {
          To: to,
          ...(config.messagingServiceSid === null
            ? { From: config.fromNumber }
            : { MessagingServiceSid: config.messagingServiceSid }),
          // Twilio's limit is 1,600 characters.
          Body: body.length <= 1600 ? body : `${body.slice(0, 1599)}…`,
          ...(statusCallbackUrl === null ? {} : { StatusCallback: statusCallbackUrl }),
        }),
    },
    voice: {
      call: ({ to, twiml, statusCallbackUrl }) =>
        post(config, "Calls", {
          To: to,
          From: config.fromNumber,
          Twiml: twiml,
          // Ring for 30 s; a voicemail box picking up still hears the message.
          Timeout: "30",
          ...(statusCallbackUrl === null
            ? {}
            : {
                StatusCallback: statusCallbackUrl,
                StatusCallbackMethod: "POST",
                StatusCallbackEvent: "completed",
              }),
        }),
    },
  };
}

/** The string Twilio signs: the URL, then each parameter's name and value, sorted by name. */
export function twilioSignatureBase(url: string, params: Readonly<Record<string, string>>): string {
  // Unix-style, case-sensitive ordering (code points), as Twilio's docs say.
  const names = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.reduce((text, name) => `${text}${name}${params[name] ?? ""}`, url);
}

export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  return createHmac("sha1", authToken).update(twilioSignatureBase(url, params)).digest("base64");
}

/**
 * Checks `X-Twilio-Signature` in constant time. Twilio drops the port of an https URL for
 * voice callbacks before signing, so a URL with an explicit port is also tried without it.
 */
export function verifyTwilioSignature(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly signature: string | null;
}): boolean {
  if (input.signature === null || input.signature.length === 0) return false;
  const presented = Buffer.from(input.signature, "utf8");
  const candidates = new Set([input.url]);
  const parsed = URL.canParse(input.url) ? new URL(input.url) : null;
  if (parsed !== null) {
    // The URL API drops a default port (":443") by itself; a non-default one is removed here.
    candidates.add(parsed.toString());
    parsed.port = "";
    candidates.add(parsed.toString());
  }
  let valid = false;
  for (const url of candidates) {
    const expected = Buffer.from(twilioSignature(input.authToken, url, input.params), "utf8");
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      valid = true;
    }
  }
  return valid;
}
