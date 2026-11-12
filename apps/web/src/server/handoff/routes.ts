import {
  acknowledgeByLink,
  type AckPageView,
  ackPageView,
  type HandoffDeps,
  type TwilioRequest,
  type TwilioResponse,
  type TwilioWebhookHandlers,
} from "@repo/handoff";
import { logger as rootLogger, type Logger } from "@repo/core";

/*
 * The handoff routes (C13), framework-free so tests drive them with plain `Request`s:
 * - `POST /api/handoff/twilio/{sms|voice|status}`: Twilio's callbacks, checked by Twilio's
 *   signature over the public URL (APP_URL, path and query) and the form parameters;
 * - `GET /api/handoff/ack/{token}`: the page an emergency alert links to (it never
 *   acknowledges: link scanners and previews open it), `POST` the same URL: acknowledge.
 * The page shows the business and the kind of emergency, never the customer's details; the
 * conversation itself needs a sign-in.
 */

const MAX_FORM_BYTES = 64 * 1024;

export interface HandoffRouteDeps {
  readonly twilio: () => TwilioWebhookHandlers;
  readonly handoff: () => Pick<HandoffDeps, "db" | "clock">;
  /** `APP_URL`: Twilio signs the URL it called, which is the public one. */
  readonly appUrl: string;
  readonly logger?: Logger;
}

function respond(result: TwilioResponse): Response {
  return new Response(result.body.length === 0 ? null : result.body, {
    status: result.status,
    headers: { "content-type": result.contentType, "cache-control": "no-store" },
  });
}

/** The URL Twilio called: the public origin with the request's path and query. */
export function publicRequestUrl(request: Request, appUrl: string): string {
  const url = new URL(request.url);
  const origin = new URL(appUrl);
  return `${origin.origin}${url.pathname}${url.search}`;
}

async function twilioRequest(request: Request, appUrl: string): Promise<TwilioRequest | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_FORM_BYTES) return null;
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
  return {
    url: publicRequestUrl(request, appUrl),
    params,
    signature: request.headers.get("x-twilio-signature"),
  };
}

/** `POST /api/handoff/twilio/{sms|voice|status}`. */
export function createTwilioRouteHandler(deps: HandoffRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "twilio-route" });
  return async (request: Request, kind: string): Promise<Response> => {
    if (kind !== "sms" && kind !== "voice" && kind !== "status") {
      return new Response("not found", { status: 404 });
    }
    const parsed = await twilioRequest(request, deps.appUrl);
    if (parsed === null) return new Response("bad request", { status: 400 });
    try {
      return respond(await deps.twilio()[kind](parsed));
    } catch (error) {
      log.error("twilio.callback_failed", { kind, error });
      // Twilio retries status callbacks; for a text or a keypress the person tries again.
      return new Response("error", { status: 500 });
    }
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111}h1{font-size:1.4rem}button{font-size:1.1rem;padding:.8rem 1.4rem;border:0;border-radius:.5rem;background:#b91c1c;color:#fff;cursor:pointer}.muted{color:#555}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const NOT_FOUND = () =>
  page(
    404,
    "Link not valid",
    '<h1>This link is not valid</h1><p class="muted">Check the alert you received, or open the conversation in the admin panel.</p>',
  );

function stateText(view: AckPageView): string {
  if (view.state === "acknowledged") {
    const by = view.acknowledgedBy === null ? "" : ` by ${escapeHtml(view.acknowledgedBy)}`;
    return `<p>This emergency was already acknowledged${by}. The alerts have stopped.</p>`;
  }
  return "<p>This emergency's alerts have ended. Open the conversation in the admin panel.</p>";
}

/** `GET` and `POST /api/handoff/ack/{token}`. */
export function createAckRouteHandlers(deps: HandoffRouteDeps) {
  const log = (deps.logger ?? rootLogger).child({ component: "ack-route" });
  return {
    async get(token: string): Promise<Response> {
      const view = await ackPageView(deps.handoff(), token);
      if (view === null) return NOT_FOUND();
      const heading = `<h1>Emergency for ${escapeHtml(view.businessName)}</h1><p><strong>${escapeHtml(view.emergencyLabel)}</strong></p>`;
      if (view.state !== "active") return page(200, "Emergency", `${heading}${stateText(view)}`);
      return page(
        200,
        "Acknowledge emergency",
        `${heading}<p>A customer needs help now. Acknowledging tells the team you are handling it and stops the alerts to everyone else.</p><form method="post"><button type="submit">I'm on it: acknowledge</button></form><p class="muted">Then open the conversation in the admin panel to reach the customer.</p>`,
      );
    },
    async post(token: string): Promise<Response> {
      try {
        const result = await acknowledgeByLink(deps.handoff(), token);
        if (result === null) return NOT_FOUND();
        if (result.kind === "acknowledged") {
          return page(
            200,
            "Acknowledged",
            `<h1>Acknowledged</h1><p>Thank you, ${escapeHtml(result.by)}. The alerts have stopped. Open the conversation in the admin panel to reach the customer.</p>`,
          );
        }
        if (result.kind === "already") {
          const by = result.by === null ? "" : ` by ${escapeHtml(result.by)}`;
          return page(200, "Already acknowledged", `<h1>Already acknowledged${by}</h1>`);
        }
        return page(200, "Alerts ended", "<h1>This emergency's alerts have ended.</h1>");
      } catch (error) {
        log.error("ack.failed", { error });
        return page(
          500,
          "Try again",
          "<h1>Something went wrong</h1><p>Try again, or call the office.</p>",
        );
      }
    },
  };
}
