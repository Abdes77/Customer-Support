import { z } from "zod";

import type {
  ActionOutcome,
  EngineAction,
  EnginePorts,
  EngineTurnInput,
  ExecutedAction,
} from "@repo/core";
import type { AppSettings } from "@repo/settings";

import { normalizeLeadValue } from "../lead-fields";
import type { ModelToolResultBlockParam, ModelToolUseBlock } from "../model/types";
import { describeRouting } from "../prompt/turn-context";
import { dataLine } from "../prompt/text";
import { findEngineTool } from "../tools/definitions";
import type { EmergencyClass, TurnSituation } from "./situation";

/**
 * Runs the tool calls of one model response. For each call, in order: parse the input (Zod),
 * check it against the settings and the conversation (the model is never the authority on
 * what is allowed), hand the action to the `ToolRuntime`, and turn the outcome into the tool
 * result the model reads next. Nothing here throws for a bad call: the model is told what
 * was wrong and can adapt.
 */

export interface ToolRunContext {
  readonly input: EngineTurnInput;
  readonly values: AppSettings;
  readonly situation: TurnSituation;
  readonly ports: EnginePorts;
}

export interface ToolRunResult {
  readonly results: ModelToolResultBlockParam[];
  readonly executed: ExecutedAction[];
  /** Emergency classes the model escalated in these calls, alerted or not. */
  readonly emergencies: EmergencyClass[];
}

type Check =
  | { readonly kind: "run"; readonly action: EngineAction; readonly notes: readonly string[] }
  /** Not handed to the runtime: the settings already say no. Recorded with the turn. */
  | { readonly kind: "refuse"; readonly action: EngineAction; readonly outcome: ActionOutcome }
  /** Not an action at all: the input was wrong. */
  | { readonly kind: "invalid"; readonly message: string };

function rejected(message: string): ActionOutcome {
  return { status: "rejected", message, data: null };
}

function knownAttachmentIds(input: EngineTurnInput): Set<string> {
  const ids = new Set<string>();
  for (const turn of [...input.history, ...input.pending]) {
    for (const attachment of turn.attachments) {
      if (attachment.kind === "image") ids.add(attachment.id);
    }
  }
  return ids;
}

function check(action: EngineAction, context: ToolRunContext): Check {
  const { input, values, situation } = context;
  switch (action.type) {
    case "update_lead_fields": {
      const byKey = new Map(situation.catalogue.map((field) => [field.key, field]));
      const fields: Extract<EngineAction, { type: "update_lead_fields" }>["fields"] = [];
      const problems: string[] = [];
      for (const field of action.fields) {
        const spec = byKey.get(field.key);
        if (spec === undefined) {
          problems.push(`${dataLine(field.key)}: not a lead field of this business`);
          continue;
        }
        const value = normalizeLeadValue(spec, field.value);
        if (!value.ok) {
          problems.push(`${spec.key}: ${value.problem}`);
          continue;
        }
        fields.push({ ...field, key: spec.key, value: value.value });
      }
      if (fields.length === 0) {
        return {
          kind: "invalid",
          message: `No field could be saved. ${problems.join("; ")}. Use the keys and value forms listed under "Lead fields".`,
        };
      }
      return {
        kind: "run",
        action: { type: "update_lead_fields", fields },
        notes:
          problems.length === 0
            ? []
            : [`Not saved: ${problems.join("; ")}. Save these again with a valid key and value.`],
      };
    }
    case "escalate_emergency": {
      const classes = values["emergency.classes"].filter((item) => item.enabled);
      const match = classes.find((item) => item.key === action.emergencyClass.trim().toLowerCase());
      if (match === undefined) {
        return {
          kind: "invalid",
          message: `"${dataLine(action.emergencyClass)}" is not an emergency class of this business. The classes are: ${classes.map((item) => item.key).join(", ")}.`,
        };
      }
      const normalized: EngineAction = { ...action, emergencyClass: match.key };
      if (!values["emergency.enabled"]) {
        return {
          kind: "refuse",
          action: normalized,
          outcome: rejected(
            "Emergency alerts are switched off for this business, so nobody was alerted. Do not say that someone has been alerted.",
          ),
        };
      }
      return { kind: "run", action: normalized, notes: [] };
    }
    case "analyze_photos": {
      if (!values["photos.analysis_enabled"]) {
        return {
          kind: "refuse",
          action,
          outcome: rejected(
            "Photo analysis is switched off for this business. The photos are stored for the team: thank the customer and carry on.",
          ),
        };
      }
      const known = knownAttachmentIds(input);
      const unknown = action.attachmentIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return {
          kind: "invalid",
          message: `These are not photos of this conversation: ${unknown.map(dataLine).join(", ")}. Use the attachment ids from the conversation.`,
        };
      }
      return { kind: "run", action, notes: [] };
    }
    case "request_photo": {
      if (values["photos.request_mode"] === "never") {
        return {
          kind: "refuse",
          action,
          outcome: rejected(
            "This business does not ask customers for photos. Carry on without one.",
          ),
        };
      }
      if (!input.channel.capabilities.inboundMedia.includes("image")) {
        return {
          kind: "refuse",
          action,
          outcome: rejected(
            "The customer cannot send photos on this channel. Carry on without one.",
          ),
        };
      }
      return { kind: "run", action, notes: [] };
    }
    case "offer_times":
    case "book_meeting": {
      if (values["routing.mode"] === "always_contact_later") {
        return {
          kind: "refuse",
          action,
          outcome: rejected(
            "This business does not book meetings in chat. Tell the customer the team will be in touch, as the routing rules for contact_later describe.",
          ),
        };
      }
      if (!situation.hours.open && values["routing.after_hours_booking"] === "contact_later") {
        return {
          kind: "refuse",
          action,
          outcome: rejected(
            "The office is closed and this business does not book meetings while it is closed. Tell the customer the team will be in touch.",
          ),
        };
      }
      return { kind: "run", action, notes: [] };
    }
    case "cancel_meeting":
    case "schedule_follow_up":
    case "handoff_to_human":
    case "mark_not_a_fit":
    case "end_conversation":
      return { kind: "run", action, notes: [] };
  }
}

