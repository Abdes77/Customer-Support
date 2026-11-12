import { createHash, randomBytes, randomInt } from "node:crypto";

import type { BusinessContext, BusinessTenant } from "@repo/db";
import { alerts, eq } from "@repo/db";

import { clockOf, HANDOFF_ROUTES, type HandoffDeps, publicUrl } from "../deps";
import { escapeXml, maskPhone } from "../text";
import type { TransportResult } from "../transports/types";

/*
 * Delivering one alert row. The row is the alert's intent (status `pending`); the delivery
 * locks it, sends it through the transport of its channel and records what happened, in one
 * transaction, so two runs never send the same row twice and nothing is marked sent before
 * the provider took it. A provider that refuses is recorded (`failed`, with the reason); a
 * missing transport is `not_configured`. Nothing here throws for a vendor's answer.
 */

export const ALERT_CHANNELS = ["email", "sms", "whatsapp", "voice"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type DeliveryOutcome =
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly code: string }
  /** Still pending: a retryable failure the caller may try again after a pause. */
  | { readonly status: "retry"; readonly code: string }
  /** Nothing to do: the row is gone, already sent, acknowledged or its chain ended. */
  | { readonly status: "skipped" };

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The secret of an acknowledgement link: 256 random bits, base64url. */
export function newAckSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The six-digit code a text-message alert asks to reply with. */
export function newAckCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function ackCodeHash(alertId: string, code: string): string {
  return sha256(`${alertId}:${code}`);
}

/** The token in an acknowledgement link: the alert's id and its secret. */
export function ackToken(alertId: string, secret: string): string {
  return `${alertId}.${secret}`;
}

export function parseAckToken(token: string): { alertId: string; secret: string } | null {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
      token,
    );
  return match === null ? null : { alertId: match[1]!.toLowerCase(), secret: match[2]! };
}

