import type { DryRunState } from "@repo/ai";
import {
  type ActionOutcome,
  type EngineAction,
  type LeadSnapshot,
  type RoutingDecision,
  SYSTEM_LEAD_FIELDS,
  type ToolExecutionContext,
  type ToolRuntime,
} from "@repo/core";
import type { AppResolvedSettings } from "@repo/settings";

import { assessLead } from "./assess/assess";
import { mergeFields, MAX_EVIDENCE_CHARACTERS } from "./assess/merge";
import { listOf, plain } from "./assess/text";

/**
 * Lead scoring for dry runs (the evaluation harness, C7, and scripted conversations): the
 * same assessment as production, kept in the dry run's memory.
 *
 *   createDryRunConversation({ ..., routing: leadRouting })               // decision only
 *   createDryRunConversation({ ..., tools: (state) =>
 *     withLeadScoring(state, settings, createMemoryToolRuntime({ state, settings })) })
 */

/** `MemoryToolRuntimeOptions.routing` with the real rules. */
export function leadRouting(
  lead: LeadSnapshot,
  settings: AppResolvedSettings,
  now: string,
): RoutingDecision | null {
  return assessLead({ settings, facts: { fields: lead.fields, status: lead.status }, now })
    .decision;
}

/**
 * Wraps a dry-run `ToolRuntime`: `update_lead_fields` and `mark_not_a_fit` are merged and
 * scored like the live handlers do, an escalated emergency is recorded on the lead, and
 * everything else goes to `inner`.
 */
export function withLeadScoring(
  state: DryRunState,
  settings: AppResolvedSettings,
  inner: ToolRuntime,
): ToolRuntime {
  const minimum = settings.values["scoring.minimum_confidence"];

  function apply(
    incoming: Parameters<typeof mergeFields>[1],
    context: ToolExecutionContext,
  ): { outcome: ActionOutcome; changed: readonly string[] } {
    const merged = mergeFields(state.lead.fields, incoming, context.now, minimum);
    const assessment = assessLead({
      settings,
      facts: { fields: merged.fields, status: state.lead.status },
      now: context.now,
    });
    const routing = assessment.decision ?? state.lead.routing;
    state.lead = { ...state.lead, fields: merged.fields, status: assessment.status, routing };
    const pending =
      assessment.decision === null && assessment.pending.length > 0
        ? ` Still needed before a routing decision: ${listOf(assessment.pending.map((entry) => entry.key))}.`
        : "";
    return {
      outcome: {
        status: "applied",
        message: `Saved: ${merged.changed.join(", ") || "nothing new"}.${pending}`,
        data: null,
        ...(routing === null ? {} : { routing }),
      },
      changed: merged.changed,
    };
  }

  return {
    async execute(action: EngineAction, context) {
      let outcome: ActionOutcome;
      switch (action.type) {
        case "update_lead_fields":
          outcome = apply(action.fields, context).outcome;
          break;
        case "mark_not_a_fit":
          outcome = apply(
            [
              {
                key: SYSTEM_LEAD_FIELDS.notAFit,
                value: action.category ?? "other",
                confidence: 1,
                evidence: plain(action.reason, MAX_EVIDENCE_CHARACTERS),
              },
            ],
            context,
          ).outcome;
          break;
        case "escalate_emergency": {
          const result = await inner.execute(action, context);
          if (result.status === "applied" || result.status === "deferred") {
            apply(
              [
                {
                  key: SYSTEM_LEAD_FIELDS.emergency,
                  value: action.emergencyClass,
                  confidence: 1,
                  evidence: null,
                },
              ],
              context,
            );
          }
          return result;
        }
        default:
          return inner.execute(action, context);
      }
      state.actions.push({ toolCallId: context.toolCallId, action, outcome });
      return outcome;
    },
  };
}
