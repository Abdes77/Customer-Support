import { z } from "zod";

import type { ConversationId, LeadId, TraceId, UserId } from "@repo/core";
import {
  alerts,
  and,
  type BusinessContext,
  type BusinessTenant,
  desc,
  eq,
  escalations,
  type EscalationAckChannel,
  leads,
  recordSystemAudit,
  sql,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import { type AppSettings, renderTemplate } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { type AlertChannel, deliverAlert } from "../alerts/deliver";
import { conversationLink } from "../alerts/plan";
import { alertVariables } from "../alerts/render";
import { clockOf, type HandoffDeps } from "../deps";
import { loadConversationFacts } from "../facts";
import { oneLine, plainLine } from "../text";
import {
  type ChainContact,
  type ChainPolicy,
  chainFromSettings,
  planSteps,
  policyFromSettings,
} from "./policy";

/*
 * Emergency escalations (C13): one row per chain, at most one active per conversation
 * (a partial unique index). Started by the `escalate_emergency` action, or by `lead.emergency`
 * when the action could not. Acknowledged once, by whoever is first, through any path.
 */

/** An acknowledged emergency of the same class in this conversation stops a new chain. */
const REACKNOWLEDGE_HOURS = 6;

const ChainSnapshot = z.array(
  z.object({
    name: z.string(),
    phone: z.string(),
    email: z.string(),
    alertBy: z.array(z.enum(["sms", "whatsapp", "email"])),
    source: z.enum(["business", "agency"]),
  }),
);
const PolicySnapshot = z
  .object({
    ackMinutes: z.number().int().min(1),
    call: z.boolean(),
    rounds: z.number().int().min(1),
    callWaitMinutes: z.number().int().min(0),
    emergencyLabel: z.string().optional(),
    /** When each step's wait ends (ISO, the service's clock), keyed by step index. */
    deadlines: z.record(z.string(), z.string()).optional(),
  })
  .loose();

export function escalationStartedEvent(
  tenant: BusinessTenant,
  escalationId: string,
  traceId: string,
  suffix = "",
): AnyJobEvent {
  return jobEvent("handoff.escalation_started", `escalation-${escalationId}${suffix}`, {
    traceId: traceId as TraceId,
    agencyId: tenant.agencyId,
    businessId: tenant.businessId,
    escalationId,
  });
}

export function emergencyLabel(values: AppSettings, key: string): string {
  return values["emergency.classes"].find((item) => item.key === key)?.label ?? key;
}

export interface StartResult {
  readonly escalationId: string;
  /** True when this call created the chain (and it has someone to alert). */
  readonly started: boolean;
  readonly status: string;
  /** People the chain can alert (business chain plus agency fallback). */
  readonly contacts: number;
}

/**
 * Records an emergency for a conversation and returns its escalation. An active chain of the
 * conversation is reused (whatever its class: the people alerted handle the conversation);
 * an acknowledged one of the same class within six hours is not started again. A business
 * whose chain and agency fallback are both empty gets the escalation recorded as exhausted
 * and a critical in-app alert: nobody can be alerted automatically. Null when emergency
 * handling is off.
 */
export async function startEscalation(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly emergencyClass: string;
    readonly summary: string | null;
    readonly traceId: string;
    readonly values: AppSettings;
    readonly now: Date;
  },
): Promise<StartResult | null> {
  const { values, now } = input;
  if (!values["emergency.enabled"]) return null;
  const existing = await findReusable(ctx, input, now);
  if (existing !== null) return existing;

  const chain = chainFromSettings(values);
  const policy = {
    ...policyFromSettings(values),
    emergencyLabel: emergencyLabel(values, input.emergencyClass),
  };
  const [lead] = await ctx.tx
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.conversationId, input.conversationId))
    .limit(1);
  const nobody = chain.length === 0;
  const [row] = await ctx.tx
    .insert(escalations)
    .values({
      ...ctx.tenant,
      conversationId: input.conversationId,
      leadId: lead?.id ?? null,
      emergencyClass: input.emergencyClass,
      summary: input.summary === null ? null : plainLine(input.summary, 300),
      status: nobody ? "exhausted" : "active",
      chain: chain as unknown[],
      policy,
      traceId: input.traceId as TraceId,
      nextActionAt: nobody ? null : now,
      startedAt: now,
      endedAt: nobody ? now : null,
    })
    .onConflictDoNothing()
    .returning({ id: escalations.id });
  if (row === undefined) {
    // Another turn or event created the conversation's chain a moment ago.
    const raced = await findReusable(ctx, input, now);
    if (raced !== null) return raced;
    throw new Error("The escalation could not be recorded.");
  }
  if (nobody) {
    await ctx.tx
      .insert(alerts)
      .values({
        ...ctx.tenant,
        conversationId: input.conversationId,
        leadId: lead?.id ?? null,
        escalationId: row.id,
        kind: "emergency_unassigned",
        severity: "critical",
        channel: "in_app",
        recipient: "agency",
        subject: `Emergency (${policy.emergencyLabel}) and nobody to alert: add escalation contacts.`,
        payload: { escalationId: row.id },
        dedupeKey: `emergency_unassigned:${row.id}`,
      })
      .onConflictDoNothing();
  }
  await recordSystemAudit(
    ctx,
    { type: "system", label: "handoff" },
    {
      action: "emergency.escalate",
      targetType: "escalation",
      targetId: row.id,
      summary: `Emergency escalation started (${input.emergencyClass}).`,
      metadata: { conversationId: input.conversationId, contacts: chain.length },
      traceId: input.traceId as TraceId,
    },
  );
  return {
    escalationId: row.id,
    started: !nobody,
    status: nobody ? "exhausted" : "active",
    contacts: chain.length,
  };
}