/** Twilio reaches only a public https address; local development gets no callbacks. */
function callbackUrl(appUrl: string, path: string, query: Record<string, string>): string | null {
  if (!appUrl.startsWith("https://")) return null;
  const url = new URL(publicUrl(appUrl, path));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** The call an escalation places: who it is for, the emergency, and "press 1". */
export function escalationTwiml(input: {
  readonly businessName: string;
  readonly emergencyLabel: string;
  readonly gatherUrl: string | null;
}): string {
  const message = escapeXml(
    `This is an emergency alert for ${input.businessName}: ${input.emergencyLabel}. A customer needs help now. The details were sent to you by text message.`,
  );
  const gather =
    input.gatherUrl === null
      ? `<Say>${message}</Say>`
      : `<Gather input="dtmf" numDigits="1" timeout="10" action="${escapeXml(input.gatherUrl)}" method="POST"><Say>${message}</Say><Say>Press 1 to acknowledge this emergency.</Say></Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather}<Say>${message}</Say><Say>Goodbye.</Say></Response>`;
}

/**
 * Sends one pending alert row. `ackable` alerts (an emergency's) get a fresh acknowledgement
 * secret at the moment they are sent: the link (and the code, for a text message) is appended
 * to the text, and only their hashes are stored, so the stored body never holds them.
 * `isActive`, when given, is checked under the row lock first: an emergency alert whose chain
 * was acknowledged in the meantime is not sent.
 */
export async function deliverAlert(
  deps: Pick<HandoffDeps, "db" | "logger" | "clock" | "appUrl" | "transports">,
  tenant: BusinessTenant,
  alertId: string,
  options: {
    readonly ackable?: { readonly businessName: string; readonly emergencyLabel: string };
    readonly isActive?: (ctx: BusinessContext) => Promise<boolean>;
    /** Attempts before a retryable failure counts as final. */
    readonly maxAttempts?: number;
  } = {},
): Promise<DeliveryOutcome> {
  const clock = clockOf(deps);
  const maxAttempts = options.maxAttempts ?? 3;
  return deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
    // The chain's row first, then the alert's: the order an acknowledgement takes them in.
    const active = options.isActive === undefined ? true : await options.isActive(ctx);
    const [row] = await ctx.tx
      .select({
        id: alerts.id,
        status: alerts.status,
        channel: alerts.channel,
        recipient: alerts.recipient,
        subject: alerts.subject,
        body: alerts.body,
        payload: alerts.payload,
      })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .for("update")
      .limit(1);
    if (row?.status !== "pending") return { status: "skipped" };
    if (!active) {
      await ctx.tx
        .update(alerts)
        .set({ status: "suppressed", error: "chain_ended" })
        .where(eq(alerts.id, alertId));
      return { status: "skipped" };
    }

    const body = row.body ?? "";
    let text = body;
    let ack: { tokenHash: string; codeHash: string | null } | null = null;
    let gatherUrl: string | null = null;
    if (options.ackable !== undefined) {
      const secret = newAckSecret();
      const link = publicUrl(deps.appUrl, HANDOFF_ROUTES.acknowledge(ackToken(row.id, secret)));
      if (row.channel === "sms") {
        const code = newAckCode();
        ack = { tokenHash: sha256(secret), codeHash: ackCodeHash(row.id, code) };
        text = `${body} Reply ${code} to acknowledge, or open ${link}`;
      } else if (row.channel === "voice") {
        ack = { tokenHash: sha256(secret), codeHash: null };
        gatherUrl = callbackUrl(deps.appUrl, HANDOFF_ROUTES.twilioVoice, {
          alert: row.id,
          t: secret,
        });
      } else {
        ack = { tokenHash: sha256(secret), codeHash: null };
        text = `${body}\n\nAcknowledge this emergency (this stops the escalation): ${link}`;
      }
    }

    const status = callbackUrl(deps.appUrl, HANDOFF_ROUTES.twilioStatus, { alert: row.id });
    const target = row;
    const send = (): Promise<TransportResult> => {
      switch (target.channel) {
        case "sms":
          return deps.transports.sms === null
            ? Promise.resolve(notConfigured("sms"))
            : deps.transports.sms.send({
                to: target.recipient,
                body: text,
                statusCallbackUrl: status,
              });
        case "whatsapp":
          return deps.transports.whatsapp === null
            ? Promise.resolve(notConfigured("whatsapp"))
            : deps.transports.whatsapp.send({ to: target.recipient, text });
        case "email":
          return deps.transports.email === null
            ? Promise.resolve(notConfigured("email"))
            : deps.transports.email.send({
                to: target.recipient,
                subject: row.subject ?? "Alert",
                text,
              });
        case "voice":
          return deps.transports.voice === null
            ? Promise.resolve(notConfigured("voice"))
            : deps.transports.voice.call({
                to: target.recipient,
                twiml: escalationTwiml({
                  businessName: options.ackable?.businessName ?? "your business",
                  emergencyLabel: options.ackable?.emergencyLabel ?? "an emergency",
                  gatherUrl,
                }),
                statusCallbackUrl: status,
              });
        default:
          return Promise.resolve(notConfigured(target.channel));
      }
    };
    let result: TransportResult;
    try {
      result = await send();
    } catch (error) {
      // A transport that throws (a bug, an unexpected library error) is a failed attempt like
      // a refusal: recorded on the row, so the chain and the next recipient go on.
      deps.logger.error("alert.transport_threw", {
        businessId: tenant.businessId,
        alertId,
        channel: row.channel,
        error: error instanceof Error ? { name: error.name } : { name: "Error" },
      });
      result = {
        ok: false,
        retryable: true,
        code: "transport_error",
        message: "The alert transport failed unexpectedly.",
      };
    }

    const attempts =
      (typeof row.payload["attempts"] === "number" ? row.payload["attempts"] : 0) + 1;
    if (result.ok) {
      await ctx.tx
        .update(alerts)
        .set({
          status: "sent",
          sentAt: clock(),
          providerMessageId: result.providerId,
          error: null,
          payload: { ...row.payload, attempts },
          ...(ack === null ? {} : { ackTokenHash: ack.tokenHash, ackCodeHash: ack.codeHash }),
        })
        .where(eq(alerts.id, alertId));
      deps.logger.info("alert.sent", {
        businessId: tenant.businessId,
        alertId,
        channel: row.channel,
        recipient: row.channel === "email" ? "email" : maskPhone(row.recipient),
      });
      return { status: "sent" };
    }
    const final = !result.retryable || attempts >= maxAttempts;
    await ctx.tx
      .update(alerts)
      .set({
        ...(final ? { status: "failed" as const } : {}),
        error: `${result.code}: ${result.message}`.slice(0, 300),
        payload: { ...row.payload, attempts },
      })
      .where(eq(alerts.id, alertId));
    deps.logger.warn("alert.failed", {
      businessId: tenant.businessId,
      alertId,
      channel: row.channel,
      code: result.code,
      final,
    });
    return final ? { status: "failed", code: result.code } : { status: "retry", code: result.code };
  });
}

function notConfigured(channel: string): TransportResult {
  return {
    ok: false,
    retryable: false,
    code: "not_configured",
    message: `Alerts by ${channel} are not configured on this deployment.`,
  };
}
