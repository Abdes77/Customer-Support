import {
  createDryRunConversation,
  createMemoryToolRuntime,
  type CustomerMessage as DryRunMessage,
  type DryRunState,
  type DryRunTurn,
} from "@repo/ai";
import {
  type ActionOutcome,
  ConfigError,
  type CustomerProfile,
  EngineAction,
  ExternalServiceError,
  type Logger,
  type ToolExecutionContext,
  type ToolRuntime,
  type TraceContext,
  type TraceId,
} from "@repo/core";
import { leadRouting, withLeadScoring } from "@repo/leads";
import { type AppResolvedSettings, channelSetting } from "@repo/settings";

import { EvalAbortError, type RetryOptions, withRetries } from "../run/retry";
import type { EvalSandbox } from "../sandbox/sandbox";
import type { Scenario } from "../scenarios/types";
import { costOfCalls, summarizeCall } from "./calls";
import type { CustomerMove, CustomerSimulator } from "./customer";
import {
  addUsage,
  type BotEntry,
  type CallSummary,
  type CustomerMessage,
  type CustomerSource,
  type EndReason,
  NO_USAGE,
  type Transcript,
  type TranscriptEntry,
  type Usage,
} from "./transcript";

/**
 * One simulated conversation: the customer of a scenario against the real engine in dry-run
 * mode. The loop here is the stand-in for the parts of production that sit around the engine
 * and that a dry run does not have: the clock, the debounced batch of customer messages, the
 * guards that keep the bot silent once a person holds the conversation or the bot ended it,
 * and the follow-up turn that fires when a customer goes quiet.
 */

/** Minutes between a bot reply and the customer's next message. */
const CUSTOMER_REPLY_MINUTES = 2;

export interface ConversationDeps {
  readonly sandbox: Pick<EvalSandbox, "engine" | "knowledge" | "business" | "settingsVerdict">;
  readonly customer: CustomerSimulator;
  readonly logger: Logger;
  readonly retry?: RetryOptions;
  /** Aborted when the conversation runs into its wall-clock ceiling. */
  readonly signal?: AbortSignal;
  /** Lowers the persona's own limit, for quick runs. */
  readonly maxCustomerTurns?: number;
}

/** What the customer's channel already tells the business about them. */
export function customerProfile(scenario: Scenario): CustomerProfile {
  const { truth } = scenario.instance;
  const digits = truth.phone.replaceAll(/\D/g, "");
  switch (scenario.channel) {
    case "whatsapp":
      return { name: truth.name, phone: `+1${digits}`, email: null };
    case "messenger":
    case "instagram":
      return { name: truth.name, phone: null, email: null };
    case "email":
      return { name: truth.name, phone: null, email: truth.email };
    case "widget":
      return { name: null, phone: null, email: null };
  }
}

/**
 * The tool runtime of a sandbox conversation. An action is validated the way the pipeline
 * validates it, production's own handler has the first word where it decides from the
 * settings alone, and the effect is kept in the dry run's memory with the real scoring and
 * routing rules.
 */
function sandboxTools(
  state: DryRunState,
  settings: AppResolvedSettings,
  sandbox: ConversationDeps["sandbox"],
): ToolRuntime {
  const memory = withLeadScoring(
    state,
    settings,
    createMemoryToolRuntime({ state, settings, routing: leadRouting }),
  );
  return {
    async execute(action: EngineAction, context: ToolExecutionContext): Promise<ActionOutcome> {
      const parsed = EngineAction.safeParse(action);
      if (!parsed.success) {
        return {
          status: "rejected",
          message: "The action was not valid and was not carried out.",
          data: null,
        };
      }
      const verdict = await sandbox.settingsVerdict(parsed.data, context);
      if (verdict?.status === "rejected") return verdict;
      return memory.execute(parsed.data, context);
    },
  };
}

function botEntry(
  turn: DryRunTurn,
  customerTurn: number,
  state: DryRunState,
  first: boolean,
): BotEntry {
  const calls: CallSummary[] = turn.modelCalls.map(summarizeCall);
  return {
    kind: "bot",
    turn: customerTurn,
    at: turn.input.now,
    trigger: turn.input.trigger,
    outcome: turn.result.outcome,
    replies: turn.result.replies.map((draft) => ({
      text: draft.text,
      ...(draft.kind === "email" ? { subject: draft.subject } : {}),
      ...(draft.kind === "text" && draft.quickReplies !== undefined
        ? { quickReplies: draft.quickReplies }
        : {}),
    })),
    actions: turn.result.actions,
    diagnostics: turn.result.diagnostics ?? null,
    routing: state.lead.routing?.outcome ?? null,
    leadStatus: state.lead.status,
    first,
    usage: turn.result.usage,
    latencyMs: calls.reduce((total, call) => total + call.latencyMs, 0),
    calls,
  };
}

