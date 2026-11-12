import {
  type ActionHandler,
  type ActionOutcome,
  type LeadFieldValue,
  type Logger,
  type RoutingDecision,
  SYSTEM_LEAD_FIELDS,
  type ToolExecutionContext,
} from "@repo/core";
import type { Database } from "@repo/db";
import type { AppResolvedSettings } from "@repo/settings";

import { assessLead, type LeadAssessment } from "./assess/assess";
import { type IncomingField, mergeFields, MAX_EVIDENCE_CHARACTERS } from "./assess/merge";
import { listOf, plain } from "./assess/text";
import { assessAndSave, lockLead, writeLeadFields } from "./store/lead-store";

/**
 * The action handlers lead scoring owns (BUILD_PLAN, "Who registers what"):
 * `update_lead_fields` and `mark_not_a_fit`. Each one stores what the model reported, scores
 * the lead again under the turn's own settings snapshot and returns the routing decision, so
 * the reply of the same turn follows it (DECISIONS 9). The model never decides the outcome:
 * it reports facts, and the rules in `assessLead` decide.
 *
 * In dry-run mode (invariant I8) nothing is written: the stored lead, if any, is read, the
 * new fields are merged in memory and the decision is computed from that.
 */

export interface LeadHandlerDeps {
  readonly db: Database;
  readonly logger: Logger;
}

function settingsOf(context: ToolExecutionContext): AppResolvedSettings {
  // The engine checked the snapshot against the registry before it called any tool.
  return context.settings as unknown as AppResolvedSettings;
}

function scope(db: Database, context: ToolExecutionContext) {
  return db.forBusiness(context.trace.businessId, { agencyId: context.trace.agencyId });
}

function pendingText(assessment: LeadAssessment): string | null {
  if (assessment.decision !== null || assessment.pending.length === 0) return null;
  return `Still needed before a routing decision: ${listOf(
    assessment.pending.map((entry) => entry.key),
  )}.`;
}

function outcomeFor(
  assessment: LeadAssessment,
  routing: RoutingDecision | null,
  lines: readonly (string | null)[],
): ActionOutcome {
  const message = [...lines, pendingText(assessment)].filter((line) => line !== null).join(" ");
  return {
    status: "applied",
    message: message.length > 0 ? message : null,
    data: null,
    ...(routing === null ? {} : { routing }),
  };
}

interface Applied {
  readonly assessment: LeadAssessment;
  readonly routing: RoutingDecision | null;
  readonly changed: readonly string[];
  readonly kept: readonly string[];
}

/**
 * Merges `incoming` into the conversation's lead and scores it. Live: stored, with the
 * decision, report and events. Dry run: computed only.
 */
async function applyFields(
  deps: LeadHandlerDeps,
  context: ToolExecutionContext,
  incoming: readonly IncomingField[],
): Promise<Applied | null> {
  const settings = settingsOf(context);
  const minimum = settings.values["scoring.minimum_confidence"];
  const conversationId = context.trace.conversationId;

  if (context.mode === "dry_run" || conversationId === null) {
    const stored =
      conversationId === null
        ? null
        : await scope(deps.db, context).run((ctx) =>
            lockLead(ctx, conversationId, { create: false }),
          );
    const merged = mergeFields(stored?.fields ?? {}, incoming, context.now, minimum);
    const assessment = assessLead({
      settings,
      facts: { fields: merged.fields, status: stored?.status ?? "new" },
      now: context.now,
    });
    return {
      assessment,
      routing: assessment.decision ?? stored?.latestDecision?.decision ?? null,
      changed: merged.changed,
      kept: merged.kept,
    };
  }

  return scope(deps.db, context).run(async (ctx) => {
    const record = await lockLead(ctx, conversationId);
    if (record === null) return null;
    const merged = mergeFields(record.fields, incoming, context.now, minimum);
    const written = merged.changed
      .map((key) => merged.fields[key])
      .filter((field): field is LeadFieldValue => field !== undefined);
    await writeLeadFields(ctx, record.id, written);
    Object.assign(record.fields, merged.fields);
    const saved = await assessAndSave(ctx, record, settings, {
      traceId: context.trace.traceId,
      now: new Date(context.now),
    });
    return {
      assessment: saved.assessment,
      routing: saved.routing,
      changed: merged.changed,
      kept: merged.kept,
    };
  });
}

