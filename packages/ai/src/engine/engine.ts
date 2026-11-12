import {
  AppError,
  type ConversationEngine,
  type EngineAction,
  type EnginePorts,
  type EngineTurnDiagnostics,
  type EngineTurnInput,
  type EngineTurnResult,
  type ExecutedAction,
  ExternalServiceError,
  type KnowledgeFact,
  type ReplyDraft,
  ValidationError,
} from "@repo/core";
import { type AppResolvedSettings, type AppSettings, SETTING_KEYS } from "@repo/settings";

import {
  type Draft,
  dueSafetyInstructions,
  fallbackReply,
  finalizeDraft,
  type GuardContext,
  reviewDraft,
  rewriteNote,
} from "../guard/guard";
import { parseReply } from "../guard/parse";
import { zonedInstant } from "../hours";
import { callModel } from "../model/call";
import {
  addUsage,
  assistantEcho,
  type ModelClient,
  type ModelMessageParam,
  type ModelResponse,
  type ModelUsage,
  responseText,
  responseToolUses,
  ZERO_USAGE,
} from "../model/types";
import { fillTemplate } from "../prompt/business-block";
import { buildPrompt, withOperatorNote } from "../prompt/build";
import { CURRENT_REPLY_PROMPT, PROMPT_VERSION } from "../prompt/core";
import { replyHints } from "./hints";
import { describeSituation, type EmergencyClass, turnFacts } from "./situation";
import { runToolCalls } from "./tools";

/**
 * The conversation engine (docs/ARCHITECTURE.md §7): one customer turn in, reply drafts and
 * executed actions out. It has no side effects of its own. Knowledge, actions and the audit
 * record of every model call go through the ports, so the same engine runs live, in tests
 * and in the evaluation harness.
 */

export interface EngineOptions {
  readonly model: ModelClient;
  /**
   * Longest a whole turn may take, model calls and tools together. It has to fit inside the
   * pipeline's turn lease, which is renewed right before the engine is called.
   */
  readonly turnBudgetMs?: number;
  /** Longest a single attempt of a model call may take. */
  readonly callTimeoutMs?: number;
  /**
   * Send the tools with `strict: true`. Off only where structured outputs are not available
   * (an organization with customer-managed encryption keys); inputs are checked either way.
   */
  readonly strictTools?: boolean;
  /** Times the model is asked to rewrite a draft the output guard rejected. Default 1. */
  readonly maxRewrites?: number;
  /** Wall clock for deadlines and latency. Prompt content uses `input.now`, never this. */
  readonly clock?: () => Date;
}

export const DEFAULT_TURN_BUDGET_MS = 240_000;
export const DEFAULT_CALL_TIMEOUT_MS = 90_000;
/** A call is not started with less time than this left. */
const MIN_CALL_MS = 5_000;
const MAX_OUTPUT_TOKENS = 64_000;

const LAST_STEP_NOTE =
  "You have used every step available for this reply. Write the reply to the customer now. No tool can be called any more.";

function appSettings(input: EngineTurnInput): AppSettings {
  const values = input.settings.values;
  const missing = SETTING_KEYS.filter((key) => !(key in values));
  if (missing.length > 0) {
    throw new ValidationError(
      "The settings snapshot of the turn is not a resolved snapshot of the registry.",
      { details: { missing: missing.slice(0, 10) } },
    );
  }
  return (input.settings as AppResolvedSettings).values;
}

interface TurnState {
  usage: ModelUsage;
  modelCalls: number;
  toolRounds: number;
  rewrites: number;
  readonly actions: ExecutedAction[];
  readonly emergencies: EmergencyClass[];
  readonly violations: Set<string>;
  readonly notes: string[];
}

function toDrafts(input: EngineTurnInput, draft: Draft): ReplyDraft[] {
  if (input.channel.capabilities.format === "email") {
    return [{ kind: "email", subject: draft.subject, text: draft.messages.join("\n\n") }];
  }
  return draft.messages.map((text, index) => ({
    kind: "text" as const,
    text,
    ...(index === draft.messages.length - 1 && draft.quickReplies.length > 0
      ? { quickReplies: [...draft.quickReplies] }
      : {}),
  }));
}

