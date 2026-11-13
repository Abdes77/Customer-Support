import {
  type ConversationId,
  type ExecutedAction,
  type LeadFieldValue,
  type Logger,
  SYSTEM_LEAD_FIELDS,
  type TraceId,
} from "@repo/core";
import type { BusinessContext, BusinessTenant, Database } from "@repo/db";
import type { AnyJobEvent } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import { MAX_EVIDENCE_CHARACTERS } from "./assess/merge";
import { plain } from "./assess/text";
import { assessAndSave, lockLead, recordLeadEvent, writeLeadFields } from "./store/lead-store";
import {
  leadEventRowIds,
  markLeadEventsEmitted,
  pendingLeadEvents,
  toJobEvents,
} from "./store/outbox";

/**
 * What lead scoring does when a reply turn commits (the pipeline's `TurnObserver` extension
 * point, ARCHITECTURE §2 step 14):
 *
 * - every conversation that had a turn has a lead with a score and a report, even when the
 *   model never saved a field ("every lead always gets a score and a written report");
 * - the turn's actions owned by other chunks become lead facts and events: an escalated
 *   emergency (`lead.emergency`, and the emergency counts in the score), a handoff to a
 *   person (`lead.handoff`, status `handed_off`); a refusal handed to a person by rule too;
 * - the lead's unsent events are returned, so they go out with the turn's own events, and
 *   are marked sent once the emit step has sent them.
 */

/** The committed turn, as the pipeline describes it. */
export interface CommittedTurnFacts {
  readonly conversationId: ConversationId;
  readonly turnId: string;
  readonly traceId: string;
  /** The turn's status: replied, no_reply, refused, failed, superseded. */
  readonly status: string;
  readonly actions: readonly ExecutedAction[];
  readonly now: Date;
}

export interface LeadTurnObserver {
  readonly name: string;
  committed(ctx: BusinessContext, turn: CommittedTurnFacts): Promise<readonly AnyJobEvent[]>;
  emitted(tenant: BusinessTenant, events: readonly AnyJobEvent[], now: Date): Promise<void>;
}

const done = (executed: ExecutedAction) =>
  executed.outcome.status === "applied" || executed.outcome.status === "deferred";

const CUSTOMER_ASKED =
  /\b(asks?|asked|wants?|wanted|requests?|requested|prefers?|insists?)\b.{0,40}\b(person|human|someone|somebody|agent|manager|owner|people|real|call)\b/i;

/** Who wanted the handoff, from the model's stated reason. A heuristic: it only labels the event. */
export function handoffTrigger(reason: string): "customer_request" | "bot_decision" {
  return CUSTOMER_ASKED.test(reason) ? "customer_request" : "bot_decision";
}

export function createLeadTurnObserver(deps: {
  readonly db: Database;
  readonly logger: Logger;
}): LeadTurnObserver {
  const { db, logger } = deps;
  return {
    name: "leads",

    async committed(ctx, turn) {
      const record = await lockLead(ctx, turn.conversationId);
      if (record === null) return [];
      const context = { traceId: turn.traceId as TraceId, now: turn.now };
      const settings = await loadSettings(ctx, ctx.tenant, { logger });
      const now = turn.now.toISOString();

      // Facts from the actions of other owners.
      const emergencies: string[] = [];
      let handoff: {
        trigger: "customer_request" | "bot_decision" | "rule";
        urgency: "normal" | "high";
      } | null = null;
      for (const executed of turn.actions) {
        if (!done(executed)) continue;
        const action = executed.action;
        if (action.type === "escalate_emergency") emergencies.push(action.emergencyClass);
        if (action.type === "handoff_to_human") {
          handoff = { trigger: handoffTrigger(action.reason), urgency: action.urgency };
        }
      }
      if (turn.status === "refused" && handoff === null)
        handoff = { trigger: "rule", urgency: "normal" };

      const written: LeadFieldValue[] = [];
      const lastEmergency = emergencies.at(-1);
      if (
        lastEmergency !== undefined &&
        record.fields[SYSTEM_LEAD_FIELDS.emergency]?.value !== lastEmergency
      ) {
        const field: LeadFieldValue = {
          key: SYSTEM_LEAD_FIELDS.emergency,
          value: lastEmergency,
          confidence: 1,
          evidence:
            plain(
              turn.actions
                .map((executed) => executed.action)
                .flatMap((action) => (action.type === "escalate_emergency" ? [action.summary] : []))
                .at(-1) ?? "",
              MAX_EVIDENCE_CHARACTERS,
            ) || null,
          updatedAt: now,
        };
        written.push(field);
        record.fields[field.key] = field;
      }
      await writeLeadFields(ctx, record.id, written);
      if (handoff !== null && record.status !== "meeting_booked") record.status = "handed_off";

      const saved = await assessAndSave(ctx, record, settings, context);
      const scoring = { score: saved.assessment.score, band: saved.assessment.band };
      for (const emergencyClass of new Set(emergencies)) {
        await recordLeadEvent(
          ctx,
          record,
          scoring,
          {
            name: "lead.emergency",
            dedupeKey: `emergency:${emergencyClass}:${turn.turnId}`,
            data: { emergencyClass },
          },
          context,
        );
      }
      if (handoff !== null) {
        await recordLeadEvent(
          ctx,
          record,
          scoring,
          {
            name: "lead.handoff",
            dedupeKey: `handoff:${turn.turnId}`,
            data: {
              routing: saved.routing?.outcome ?? "contact_later",
              trigger: handoff.trigger,
              urgency: emergencies.length > 0 ? "high" : handoff.urgency,
            },
          },
          context,
        );
      }

      const pending = await pendingLeadEvents(ctx, { leadId: record.id });
      return toJobEvents(pending, (row) =>
        logger.error("lead.invalid_event", {
          traceId: turn.traceId,
          businessId: ctx.tenant.businessId,
          eventRowId: row.id,
          name: row.name,
        }),
      );
    },

    async emitted(tenant, events, now) {
      const ids = leadEventRowIds(events);
      if (ids.length === 0) return;
      try {
        await db
          .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
          .run((ctx) => markLeadEventsEmitted(ctx, ids, now));
      } catch (error) {
        // The cron sends them again; the event ids make that harmless.
        logger.warn("lead.events_mark_failed", { businessId: tenant.businessId, error });
      }
    },
  };
}
