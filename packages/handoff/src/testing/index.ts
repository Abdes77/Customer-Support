/**
 * Test doubles for handoff (no vendor account needed): a fake of Twilio's REST API behind an
 * injected `fetch`, a fake of the WhatsApp Cloud API's messages endpoint, and recording
 * transports whose answers a test chooses per channel.
 */
import type {
  AlertTransports,
  EmailTransport,
  FetchLike,
  SmsTransport,
  TransportResult,
  VoiceTransport,
  WhatsAppTransport,
} from "../transports/types";

export { twilioSignature } from "../transports/twilio";

export interface FakeTwilioRequest {
  readonly resource: "Messages" | "Calls";
  readonly accountSid: string;
  readonly authorization: string | null;
  readonly params: Record<string, string>;
}

/**
 * Twilio's `Messages.json` and `Calls.json`. Answers 201 with a SID, or what `failNext`
 * queued (a status and Twilio's error body).
 */
export function createFakeTwilio() {
  const requests: FakeTwilioRequest[] = [];
  const failures: { status: number; code: number }[] = [];
  let counter = 0;
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input);
    const match = /\/2010-04-01\/Accounts\/([^/]+)\/(Messages|Calls)\.json$/.exec(url.pathname);
    if (match === null || init?.method !== "POST") {
      return Response.json({ code: 20404, message: "Not found" }, { status: 404 });
    }
    const params = Object.fromEntries(
      new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    );
    const headers = new Headers(init.headers);
    requests.push({
      resource: match[2] as "Messages" | "Calls",
      accountSid: decodeURIComponent(match[1]!),
      authorization: headers.get("authorization"),
      params,
    });
    const failure = failures.shift();
    if (failure !== undefined) {
      return Response.json(
        { code: failure.code, message: "Refused by the fake", status: failure.status },
        { status: failure.status },
      );
    }
    counter += 1;
    const prefix = match[2] === "Calls" ? "CA" : "SM";
    return Response.json(
      { sid: `${prefix}${String(counter).padStart(32, "0")}`, status: "queued" },
      { status: 201 },
    );
  };
  return {
    fetch: fetchFn,
    requests,
    /** The next request(s) fail with this HTTP status and Twilio error code. */
    failNext(status: number, code: number, times = 1) {
      for (let index = 0; index < times; index += 1) failures.push({ status, code });
    },
    messages: () => requests.filter((request) => request.resource === "Messages"),
    calls: () => requests.filter((request) => request.resource === "Calls"),
  };
}

/** The WhatsApp Cloud API's `/{phone-number-id}/messages`. */
export function createFakeWhatsAppGraph() {
  const requests: { url: string; body: unknown; authorization: string | null }[] = [];
  let counter = 0;
  const fetchFn: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: input,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown,
      authorization: headers.get("authorization"),
    });
    counter += 1;
    return Response.json({ messages: [{ id: `wamid.fake${counter}` }] }, { status: 200 });
  };
  return { fetch: fetchFn, requests };
}

export interface RecordedSend {
  readonly channel: "sms" | "voice" | "email" | "whatsapp";
  readonly to: string;
  readonly text: string;
  readonly subject?: string;
}

/**
 * Transports that record what they were asked to send. `answer` decides each result (default:
 * accepted); `null` channels behave as "not configured".
 */
export function createRecordingTransports(
  options: {
    readonly answer?: (send: RecordedSend) => TransportResult;
    readonly missing?: readonly RecordedSend["channel"][];
  } = {},
): AlertTransports & { readonly sent: RecordedSend[] } {
  const sent: RecordedSend[] = [];
  let counter = 0;
  const reply = (send: RecordedSend): TransportResult => {
    sent.push(send);
    counter += 1;
    return options.answer?.(send) ?? { ok: true, providerId: `fake-${counter}` };
  };
  const missing = new Set(options.missing ?? []);
  const sms: SmsTransport = {
    send: async ({ to, body }) => reply({ channel: "sms", to, text: body }),
  };
  const voice: VoiceTransport = {
    call: async ({ to, twiml }) => reply({ channel: "voice", to, text: twiml }),
  };
  const email: EmailTransport = {
    send: async ({ to, subject, text }) => reply({ channel: "email", to, text, subject }),
  };
  const whatsapp: WhatsAppTransport = {
    send: async ({ to, text }) => reply({ channel: "whatsapp", to, text }),
  };
  return {
    sent,
    sms: missing.has("sms") ? null : sms,
    voice: missing.has("voice") ? null : voice,
    email: missing.has("email") ? null : email,
    whatsapp: missing.has("whatsapp") ? null : whatsapp,
  };
}