async function findReusable(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly emergencyClass: string;
    readonly traceId: string;
  },
  now: Date,
): Promise<StartResult | null> {
  const { conversationId, emergencyClass } = input;
  const rows = await ctx.tx
    .select({
      id: escalations.id,
      status: escalations.status,
      emergencyClass: escalations.emergencyClass,
      acknowledgedAt: escalations.acknowledgedAt,
      chain: escalations.chain,
      traceId: escalations.traceId,
    })
    .from(escalations)
    .where(eq(escalations.conversationId, conversationId))
    .orderBy(desc(escalations.startedAt))
    .limit(5);
  // The same turn already recorded it (the action, then `lead.emergency` for the same turn):
  // whatever became of it, it is the same emergency. Without this a chain that ended at once
  // (nobody to alert) was recorded, and flagged, twice.
  const sameTurn = rows.find((row) => row.traceId === input.traceId);
  if (sameTurn !== undefined) {
    return {
      escalationId: sameTurn.id,
      started: false,
      status: sameTurn.status,
      contacts: sameTurn.chain.length,
    };
  }
  const active = rows.find((row) => row.status === "active");
  if (active !== undefined) {
    return {
      escalationId: active.id,
      started: false,
      status: "active",
      contacts: active.chain.length,
    };
  }
  const recent = rows.find(
    (row) =>
      row.status === "acknowledged" &&
      row.emergencyClass === emergencyClass &&
      row.acknowledgedAt !== null &&
      now.getTime() - row.acknowledgedAt.getTime() < REACKNOWLEDGE_HOURS * 3_600_000,
  );
  if (recent !== undefined) {
    return {
      escalationId: recent.id,
      started: false,
      status: "acknowledged",
      contacts: recent.chain.length,
    };
  }
  return null;
}

export interface LoadedEscalation {
  readonly id: string;
  readonly status: string;
  readonly conversationId: ConversationId | null;
  readonly leadId: LeadId | null;
  readonly emergencyClass: string;
  readonly summary: string | null;
  readonly chain: ChainContact[];
  readonly policy: ChainPolicy & {
    readonly emergencyLabel?: string;
    readonly deadlines?: Record<string, string>;
  };
}

export async function loadEscalation(
  ctx: BusinessContext,
  escalationId: string,
  lock: "update" | "none" = "none",
): Promise<LoadedEscalation | null> {
  const query = ctx.tx
    .select({
      id: escalations.id,
      status: escalations.status,
      conversationId: escalations.conversationId,
      leadId: escalations.leadId,
      emergencyClass: escalations.emergencyClass,
      summary: escalations.summary,
      chain: escalations.chain,
      policy: escalations.policy,
    })
    .from(escalations)
    .where(eq(escalations.id, escalationId))
    .limit(1);
  const [row] = lock === "update" ? await query.for("update") : await query;
  if (row === undefined) return null;
  const chain = ChainSnapshot.safeParse(row.chain);
  const policy = PolicySnapshot.safeParse(row.policy);
  if (!chain.success || !policy.success) {
    throw new Error("The escalation's stored chain cannot be read.");
  }
  return { ...row, chain: chain.data, policy: policy.data };
}

