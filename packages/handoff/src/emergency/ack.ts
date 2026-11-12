import { timingSafeEqual } from "node:crypto";

import type { UserId } from "@repo/core";
import {
  alerts,
  and,
  type BusinessContext,
  type BusinessTenant,
  businesses,
  eq,
  escalations,
  type EscalationAckChannel,
  sql,
} from "@repo/db";

import { ackCodeHash, parseAckToken, sha256 } from "../alerts/deliver";
import { clockOf, type HandoffDeps } from "../deps";
import { maskPhone } from "../text";
import { type AckResult, acknowledgeEscalation } from "./escalation";

/*
 * The ways an alerted person acknowledges an emergency without signing in. Each one proves
 * possession of something only that person was sent: the secret in their link (256 bits,
 * only its hash stored), the six-digit code of their text message from their own number, or
 * the keypress on the call placed to them (the call's callback carries the call's secret and
 * Twilio's signature). Nothing here reveals the customer's details.
 */

function sameHash(stored: string | null, presented: string): boolean {
  if (stored === null) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface AckAlert {
  readonly alertId: string;
  readonly escalationId: string;
  readonly contactName: string;
  readonly recipient: string;
  readonly channel: string;
}

async function loadAckAlert(ctx: BusinessContext, alertId: string) {
  const [row] = await ctx.tx
    .select({
      id: alerts.id,
      escalationId: alerts.escalationId,
      channel: alerts.channel,
      recipient: alerts.recipient,
      tokenHash: alerts.ackTokenHash,
      codeHash: alerts.ackCodeHash,
      payload: alerts.payload,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  return row;
}

function who(alert: AckAlert): string {
  const name = alert.contactName.length > 0 ? alert.contactName : "An escalation contact";
  return alert.channel === "email" ? name : `${name} (${maskPhone(alert.recipient)})`;
}

/** What the acknowledgement page shows: nothing about the customer. */
export interface AckPageView {
  readonly state: "active" | "acknowledged" | "ended";
  readonly businessName: string;
  readonly emergencyLabel: string;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
}

/**
 * Checks an acknowledgement link (`<alert id>.<secret>`) and returns the alert it names, or
 * null for anything that does not match exactly (the same answer for an unknown alert and a
 * wrong secret).
 */
export async function verifyAckLink(
  deps: Pick<HandoffDeps, "db">,
  token: string,
): Promise<{ readonly tenant: BusinessTenant; readonly alert: AckAlert } | null> {
  const parsed = parseAckToken(token);
  if (parsed === null) return null;
  const ref = await deps.db.directory.findAlert(parsed.alertId);
  if (ref === null) return null;
  const tenant: BusinessTenant = { agencyId: ref.agencyId, businessId: ref.businessId };
  const alert = await deps.db
    .forBusiness(ref.businessId, { agencyId: ref.agencyId })
    .run(async (ctx) => {
      const row = await loadAckAlert(ctx, parsed.alertId);
      if (row === undefined || row.escalationId === null) return null;
      if (!sameHash(row.tokenHash, sha256(parsed.secret))) return null;
      return {
        alertId: row.id,
        escalationId: row.escalationId,
        contactName:
          typeof row.payload["contactName"] === "string" ? row.payload["contactName"] : "",
        recipient: row.recipient,
        channel: row.channel,
      };
    });
  return alert === null ? null : { tenant, alert };
}

/** The page behind a valid link (GET): never acknowledges, so link scanners change nothing. */
export async function ackPageView(
  deps: Pick<HandoffDeps, "db">,
  token: string,
): Promise<AckPageView | null> {
  const verified = await verifyAckLink(deps, token);
  if (verified === null) return null;
  const { tenant, alert } = verified;
  return deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
    const [row] = await ctx.tx
      .select({
        status: escalations.status,
        policy: escalations.policy,
        emergencyClass: escalations.emergencyClass,
        by: escalations.acknowledgedBy,
        at: escalations.acknowledgedAt,
        businessName: businesses.name,
      })
      .from(escalations)
      .innerJoin(businesses, eq(businesses.id, escalations.businessId))
      .where(eq(escalations.id, alert.escalationId))
      .limit(1);
    if (row === undefined) return null;
    const label = row.policy["emergencyLabel"];
    return {
      state:
        row.status === "active"
          ? "active"
          : row.status === "acknowledged"
            ? "acknowledged"
            : "ended",
      businessName: row.businessName,
      emergencyLabel: typeof label === "string" ? label : row.emergencyClass,
      acknowledgedBy: row.by,
      acknowledgedAt: row.at?.toISOString() ?? null,
    } satisfies AckPageView;
  });
}

async function acknowledgeAlert(
  deps: Pick<HandoffDeps, "db" | "clock">,
  tenant: BusinessTenant,
  alert: AckAlert,
  via: EscalationAckChannel,
): Promise<AckResult> {
  const now = clockOf(deps)();
  return deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run((ctx) =>
    acknowledgeEscalation(ctx, {
      escalationId: alert.escalationId,
      via,
      by: who(alert),
      userId: null,
      alertId: alert.alertId,
      now,
    }),
  );
}

/** The acknowledgement page's button (POST). */
export async function acknowledgeByLink(
  deps: Pick<HandoffDeps, "db" | "clock">,
  token: string,
): Promise<AckResult | null> {
  const verified = await verifyAckLink(deps, token);
  if (verified === null) return null;
  return acknowledgeAlert(deps, verified.tenant, verified.alert, "link");
}

/** The keypress on an escalation call: the call's alert, its secret, and digit 1. */
export async function acknowledgeByCall(
  deps: Pick<HandoffDeps, "db" | "clock">,
  input: { readonly alertId: string; readonly secret: string; readonly digits: string },
): Promise<AckResult | null> {
  if (input.digits.trim() !== "1") return null;
  const verified = await verifyAckLink(deps, `${input.alertId}.${input.secret}`);
  if (verified?.alert.channel !== "voice") return null;
  return acknowledgeAlert(deps, verified.tenant, verified.alert, "voice");
}

/** Wrong codes from the alerted number before an alert's code stops being accepted. */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * A text message to the alert number: the six-digit code of an emergency alert sent to that
 * very number while its chain is active. A code from another number, an old chain or a
 * stranger matches nothing. Each wrong code from the alerted number counts against that
 * number's alerts; after `MAX_CODE_ATTEMPTS` their codes are no longer accepted (the link and
 * the call still work), so the one-in-a-million code cannot be guessed by repetition.
 */