function inputProblem(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .slice(0, 8)
      .join("; ");
  }
  return "the input could not be read";
}

/** Extra instructions that belong with the outcome of one action. */
function guidance(action: EngineAction, outcome: ActionOutcome, context: ToolRunContext): string[] {
  const { values } = context;
  const done = outcome.status === "applied" || outcome.status === "deferred";
  switch (action.type) {
    case "escalate_emergency": {
      const item = values["emergency.classes"].find((entry) => entry.key === action.emergencyClass);
      return [
        item === undefined
          ? ""
          : `Begin your reply with these safety instructions, word for word, before anything else: ${item.safety_instructions}`,
        done
          ? "The business's on-call contacts are being alerted. Say what happens next exactly as the emergency rules describe."
          : "Nobody at the business has been alerted. Do not say that anyone has.",
      ].filter((line) => line.length > 0);
    }
    case "request_photo":
      return done
        ? [
            `You may ask for the photo now. Add this reminder in your own words: "${values["photos.safety_note"]}"`,
          ]
        : [];
    case "update_lead_fields":
      return [describeRouting(outcome.routing ?? context.input.lead.routing)];
    case "handoff_to_human":
      return done
        ? [
            "A person takes over after this reply. Tell the customer as the handoff rules describe, and ask nothing further.",
          ]
        : [];
    case "analyze_photos":
    case "book_meeting":
    case "cancel_meeting":
    case "offer_times":
    case "schedule_follow_up":
    case "mark_not_a_fit":
    case "end_conversation":
      return [];
  }
}

function resultText(outcome: ActionOutcome, extra: readonly string[]): string {
  const parts = [`status: ${outcome.status}`];
  if (outcome.message !== null && outcome.message.length > 0) parts.push(outcome.message);
  if (outcome.data !== null && outcome.data !== undefined) {
    parts.push(`data: ${JSON.stringify(outcome.data)}`);
  }
  parts.push(...extra);
  return parts.join("\n");
}

export async function runToolCalls(
  calls: readonly ModelToolUseBlock[],
  context: ToolRunContext,
): Promise<ToolRunResult> {
  const { input, ports, values } = context;
  const results: ModelToolResultBlockParam[] = [];
  const executed: ExecutedAction[] = [];
  const emergencies: EmergencyClass[] = [];
  const invalid = (id: string, message: string) => {
    results.push({ type: "tool_result", tool_use_id: id, is_error: true, content: message });
  };

  // In order, one at a time: a later call may depend on an earlier one (save the lead
  // fields, then ask for times), and handlers write to the same conversation.
  for (const call of calls) {
    const tool = findEngineTool(call.name);
    if (tool === undefined) {
      invalid(call.id, `There is no tool named "${dataLine(call.name)}".`);
      continue;
    }
    let parsed: EngineAction;
    try {
      parsed = tool.toAction(call.input);
    } catch (error) {
      invalid(call.id, `The input was not valid and nothing was done. ${inputProblem(error)}`);
      continue;
    }
    const checked = check(parsed, context);
    if (checked.kind === "invalid") {
      invalid(call.id, checked.message);
      continue;
    }

    let outcome: ActionOutcome;
    if (checked.kind === "refuse") {
      outcome = checked.outcome;
    } else {
      try {
        outcome = await ports.tools.execute(checked.action, {
          trace: input.trace,
          mode: input.mode,
          toolCallId: call.id,
          now: input.now,
          settings: input.settings,
          channel: input.channel,
          business: input.business,
        });
      } catch (error) {
        ports.logger.error("engine.tool_failed", { tool: call.name, toolCallId: call.id, error });
        outcome = {
          status: "failed",
          message: "The action could not be completed. Do not promise its result.",
          data: null,
        };
      }
    }
    executed.push({ toolCallId: call.id, action: checked.action, outcome });
    if (checked.action.type === "escalate_emergency") {
      const key = checked.action.emergencyClass;
      const item = values["emergency.classes"].find((entry) => entry.key === key);
      if (item !== undefined && !emergencies.includes(item)) emergencies.push(item);
    }
    results.push({
      type: "tool_result",
      tool_use_id: call.id,
      ...(outcome.status === "failed" ? { is_error: true } : {}),
      content: resultText(outcome, [
        ...(checked.kind === "run" ? checked.notes : []),
        ...guidance(checked.action, outcome, context),
      ]),
    });
  }
  return { results, executed, emergencies };
}