export type AckResult =
  | { readonly kind: "acknowledged"; readonly by: string; readonly via: EscalationAckChannel }
  | {
      readonly kind: "already";
      readonly by: string | null;
      readonly via: string | null;
      readonly at: string | null;
    }
  | { readonly kind: "ended"; readonly status: string }
  | { readonly kind: "not_found" };

/**
 * Acknowledges an active escalation: one conditional update, so exactly one acknowledgement
 * wins and stops the chain (its next step finds the chain no longer active; a step sending at
 * this moment holds the row and is waited for). Records who, how and when on the escalation,
 * the alert that was answered and the audit log, and raises an in-app note.
 */
export async function acknowledgeEscalation(
  ctx: BusinessContext,
  input: {
    readonly escalationId: string;
    readonly via: EscalationAckChannel;
    /** Who: the contact's name (and masked number), or the signed-in person's label. */
    readonly by: string;
    readonly userId: UserId | null;
    /** The alert whose link, code or call was answered. */
    readonly alertId: string | null;
    readonly now: Date;
  },
): Promise<AckResult> {
  const by = oneLine(input.by, 120) || "someone";
  const [row] = await ctx.tx
    .update(escalations)
    .set({
      status: "acknowledged",
      acknowledgedAt: input.now,
      acknowledgedBy: by,
      acknowledgedVia: input.via,
      acknowledgedUserId: input.userId,
      endedAt: input.now,
      nextActionAt: null,
    })
    .where(and(eq(escalations.id, input.escalationId), eq(escalations.status, "active")))
    .returning({
      id: escalations.id,
      conversationId: escalations.conversationId,
      leadId: escalations.leadId,
      emergencyClass: escalations.emergencyClass,
    });
  if (row === undefined) {
    const [current] = await ctx.tx
      .select({
        status: escalations.status,
        by: escalations.acknowledgedBy,
        via: escalations.acknowledgedVia,
        at: escalations.acknowledgedAt,
      })
      .from(escalations)
      .where(eq(escalations.id, input.escalationId))
      .limit(1);
    if (current === undefined) return { kind: "not_found" };
    if (current.status === "acknowledged") {
      return {
        kind: "already",
        by: current.by,
        via: current.via,
        at: current.at?.toISOString() ?? null,
      };
    }
    return { kind: "ended", status: current.status };
  }
  if (input.alertId !== null) {
    await ctx.tx
      .update(alerts)
      .set({ status: "acknowledged", acknowledgedAt: input.now, acknowledgedBy: by })
      .where(and(eq(alerts.id, input.alertId), eq(alerts.escalationId, row.id)));
  }
  // Alerts of the chain that were still waiting to go out never will.
  await ctx.tx
    .update(alerts)
    .set({ status: "suppressed", error: "acknowledged" })
    .where(and(eq(alerts.escalationId, row.id), eq(alerts.status, "pending")));
  await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: row.conversationId,
      leadId: row.leadId,
      escalationId: row.id,
      kind: "emergency_acknowledged",
      severity: "info",
      channel: "in_app",
      recipient: "agency",
      subject: `Emergency acknowledged by ${by} (${input.via}).`,
      status: "sent",
      sentAt: input.now,
      payload: { escalationId: row.id, via: input.via },
      dedupeKey: `emergency_acknowledged:${row.id}`,
    })
    .onConflictDoNothing();
  await recordSystemAudit(
    ctx,
    input.userId === null
      ? { type: "system", label: `handoff:${input.via}` }
      : { type: "user", userId: input.userId, label: by },
    {
      action: "emergency.acknowledge",
      targetType: "escalation",
      targetId: row.id,
      summary: `Emergency acknowledged by ${by} via ${input.via}.`,
      metadata: { via: input.via, alertId: input.alertId },
    },
  );
  return { kind: "acknowledged", by, via: input.via };
}