export function createEngine(options: EngineOptions): ConversationEngine {
  const clock = options.clock ?? (() => new Date());
  const turnBudgetMs = options.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const strictTools = options.strictTools ?? true;
  const maxRewrites = options.maxRewrites ?? 1;

  async function respond(input: EngineTurnInput, ports: EnginePorts): Promise<EngineTurnResult> {
    const values = appSettings(input);
    const situation = describeSituation(input, values);
    const logger = ports.logger;
    const state: TurnState = {
      usage: ZERO_USAGE,
      modelCalls: 0,
      toolRounds: 0,
      rewrites: 0,
      actions: [],
      emergencies: [],
      violations: new Set(),
      notes: [],
    };
    let deterministicReply = false;

    const finish = (
      outcome: EngineTurnResult["outcome"],
      replies: readonly ReplyDraft[],
    ): EngineTurnResult => {
      const diagnostics: EngineTurnDiagnostics = {
        modelCalls: state.modelCalls,
        toolRounds: state.toolRounds,
        guardViolations: [...state.violations],
        rewrites: state.rewrites,
        deterministicReply,
        notes: [...state.notes],
      };
      logger.info("engine.turn", {
        outcome,
        purpose: situation.purpose,
        replies: replies.length,
        actions: state.actions.map((entry) => `${entry.action.type}:${entry.outcome.status}`),
        ...diagnostics,
      });
      return {
        outcome,
        replies,
        actions: state.actions,
        promptVersion: PROMPT_VERSION,
        settingsVersion: input.settings.version,
        usage: state.usage,
        diagnostics,
      };
    };

    if (situation.purpose === "none") {
      state.notes.push("nothing_due");
      return finish("no_reply", []);
    }

    // Only the categories the business keeps "in every reply", and the facts the agency
    // pinned, go into the cached section; everything else is looked up per turn.
    const coreCategories = new Set<string>(values["knowledge.core_categories"]);
    const coreFacts = (await ports.knowledge.coreFacts(input.business.id)).filter(
      (fact) => fact.pinned === true || coreCategories.has(fact.category),
    );
    let retrieved: readonly KnowledgeFact[] = [];
    if (situation.customerText.trim().length > 0) {
      try {
        retrieved = await ports.knowledge.retrieve({
          businessId: input.business.id,
          text: situation.customerText,
          limit: values["knowledge.retrieval_limit"],
        });
      } catch (error) {
        // The core facts are in the prompt either way; a failed look-up costs detail, not the reply.
        logger.warn("engine.retrieval_failed", { error });
        state.notes.push("retrieval_failed");
      }
    }
    const facts = turnFacts(retrieved, coreFacts);

    const task = situation.task;
    const model = values[`model.${task}.model`];
    const effort = values[`model.${task}.effort`];
    const prompt = buildPrompt({
      input,
      values,
      situation,
      coreFacts,
      turnFacts: facts,
      model,
      strictTools,
    });
    const guard = (): GuardContext => ({
      input,
      values,
      situation,
      prompt: CURRENT_REPLY_PROMPT,
      coreFacts,
      turnFacts: facts,
      emergencies: state.emergencies,
      actions: state.actions,
    });
    const hints = replyHints(input, situation);
    const deadline = clock().getTime() + turnBudgetMs;
    const maxRounds = values["model.max_tool_rounds"];
    let maxTokens = values["model.reply_max_output_tokens"];
    let gaveMoreRoom = false;
    let messages: ModelMessageParam[] = prompt.messages;
    /** Set once the model may only write: after the last round, and for a rewrite. */
    let textOnly = false;

    const execute = async (action: EngineAction, id: string) => {
      try {
        const outcome = await ports.tools.execute(action, {
          trace: input.trace,
          mode: input.mode,
          toolCallId: id,
          now: input.now,
          settings: input.settings,
          channel: input.channel,
          business: input.business,
        });
        state.actions.push({ toolCallId: id, action, outcome });
        return outcome;
      } catch (error) {
        logger.error("engine.action_failed", { type: action.type, error });
        return null;
      }
    };

    /** What is sent when an emergency was escalated and the model's own reply is not usable. */
    const emergencyReply = (): EngineTurnResult => {
      deterministicReply = true;
      state.notes.push("emergency_reply_from_code");
      const alerted = state.actions.some(
        (entry) =>
          entry.action.type === "escalate_emergency" &&
          (entry.outcome.status === "applied" || entry.outcome.status === "deferred"),
      );
      const phone = values["emergency.phone"];
      const line =
        phone !== null && values["emergency.customer_instruction"] !== "team_will_call"
          ? ` You can reach our emergency line at ${phone}.`
          : "";
      const text = fillTemplate(
        alerted
          ? `I've alerted the team at {{business_name}}.${line} Please send me your phone number and the address so they can reach you.`
          : `I could not reach the team at {{business_name}} automatically.${line} Please send me your phone number and the address, and call 911 if anyone is in danger.`,
        input.business,
        values,
      );
      const final = finalizeDraft({ messages: [text], quickReplies: [], subject: null }, guard());
      return finish("replied", toDrafts(input, final.draft));
    };

    /** After-hours modes that send a fixed message or nothing, unless it is an emergency. */
    const afterHoursResult = async (): Promise<EngineTurnResult> => {
      deterministicReply = true;
      state.notes.push(`after_hours:${situation.afterHours}`);
      const next = situation.hours.nextOpen;
      if (next !== null) {
        const opensAt = zonedInstant(next.date, next.time, input.business.timezone);
        const minutes = Math.max(
          1,
          Math.ceil((opensAt.getTime() - situation.now.getTime()) / 60_000),
        );
        await execute(
          {
            type: "schedule_follow_up",
            after: `PT${minutes}M`,
            reason:
              "The office was closed: answer the customer's unanswered messages now that it is open.",
          },
          `engine-after-hours-${input.trace.traceId}`,
        );
      }
      if (situation.afterHours !== "send_message") return finish("no_reply", []);
      return finish(
        "replied",
        toDrafts(input, {
          messages: [situation.afterHoursMessage],
          quickReplies: [],
          subject: null,
        }),
      );
    };

    const call = async (): Promise<ModelResponse> => {
      const remaining = deadline - clock().getTime();
      if (remaining < MIN_CALL_MS) {
        throw new ExternalServiceError("The turn ran out of time before the model could answer.", {
          provider: "anthropic",
          retryable: true,
          details: { reason: "turn_deadline" },
        });
      }
      const response = await callModel(
        options.model,
        {
          purpose: task,
          model,
          effort,
          maxTokens,
          system: prompt.system,
          tools: prompt.tools,
          toolChoice: textOnly ? "none" : "auto",
          messages,
          fallbacks: values["model.server_side_fallbacks"],
          timeoutMs: Math.min(callTimeoutMs, remaining),
          signal: AbortSignal.timeout(remaining),
          hints,
        },
        {
          trace: input.trace,
          promptVersion: PROMPT_VERSION,
          sink: ports.modelCalls,
          logger,
          storeIo: values["data.store_model_io"],
          clock,
        },
      );
      state.modelCalls += 1;
      state.usage = addUsage(state.usage, response.usage);
      return response;
    };

    try {
      for (;;) {
        const response = await call();

        if (response.stopReason === "refusal") {
          state.notes.push(`refusal:${response.stopDetails?.category ?? "unspecified"}`);
          if (state.emergencies.length > 0) return emergencyReply();
          return finish("refused", []);
        }
        if (response.stopReason === "max_tokens") {
          // Never a reply to send: thinking and text share the limit, so the text may be cut.
          if (gaveMoreRoom || maxTokens >= MAX_OUTPUT_TOKENS) {
            state.notes.push("max_tokens");
            if (state.emergencies.length > 0) return emergencyReply();
            return finish("failed", []);
          }
          gaveMoreRoom = true;
          maxTokens = Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2);
          state.notes.push("retried_with_more_room");
          continue;
        }
        if (response.stopReason === "pause_turn") {
          messages = [...messages, { role: "assistant", content: assistantEcho(response.content) }];
          state.toolRounds += 1;
          if (state.toolRounds > maxRounds + 2) {
            state.notes.push("paused_too_often");
            return finish("failed", []);
          }
          continue;
        }

        const calls = responseToolUses(response.content);
        if (response.stopReason === "tool_use" && calls.length > 0 && !textOnly) {
          const run = await runToolCalls(calls, { input, values, situation, ports });
          state.actions.push(...run.executed);
          for (const item of run.emergencies) {
            if (!state.emergencies.includes(item)) state.emergencies.push(item);
          }
          messages = [
            ...messages,
            { role: "assistant", content: assistantEcho(response.content) },
            { role: "user", content: run.results },
          ];
          state.toolRounds += 1;
          if (state.toolRounds >= maxRounds) {
            textOnly = true;
            messages = withOperatorNote(messages, LAST_STEP_NOTE, prompt.systemChannel);
          }
          continue;
        }
        if (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") {
          state.notes.push(`unexpected_stop:${response.stopReason ?? "none"}`);
          if (state.emergencies.length > 0) return emergencyReply();
          return finish("failed", []);
        }

        // The model has written its answer.
        const emergency = state.emergencies.length > 0;
        if (situation.afterHours !== "none" && !emergency) return await afterHoursResult();

        const parsed = parseReply(responseText(response.content));
        if (parsed.kind !== "messages") {
          if (emergency && dueSafetyInstructions(guard()).length > 0) return emergencyReply();
          if (parsed.kind === "after_hours_message" && !situation.hours.open) {
            deterministicReply = true;
            state.notes.push("after_hours_message_by_model");
            return finish(
              "replied",
              toDrafts(input, {
                messages: [situation.afterHoursMessage],
                quickReplies: [],
                subject: null,
              }),
            );
          }
          state.notes.push("model_chose_silence");
          return finish("no_reply", []);
        }

        const draft: Draft = parsed;
        const findings = reviewDraft(draft, guard());
        for (const finding of findings) state.violations.add(finding.rule);
        const timeLeft = deadline - clock().getTime();
        if (findings.length > 0 && state.rewrites < maxRewrites && timeLeft > 2 * MIN_CALL_MS) {
          // One rewrite. The rejected draft is not echoed as an assistant turn: the request
          // stays the same up to the last message, and the note carries the draft as a quote.
          state.rewrites += 1;
          textOnly = true;
          messages = withOperatorNote(messages, rewriteNote(findings, draft), prompt.systemChannel);
          continue;
        }

        const final = finalizeDraft(draft, guard());
        for (const rule of final.applied) state.violations.add(rule);
        if (final.applied.includes("replaced_with_fallback")) {
          // The fallback tells the customer the team has the message: make that true.
          deterministicReply = true;
          await execute(
            {
              type: "handoff_to_human",
              reason: "The bot could not write a reply that may be sent.",
              urgency: "normal",
            },
            `engine-fallback-${input.trace.traceId}`,
          );
        }
        return finish("replied", toDrafts(input, final.draft));
      }
    } catch (error) {
      if (state.emergencies.length > 0) {
        // Safety instructions go out whatever happened to the model call.
        logger.error("engine.model_failed_after_escalation", { error });
        return emergencyReply();
      }
      if (error instanceof AppError && !error.retryable) {
        logger.error("engine.model_failed", { code: error.code, error });
        state.notes.push(`error:${error.code}`);
        return finish("failed", []);
      }
      // Retryable (rate limit, overload, timeout, deadline) and unknown errors: the job
      // retries the step, which calls the engine again with a renewed lease.
      throw error;
    }
  }

  return { respond };
}

/** The reply sent when the engine itself cannot produce one. Exported for the tests. */
export function engineFallbackReply(context: GuardContext): string {
  return fallbackReply(context);
}