export async function acknowledgeBySms(
  deps: Pick<HandoffDeps, "db" | "clock">,
  input: { readonly from: string; readonly body: string },
): Promise<AckResult | { readonly kind: "no_code" } | { readonly kind: "no_match" }> {
  const code = /(?:^|\D)(\d{6})(?:\D|$)/.exec(input.body)?.[1];
  if (code === undefined) return { kind: "no_code" };
  const candidates = await deps.db.directory.findActiveEmergencyAlertsByRecipient(input.from);
  for (const ref of candidates) {
    const alert = await deps.db
      .forBusiness(ref.businessId, { agencyId: ref.agencyId })
      .run(async (ctx) => {
        const row = await loadAckAlert(ctx, ref.alertId);
        if (row === undefined || row.escalationId === null || row.recipient !== input.from) {
          return null;
        }
        if (codeAttempts(row.payload) >= MAX_CODE_ATTEMPTS) return null;
        if (!sameHash(row.codeHash, ackCodeHash(row.id, code))) return null;
        return {
          alertId: row.id,
          escalationId: row.escalationId,
          contactName:
            typeof row.payload["contactName"] === "string" ? row.payload["contactName"] : "",
          recipient: row.recipient,
          channel: row.channel,
        };
      });
    if (alert !== null) {
      return acknowledgeAlert(
        deps,
        { agencyId: ref.agencyId, businessId: ref.businessId },
        alert,
        "sms",
      );
    }
  }
  // No alert of this number took the code: count it against each of them.
  for (const ref of candidates) {
    await deps.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
      await ctx.tx
        .update(alerts)
        .set({
          payload: sql`jsonb_set(${alerts.payload}, '{ackCodeAttempts}', to_jsonb(coalesce((${alerts.payload} ->> 'ackCodeAttempts')::int, 0) + 1))`,
        })
        .where(and(eq(alerts.id, ref.alertId), eq(alerts.recipient, input.from)));
    });
  }
  return { kind: "no_match" };
}

function codeAttempts(payload: Record<string, unknown>): number {
  const value = payload["ackCodeAttempts"];
  return typeof value === "number" ? value : 0;
}

/** A signed-in person in the admin panel (C16 checks the role first). */
export async function acknowledgeByUser(
  deps: Pick<HandoffDeps, "db" | "clock">,
  input: {
    readonly tenant: BusinessTenant;
    readonly escalationId: string;
    readonly userId: UserId;
    readonly userLabel: string;
  },
): Promise<AckResult> {
  const now = clockOf(deps)();
  return deps.db
    .forBusiness(input.tenant.businessId, { agencyId: input.tenant.agencyId })
    .run(async (ctx) => {
      const [row] = await ctx.tx
        .select({ id: escalations.id })
        .from(escalations)
        .where(and(eq(escalations.id, input.escalationId)))
        .limit(1);
      if (row === undefined) return { kind: "not_found" } as const;
      return acknowledgeEscalation(ctx, {
        escalationId: row.id,
        via: "admin_panel",
        by: input.userLabel,
        userId: input.userId,
        alertId: null,
        now,
      });
    });
}
