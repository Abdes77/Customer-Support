import { alerts, and, eq, inArray } from "@repo/db";

import { clockOf, type HandoffDeps } from "../deps";
import { escapeXml } from "../text";
import { verifyTwilioSignature } from "../transports/twilio";
import { acknowledgeByCall, acknowledgeBySms } from "./ack";

/*
 * Twilio's requests to the app (framework-free: the routes hand in the URL Twilio requested,
 * the form parameters and the signature header, and send back what these return):
 * - a text message to the alert number: acknowledges with the alert's code;
 * - the keypress on an escalation call;
 * - delivery status of an alert text message or call.
 * Every request is refused (403) unless `X-Twilio-Signature` is valid for this account.
 */

export interface TwilioRequest {
  /** The full URL Twilio requested (the public origin, path and query). */
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly signature: string | null;
}

export interface TwilioResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function twiml(inner = ""): TwilioResponse {
  return {
    status: 200,
    contentType: "text/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
  };
}

const FORBIDDEN: TwilioResponse = { status: 403, contentType: "text/plain", body: "forbidden" };

/** Status words Twilio reports, mapped onto the alert statuses that move forward only. */
const DELIVERED = new Set(["delivered", "read", "completed"]);
const FAILED = new Set(["failed", "undelivered", "busy", "no-answer", "canceled"]);

export function createTwilioWebhookHandlers(
  deps: Pick<HandoffDeps, "db" | "logger" | "clock"> & { readonly authToken: string | null },
) {
  const log = deps.logger.child({ component: "twilio-webhooks" });
  const verified = (request: TwilioRequest): boolean =>
    deps.authToken !== null &&
    verifyTwilioSignature({
      authToken: deps.authToken,
      url: request.url,
      params: request.params,
      signature: request.signature,
    });

  return {
    /** `POST /api/handoff/twilio/sms`: a reply to an alert text message. */
    async sms(request: TwilioRequest): Promise<TwilioResponse> {
      if (!verified(request)) return FORBIDDEN;
      const from = request.params["From"] ?? "";
      const body = request.params["Body"] ?? "";
      const result = await acknowledgeBySms(deps, { from, body });
      log.info("twilio.sms_reply", { outcome: result.kind });
      switch (result.kind) {
        case "acknowledged":
          return twiml(
            "<Message>Thank you. The emergency is acknowledged and the alerts have stopped.</Message>",
          );
        case "already":
          return twiml(
            `<Message>${escapeXml(`This emergency was already acknowledged${result.by === null ? "" : ` by ${result.by}`}.`)}</Message>`,
          );
        case "no_code":
          return twiml(
            "<Message>To acknowledge an emergency alert, reply with the 6-digit code from the alert.</Message>",
          );
        default:
          // An unknown code, a code from another number, or a chain that has ended.
          return twiml();
      }
    },

    /** `POST /api/handoff/twilio/voice?alert=…&t=…`: the keypress on an escalation call. */
    async voice(request: TwilioRequest): Promise<TwilioResponse> {
      if (!verified(request)) return FORBIDDEN;
      const url = new URL(request.url);
      const alertId = url.searchParams.get("alert") ?? "";
      const secret = url.searchParams.get("t") ?? "";
      const result = await acknowledgeByCall(deps, {
        alertId,
        secret,
        digits: request.params["Digits"] ?? "",
      });
      log.info("twilio.voice_keypress", { outcome: result?.kind ?? "not_acknowledged" });
      if (result?.kind === "acknowledged" || result?.kind === "already") {
        return twiml(
          "<Say>Thank you. The emergency is acknowledged. Open the conversation from the text message to reach the customer.</Say>",
        );
      }
      return twiml("<Say>The emergency was not acknowledged. Goodbye.</Say>");
    },

    /** `POST /api/handoff/twilio/status?alert=…`: delivery of an alert text or call. */
    async status(request: TwilioRequest): Promise<TwilioResponse> {
      if (!verified(request)) return FORBIDDEN;
      const alertId = new URL(request.url).searchParams.get("alert") ?? "";
      const ref = await deps.db.directory.findAlert(alertId);
      const word = (
        request.params["MessageStatus"] ??
        request.params["CallStatus"] ??
        ""
      ).toLowerCase();
      if (ref === null || word.length === 0)
        return { status: 204, contentType: "text/plain", body: "" };
      const errorCode = (request.params["ErrorCode"] ?? "").slice(0, 20);
      const now = clockOf(deps)();
      await deps.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
        if (DELIVERED.has(word)) {
          await ctx.tx
            .update(alerts)
            .set({ status: "delivered", updatedAt: now })
            .where(and(eq(alerts.id, alertId), inArray(alerts.status, ["pending", "sent"])));
        } else if (FAILED.has(word)) {
          await ctx.tx
            .update(alerts)
            .set({
              status: "failed",
              error: `${word}${errorCode.length > 0 ? `: ${errorCode}` : ""}`,
              updatedAt: now,
            })
            .where(and(eq(alerts.id, alertId), inArray(alerts.status, ["pending", "sent"])));
        }
      });
      return { status: 204, contentType: "text/plain", body: "" };
    },
  };
}

export type TwilioWebhookHandlers = ReturnType<typeof createTwilioWebhookHandlers>;