/**
 * An engine failure that is the API's or the configuration's doing, not the bot's: the
 * engine returns "failed" for an error no retry can fix (a 400, a missing or refused key)
 * and notes its code. That is not a conversation to grade; it is thrown, so the run reports
 * it instead of scoring it.
 */
function infrastructureFailure(turn: DryRunTurn): Error | null {
  if (turn.result.outcome !== "failed") return null;
  const note = turn.result.diagnostics?.notes.find((item) => item.startsWith("error:"));
  if (note === undefined) return null;
  if (note === "error:config_missing") {
    return new ConfigError(
      "The engine could not call the model: the Claude API is not configured, or it refused the key (docs/HUMAN_TODO.md, step 4).",
    );
  }
  return new ExternalServiceError(
    `The engine could not call the model (${note.slice("error:".length)}). The request was refused in a way no retry can fix.`,
    { provider: "anthropic", retryable: false },
  );
}

export async function runConversation(
  scenario: Scenario,
  deps: ConversationDeps,
): Promise<Transcript> {
  const { instance, settings } = scenario;
  const { profile, playbook } = deps.sandbox.business(scenario.suite);
  const logger = deps.logger.child({ scenario: scenario.id });
  const conversation = createDryRunConversation({
    engine: deps.sandbox.engine,
    business: profile,
    settings,
    playbook,
    channel: scenario.channel,
    knowledge: deps.sandbox.knowledge,
    customer: customerProfile(scenario),
    startAt: scenario.startAt,
    slots: [...scenario.profile.slots],
    tools: (state) => sandboxTools(state, settings, deps.sandbox),
    logger,
  });
  const { state } = conversation;
  const trace: TraceContext = {
    traceId: "00000000-0000-4000-8e00-000000000000" as TraceId,
    agencyId: profile.agencyId,
    businessId: profile.id,
    conversationId: null,
  };

  const entries: TranscriptEntry[] = [];
  const customerCalls: CallSummary[] = [];
  let engineUsage: Usage = NO_USAGE;
  const engineCalls: CallSummary[] = [];
  let retries = 0;
  let botTurns = 0;
  let photosSent = 0;
  let promptVersion = "";
  let leaveReason: string | null = null;
  const maxTurns = Math.min(
    scenario.persona.maxCustomerTurns,
    deps.maxCustomerTurns ?? Number.POSITIVE_INFINITY,
  );
  const lastAt = () => entries.at(-1)?.at ?? scenario.startAt;
  const checkAbort = () => {
    if (deps.signal?.aborted === true) throw new EvalAbortError();
  };
  const retry: RetryOptions = {
    ...deps.retry,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    onRetry: (error, attempt, waitMs) => {
      retries += 1;
      logger.warn("eval.retry", { attempt, waitMs, error });
    },
  };

  /** Runs one engine turn and records it. A repeated attempt adds no time to the clock. */
  const engineTurn = async (
    customerTurn: number,
    run: (attempt: number) => Promise<DryRunTurn>,
  ): Promise<BotEntry> => {
    checkAbort();
    const { value: turn } = await withRetries(run, retry);
    const failure = infrastructureFailure(turn);
    if (failure !== null) throw failure;
    const entry = botEntry(turn, customerTurn, state, botTurns === 0 && turn.replies.length > 0);
    if (turn.replies.length > 0) botTurns += 1;
    engineUsage = addUsage(engineUsage, turn.result.usage);
    engineCalls.push(...entry.calls);
    promptVersion = turn.result.promptVersion;
    entries.push(entry);
    return entry;
  };

  /** True once production would keep the bot silent, whatever the customer writes. */
  const botHeld = () => state.handedOff || state.ended === "stop_replying";

  const finish = (ended: EndReason): Transcript => ({
    scenarioId: scenario.id,
    entries,
    ended,
    leaveReason,
    lead: state.lead,
    handedOff: state.handedOff,
    photosSent,
    promptVersion,
    usage: {
      engine: engineUsage,
      customer: customerCalls.reduce((total, call) => addUsage(total, call.usage), NO_USAGE),
    },
    costMicroUsd: { engine: costOfCalls(engineCalls), customer: costOfCalls(customerCalls) },
    engineModels: [...new Set(engineCalls.map((call) => call.model))],
    customerModels: [...new Set(customerCalls.map((call) => call.model))],
    retries,
  });

  let move: CustomerMove = {
    messages: instance.opening,
    photo: false,
    leave: null,
    replaced: false,
  };
  let source: CustomerSource = "opening";
  let afterMinutes: number | undefined;
  let silenceDone = instance.silence === null;

  for (let customerTurn = 1; ; customerTurn += 1) {
    // The customer writes.
    const photo = move.photo && instance.truth.photo !== null && photosSent === 0;
    const messages: CustomerMessage[] = move.messages.map((text, index) => ({
      text,
      ...(photo && index === move.messages.length - 1 ? { photo: instance.truth.photo ?? "" } : {}),
      ...(scenario.channel === "email" && customerTurn === 1 && index === 0
        ? { subject: instance.truth.job?.short ?? "Quick question" }
        : {}),
    }));
    if (messages.length === 0 && photo)
      messages.push({ text: null, photo: instance.truth.photo ?? "" });
    if (photo) photosSent += 1;
    if (move.leave !== null) leaveReason = move.leave;
    if (messages.length === 0) return finish("customer_left");

    const photoId = `photo-${scenario.id}`;
    const pending: DryRunMessage[] = messages.map((message) => ({
      text: message.text,
      ...(message.photo === undefined ? {} : { photos: [{ id: photoId, shows: message.photo }] }),
      ...(message.subject === undefined ? {} : { subject: message.subject }),
    }));

    if (botHeld()) {
      // Production's guards stop the turn here; the message is stored and nobody answers.
      const at = new Date(Date.parse(lastAt()) + CUSTOMER_REPLY_MINUTES * 60_000).toISOString();
      entries.push({ kind: "customer", turn: customerTurn, at, source, messages });
      entries.push({
        kind: "event",
        at,
        event: "bot_held_silent",
        note: state.handedOff
          ? "A person holds the conversation: the bot does not answer."
          : "The bot ended this conversation: it does not answer.",
      });
    } else {
      // A customer who writes again reopens a conversation that had simply finished.
      if (state.ended === "completed") state.ended = null;
      const wait = afterMinutes;
      const customerIndex = entries.length;
      const entry = await engineTurn(customerTurn, (attempt) =>
        conversation.customerSays(
          pending,
          customerTurn === 1
            ? {}
            : { afterMinutes: attempt === 1 ? (wait ?? CUSTOMER_REPLY_MINUTES) : 0 },
        ),
      );
      // The customer's entry goes in front of the bot's, with the time the engine was given.
      entries.splice(customerIndex, 0, {
        kind: "customer",
        turn: customerTurn,
        at: entry.at,
        source,
        messages,
      });
      if (entry.outcome === "refused") return finish("refused");
      if (entry.outcome === "failed") return finish("engine_failed");
    }
    afterMinutes = undefined;
    let returning = false;

    // What ends the conversation after this exchange.
    if (move.leave !== null) return finish("customer_left");
    const scripted = instance.beats.find((beat) => beat.turn === customerTurn + 1);
    if (botHeld() && scripted === undefined) {
      return finish(state.handedOff ? "handed_off" : "bot_stopped_replying");
    }
    if (customerTurn >= maxTurns) return finish("max_turns");
    if (instance.fullyScripted && scripted === undefined) return finish("script_finished");

    // The customer goes quiet: follow-ups fire, then the customer comes back.
    if (!silenceDone && instance.silence !== null && botTurns >= instance.silence.afterBotTurns) {
      silenceDone = true;
      const values = settings.values;
      const delays = channelSetting(values, "follow_up.delays_minutes", scenario.channel);
      const allowed = values["follow_up.enabled"]
        ? Math.min(
            instance.silence.nudges,
            channelSetting(values, "follow_up.max_nudges", scenario.channel),
            delays.length,
          )
        : 0;
      entries.push({
        kind: "event",
        at: lastAt(),
        event: "customer_silent",
        note: `The customer stops answering for ${instance.silence.returnAfterHours} hours.`,
      });
      let waited = 0;
      for (let nudge = 0; nudge < allowed && !botHeld(); nudge += 1) {
        const delay = delays[nudge] ?? 120;
        waited += delay;
        await engineTurn(customerTurn, (attempt) =>
          conversation.trigger("follow_up", { afterMinutes: attempt === 1 ? delay : 0 }),
        );
      }
      afterMinutes = Math.max(30, instance.silence.returnAfterHours * 60 - waited);
      returning = true;
      entries.push({
        kind: "event",
        at: new Date(Date.parse(lastAt()) + afterMinutes * 60_000).toISOString(),
        event: "customer_returned",
        note: "The customer writes again.",
      });
    }

    // The customer's next line: fixed by the scenario, or written by the simulator.
    if (scripted !== undefined) {
      move = { messages: scripted.messages, photo: false, leave: null, replaced: false };
      source = "scripted";
      continue;
    }
    checkAbort();
    const { value } = await withRetries(
      () =>
        deps.customer.next({
          scenario,
          entries,
          returning,
          photoSent: photosSent > 0,
          trace,
          calls: customerCalls,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      retry,
    );
    move = value;
    source = value.replaced ? "stand_in" : "simulated";
    if (value.replaced) {
      entries.push({
        kind: "event",
        at: lastAt(),
        event: "simulator_replaced",
        note: "The customer model could not write this line; the rule-based stand-in did.",
      });
    }
  }
}