/** The text of an emergency alert to one person (the acknowledgement part is added at send). */
export function emergencyAlertText(input: {
  readonly values: AppSettings;
  readonly variables: ReturnType<typeof alertVariables>;
  readonly label: string;
  readonly summary: string | null;
}): { readonly sms: string; readonly subject: string; readonly email: string } {
  const vars = {
    ...input.variables,
    emergency: plainLine(input.label, 60),
    summary: plainLine(input.summary, 200) || input.variables.summary,
  };
  const sms = renderTemplate(input.values["emergency.alert_template"], vars)
    .replace(/\s+/g, " ")
    .trim();
  return {
    sms,
    subject: `EMERGENCY for ${vars.business_name}: ${vars.emergency}`,
    email: [
      sms,
      "",
      `Customer: ${vars.contact_name}${vars.contact_phone ? `, ${vars.contact_phone}` : ""}`,
      `Open the conversation (sign-in required): ${vars.link}`,
    ].join("\n"),
  };
}

export interface StepResult {
  /** False once the chain is no longer active (acknowledged, cancelled, exhausted). */
  readonly active: boolean;
  /** When the step's wait ends (the service's clock); the job sleeps until then. */
  readonly waitUntil: string | null;
  readonly sent: number;
  readonly failed: number;
}

/**
 * One step of the chain: alert a person by their channels, or call them. Writes the step's
 * alert rows (one per channel, unique per step), sends each while holding the chain's row
 * (so nothing goes out after an acknowledgement commits), and works out the wait: the step's
 * full wait when something went out, none when nothing could be sent (the chain moves on at
 * once). Repeating a step (a retried or resumed run) sends nothing twice and keeps the
 * deadline it had.
 */
export async function runChainStep(
  deps: Pick<HandoffDeps, "db" | "logger" | "clock" | "appUrl" | "transports">,
  tenant: BusinessTenant,
  escalationId: string,
  stepIndex: number,
): Promise<StepResult> {
  const clock = clockOf(deps);
  const scope = deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });
  const prepared = await scope.run(async (ctx) => {
    const escalation = await loadEscalation(ctx, escalationId, "update");
    if (escalation?.status !== "active") return null;
    const step = planSteps(escalation.chain, escalation.policy)[stepIndex];
    const contact = step === undefined ? undefined : escalation.chain[step.contact];
    if (step === undefined || contact === undefined) return null;
    const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
    const facts =
      escalation.conversationId === null
        ? null
        : await loadConversationFacts(ctx, escalation.conversationId);
    const label = escalation.policy.emergencyLabel ?? escalation.emergencyClass;
    const link =
      escalation.conversationId === null
        ? deps.appUrl
        : conversationLink(deps.appUrl, escalation.conversationId);
    const text =
      facts === null
        ? null
        : emergencyAlertText({
            values: settings.values,
            variables: alertVariables({
              facts,
              values: settings.values,
              link,
              forceContactDetails: true,
            }),
            label,
            summary: escalation.summary,
          });
    const channels: AlertChannel[] = step.kind === "call" ? ["voice"] : [...contact.alertBy];
    for (const channel of channels) {
      const to = (channel === "email" ? contact.email : contact.phone).trim();
      // A contact without an address for this channel (a stored value older than the
      // settings' checks) is recorded as a failed alert, so the step is visibly skipped.
      const unreachable = to.length === 0;
      await ctx.tx
        .insert(alerts)
        .values({
          ...ctx.tenant,
          conversationId: escalation.conversationId,
          leadId: escalation.leadId,
          escalationId: escalation.id,
          kind: "emergency",
          severity: "critical",
          channel,
          recipient: unreachable ? "(none)" : to,
          ...(unreachable
            ? {
                status: "failed" as const,
                error: `no_address: ${contact.name} has no ${channel === "email" ? "email address" : "phone number"}.`,
              }
            : {}),
          subject: channel === "email" ? (text?.subject ?? `EMERGENCY: ${label}`) : null,
          body:
            channel === "email"
              ? (text?.email ?? `EMERGENCY: ${label}`)
              : channel === "voice"
                ? null
                : (text?.sms ?? `EMERGENCY: ${label}`),
          payload: {
            step: stepIndex,
            round: step.round,
            contact: step.contact,
            contactName: contact.name,
            source: contact.source,
          },
          dedupeKey: `esc:${escalation.id}:${stepIndex}:${channel}`,
        })
        .onConflictDoNothing();
    }
    await ctx.tx
      .update(escalations)
      .set({ currentStep: sql`greatest(${escalations.currentStep}, ${stepIndex})` })
      .where(eq(escalations.id, escalation.id));
    const pending = await ctx.tx
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.escalationId, escalation.id),
          eq(alerts.status, "pending"),
          sql`(${alerts.payload} ->> 'step')::int = ${stepIndex}`,
        ),
      );
    return {
      pending: pending.map((row) => row.id),
      label,
      businessName: facts?.business.name ?? "your business",
      waitMinutes: step.waitMinutes,
    };
  });
  if (prepared === null) return { active: false, waitUntil: null, sent: 0, failed: 0 };

  for (const alertId of prepared.pending) {
    try {
      await deliverAlert(deps, tenant, alertId, {
        ackable: { businessName: prepared.businessName, emergencyLabel: prepared.label },
        maxAttempts: 1,
        isActive: async (ctx) => {
          const [row] = await ctx.tx
            .select({ status: escalations.status })
            .from(escalations)
            .where(eq(escalations.id, escalationId))
            .for("share")
            .limit(1);
          return row?.status === "active";
        },
      });
    } catch (error) {
      // Whatever went wrong with this one alert, the chain must not stall on it: a step that
      // threw every time would be retried, resumed by the sweeper and never reach the next
      // person. The alert is recorded as failed and the step goes on.
      deps.logger.error("emergency.alert_failed", {
        businessId: tenant.businessId,
        escalationId,
        alertId,
        error: error instanceof Error ? { name: error.name } : { name: "Error" },
      });
      await scope.run(async (ctx) => {
        await ctx.tx
          .update(alerts)
          .set({ status: "failed", error: "delivery_error: the alert could not be sent." })
          .where(and(eq(alerts.id, alertId), eq(alerts.status, "pending")));
      });
    }
  }

  return scope.run(async (ctx) => {
    const escalation = await loadEscalation(ctx, escalationId, "update");
    if (escalation?.status !== "active") {
      return { active: false, waitUntil: null, sent: 0, failed: 0 };
    }
    const rows = await ctx.tx
      .select({ status: alerts.status })
      .from(alerts)
      .where(
        and(
          eq(alerts.escalationId, escalationId),
          sql`(${alerts.payload} ->> 'step')::int = ${stepIndex}`,
        ),
      );
    const sent = rows.filter((row) => row.status === "sent" || row.status === "delivered").length;
    const failed = rows.length - sent;
    const key = String(stepIndex);
    const stored = escalation.policy.deadlines?.[key];
    const now = clock();
    const deadline =
      stored ??
      new Date(now.getTime() + (sent > 0 ? prepared.waitMinutes * 60_000 : 0)).toISOString();
    if (stored === undefined) {
      const deadlines = { ...escalation.policy.deadlines, [key]: deadline };
      await ctx.tx
        .update(escalations)
        .set({
          policy: { ...escalation.policy, deadlines },
          nextActionAt: new Date(deadline),
        })
        .where(eq(escalations.id, escalationId));
    }
    return { active: true, waitUntil: deadline, sent, failed };
  });
}

