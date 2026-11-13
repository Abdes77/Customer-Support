import type { ConversationId, LeadId } from "@repo/core";
import { alerts, and, type BusinessContext, eq, inArray } from "@repo/db";
import type { AppSettings } from "@repo/settings";

import { HANDOFF_ROUTES, publicUrl } from "../deps";
import type { ConversationFacts } from "../facts";
import { windowEnd } from "../time";
import type { AlertChannel } from "./deliver";
import { sha256 } from "./deliver";
import { type AlertKind, renderLeadAlert } from "./render";

/** One person who receives alerts, from `alerts.recipients` or `alerts.agency_recipients`. */
export interface AlertRecipient {
  /** Stable within its list (names are unique per list); used in dedupe keys. */
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly channels: readonly ("email" | "sms" | "whatsapp")[];
}

/**
 * Who is alerted about `kind`: the business's recipients and the agency's, active ones whose
 * own selection includes it (an empty selection means everything `alerts.events` switches
 * on). Nobody is alerted about an event `alerts.events` leaves off.
 */
export function recipientsFor(values: AppSettings, kind: AlertKind): AlertRecipient[] {
  if (!values["alerts.events"].includes(kind)) return [];
  const pick = (list: AppSettings["alerts.recipients"], scope: "b" | "a"): AlertRecipient[] =>
    list
      .filter(
        (recipient) =>
          recipient.active && (recipient.events.length === 0 || recipient.events.includes(kind)),
      )
      .map((recipient) => ({
        key: `${scope}${sha256(recipient.name.trim().toLowerCase()).slice(0, 12)}`,
        name: recipient.name,
        email: recipient.email,
        phone: recipient.phone,
        channels: recipient.channels,
      }));
  return [
    ...pick(values["alerts.recipients"], "b"),
    ...pick(values["alerts.agency_recipients"], "a"),
  ];
}

const SEVERITY: Readonly<Record<AlertKind, "info" | "warning" | "critical">> = {
  lead_qualified: "info",
  meeting_requested: "info",
  handoff: "warning",
  emergency: "critical",
  lead_disqualified: "info",
  send_failed: "warning",
};

/** Kinds `alerts.hold_overnight` may hold back; handoffs, emergencies and failures never. */
const HOLDABLE: ReadonlySet<AlertKind> = new Set(["lead_qualified", "lead_disqualified"]);

/**
 * When an alert planned now may go out: at once, or when `alerts.hold_overnight` ends (in the
 * business's time zone) for the kinds it covers.
 */
export function alertSendTime(
  values: AppSettings,
  kind: AlertKind,
  businessTimeZone: string,
  now: Date,
): Date {
  if (!HOLDABLE.has(kind)) return now;
  return windowEnd(now, businessTimeZone, values["alerts.hold_overnight"]) ?? now;
}

export function conversationLink(appUrl: string, conversationId: string): string {
  return publicUrl(appUrl, HANDOFF_ROUTES.conversation(conversationId));
}

/**
 * Writes the alert rows of one event (one per recipient and channel) and returns the ids of
 * the rows still to send. `dedupeBase` makes the event's alerts unique: the three events of
 * one lead decision ("qualified", "wants a meeting", "we'll contact you") share
 * `decision:<lead id>`, so a recipient gets one alert for it; everything else is per event.
 * Rows a run created earlier and never sent are returned again.
 */
export async function planLeadAlerts(
  ctx: BusinessContext,
  input: {
    readonly kind: AlertKind;
    readonly dedupeBase: string;
    readonly conversationId: ConversationId;
    readonly leadId: LeadId | null;
    readonly values: AppSettings;
    readonly facts: ConversationFacts;
    readonly appUrl: string;
    readonly errorCode?: string | null;
    readonly eventId: string;
    /**
     * Words put in front of the alert's text and subject, written by code (an emergency
     * nobody acknowledged).
     */
    readonly notice?: string;
  },
): Promise<{ readonly id: string; readonly channel: AlertChannel }[]> {
  const recipients = recipientsFor(input.values, input.kind);
  if (recipients.length === 0) return [];
  const plain = renderLeadAlert({
    kind: input.kind,
    facts: input.facts,
    values: input.values,
    link: conversationLink(input.appUrl, input.conversationId),
    errorCode: input.errorCode ?? null,
  });
  const notice = input.notice;
  const rendered =
    notice === undefined
      ? plain
      : {
          sms: `${notice} ${plain.sms}`,
          whatsapp: `${notice} ${plain.whatsapp}`,
          email: {
            subject: `${notice} ${plain.email.subject}`,
            text: `${notice}\n\n${plain.email.text}`,
          },
        };
  const keys: string[] = [];
  for (const recipient of recipients) {
    for (const channel of recipient.channels) {
      const to = channel === "email" ? recipient.email : recipient.phone;
      if (to.trim().length === 0) continue;
      const dedupeKey = `${input.dedupeBase}:${recipient.key}:${channel}`;
      keys.push(dedupeKey);
      await ctx.tx
        .insert(alerts)
        .values({
          ...ctx.tenant,
          conversationId: input.conversationId,
          leadId: input.leadId,
          kind: input.kind,
          severity: SEVERITY[input.kind],
          channel,
          recipient: to.trim(),
          subject: channel === "email" ? rendered.email.subject : null,
          body:
            channel === "email"
              ? rendered.email.text
              : channel === "sms"
                ? rendered.sms
                : rendered.whatsapp,
          payload: {
            recipientName: recipient.name,
            recipientKey: recipient.key,
            eventId: input.eventId,
          },
          dedupeKey,
        })
        .onConflictDoNothing();
    }
  }
  if (keys.length === 0) return [];
  const rows = await ctx.tx
    .select({ id: alerts.id, channel: alerts.channel, dedupeKey: alerts.dedupeKey })
    .from(alerts)
    .where(and(inArray(alerts.dedupeKey, keys), eq(alerts.status, "pending")));
  // In the order of the recipients and their channels.
  const order = new Map(keys.map((key, index) => [key, index]));
  return rows
    .sort((a, b) => (order.get(a.dedupeKey ?? "") ?? 0) - (order.get(b.dedupeKey ?? "") ?? 0))
    .map((row) => ({ id: row.id, channel: row.channel as AlertChannel }));
}