/** `update_lead_fields`: store the fields, score, route, and hand the decision back. */
export function updateLeadFieldsHandler(
  deps: LeadHandlerDeps,
): ActionHandler<"update_lead_fields"> {
  return {
    type: "update_lead_fields",
    async handle(action, context) {
      const applied = await applyFields(deps, context, action.fields);
      if (applied === null) {
        return { status: "rejected", message: "There is no conversation to save to.", data: null };
      }
      deps.logger.info("lead.fields_saved", {
        traceId: context.trace.traceId,
        businessId: context.trace.businessId,
        conversationId: context.trace.conversationId,
        changed: applied.changed.length,
        kept: applied.kept.length,
        outcome: applied.assessment.decision?.outcome ?? null,
        mode: context.mode,
      });
      return outcomeFor(applied.assessment, applied.routing, [
        applied.changed.length > 0
          ? `Saved: ${applied.changed.join(", ")}.`
          : "Nothing new to save.",
        applied.kept.length > 0
          ? `Kept the earlier, firmer answer for: ${applied.kept.join(", ")}.`
          : null,
      ]);
    },
  };
}

const NOT_A_FIT_GUIDANCE = {
  disqualify:
    "Recorded. Close the conversation politely, as the routing rules for disqualify describe.",
  contact_later:
    "Recorded. A person at the business will look at this contact: tell the customer the team will be in touch, as the routing rules for contact_later describe, and promise nothing else.",
  undecided:
    "Recorded. The business decides on these by its own rules: carry on with the conversation as usual.",
} as const;

/**
 * `mark_not_a_fit`: records the category as the system field `system.not_a_fit`. Whether the
 * contact is turned away is decided by the settings: the categories in
 * `scoring.auto_disqualify` are, a service not offered and a job outside the area follow
 * their fit rules, and anything else goes to a person.
 */
export function markNotAFitHandler(deps: LeadHandlerDeps): ActionHandler<"mark_not_a_fit"> {
  return {
    type: "mark_not_a_fit",
    async handle(action, context) {
      const category = action.category ?? "other";
      const applied = await applyFields(deps, context, [
        {
          key: SYSTEM_LEAD_FIELDS.notAFit,
          value: category,
          confidence: 1,
          evidence: plain(action.reason, MAX_EVIDENCE_CHARACTERS),
        },
      ]);
      if (applied === null) {
        return {
          status: "rejected",
          message: "There is no conversation to record this on.",
          data: null,
        };
      }
      deps.logger.info("lead.not_a_fit", {
        traceId: context.trace.traceId,
        businessId: context.trace.businessId,
        conversationId: context.trace.conversationId,
        category,
        outcome: applied.assessment.decision?.outcome ?? null,
        mode: context.mode,
      });
      const outcome = applied.assessment.decision?.outcome;
      const guidance =
        outcome === "disqualify"
          ? NOT_A_FIT_GUIDANCE.disqualify
          : outcome === "contact_later"
            ? NOT_A_FIT_GUIDANCE.contact_later
            : NOT_A_FIT_GUIDANCE.undecided;
      return outcomeFor(applied.assessment, applied.routing, [guidance]);
    },
  };
}

export function leadActionHandlers(
  deps: LeadHandlerDeps,
): [ActionHandler<"update_lead_fields">, ActionHandler<"mark_not_a_fit">] {
  return [updateLeadFieldsHandler(deps), markNotAFitHandler(deps)];
}