/** Every step went by without an acknowledgement: the chain is exhausted. */
export async function finishChain(
  deps: Pick<HandoffDeps, "db" | "clock">,
  tenant: BusinessTenant,
  escalationId: string,
): Promise<boolean> {
  const now = clockOf(deps)();
  return deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
    const [row] = await ctx.tx
      .update(escalations)
      .set({ status: "exhausted", endedAt: now, nextActionAt: null })
      .where(and(eq(escalations.id, escalationId), eq(escalations.status, "active")))
      .returning({
        id: escalations.id,
        conversationId: escalations.conversationId,
        leadId: escalations.leadId,
        emergencyClass: escalations.emergencyClass,
      });
    if (row === undefined) return false;
    await ctx.tx
      .insert(alerts)
      .values({
        ...ctx.tenant,
        conversationId: row.conversationId,
        leadId: row.leadId,
        escalationId: row.id,
        kind: "emergency_unacknowledged",
        severity: "critical",
        channel: "in_app",
        recipient: "agency",
        subject: "Nobody acknowledged an emergency: call the customer now.",
        payload: { escalationId: row.id, emergencyClass: row.emergencyClass },
        dedupeKey: `emergency_unacknowledged:${row.id}`,
      })
      .onConflictDoNothing();
    await recordSystemAudit(
      ctx,
      { type: "system", label: "handoff" },
      {
        action: "emergency.exhausted",
        targetType: "escalation",
        targetId: row.id,
        summary: "Nobody acknowledged the emergency; the chain ended.",
      },
    );
    return true;
  });
}
