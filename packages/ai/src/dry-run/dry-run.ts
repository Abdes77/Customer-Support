import {
  type ActionOutcome,
  type BusinessProfile,
  CHANNEL_CAPABILITIES,
  type ChannelId,
  type ConversationEngine,
  type ConversationTurn,
  createLogger,
  type CustomerProfile,
  type EngineAction,
  type EnginePorts,
  type EngineTurnInput,
  type EngineTurnResult,
  type ExecutedAction,
  type KnowledgeFact,
  type KnowledgeRetriever,
  type LeadSnapshot,
  type Logger,
  type MessageId,
  type ModelCallRecord,
  type PlaybookSnapshot,
  type RoutingDecision,
  type ToolExecutionContext,
  type ToolRuntime,
  type TraceId,
  type TurnAttachment,
  type TurnTrigger,
} from "@repo/core";
import type { AppResolvedSettings, AppSettings } from "@repo/settings";

import { isKnown, leadFieldCatalogue } from "../lead-fields";

/**
 * Dry runs: the real engine with ports that record instead of acting (invariant I8: nothing
 * is sent and nothing is written outside the caller's own memory). The evaluation harness
 * (C7) and this package's scripted conversations both use it.
 *
 * - `dryRunTurn` runs one turn with `mode: "dry_run"`.
 * - `createDryRunConversation` keeps a whole conversation in memory: the history, the lead
 *   record and what the actions did, so turn follows turn the way it does in production.
 */

/** A retriever over a fixed list of facts: every fact is "core", look-ups match by word. */
export function staticKnowledge(facts: readonly KnowledgeFact[]): KnowledgeRetriever {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    );
  return {
    coreFacts: async () => facts,
    retrieve: async ({ text, limit }) => {
      const wanted = words(text);
      return facts
        .map((fact) => {
          let score = 0;
          for (const word of words(`${fact.title} ${fact.content} ${fact.category}`)) {
            if (wanted.has(word)) score += 1;
          }
          return { fact, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit ?? 8)
        .map((entry) => entry.fact);
    },
  };
}

export interface DryRunPorts extends EnginePorts {
  /** Every model call of the run, oldest first. */
  readonly modelCallLog: ModelCallRecord[];
}

export function createDryRunPorts(options: {
  readonly tools: ToolRuntime;
  readonly knowledge?: KnowledgeRetriever;
  readonly logger?: Logger;
}): DryRunPorts {
  const modelCallLog: ModelCallRecord[] = [];
  return {
    knowledge: options.knowledge ?? staticKnowledge([]),
    tools: options.tools,
    modelCalls: {
      record: async (call) => {
        modelCallLog.push(call);
      },
    },
    logger: options.logger ?? createLogger({ level: "error", sink: () => {} }),
    modelCallLog,
  };
}

/** One turn of the engine in dry-run mode, whatever mode the input names. */
export function dryRunTurn(
  engine: ConversationEngine,
  input: EngineTurnInput,
  ports: EnginePorts,
): Promise<EngineTurnResult> {
  return engine.respond({ ...input, mode: "dry_run" }, ports);
}

/**
 * A simplified stand-in for lead routing, kept for this package's own tests (which cannot
 * depend on `@repo/leads`). The real rules are `leadRouting` and `withLeadScoring` in
 * `@repo/leads` (C5); dry runs that should route like production pass those. A lead
 * gets a decision once every required criterion is known, with a score from the criterion
 * weights and the band and outcome from the scoring and routing settings. It ignores fit
 * rules (service area, budget minimums, adjustments). Use it only where the real handler is
 * not available.
 */
export function placeholderRouting(
  lead: LeadSnapshot,
  settings: AppResolvedSettings,
  now: string,
): RoutingDecision | null {
  const values: AppSettings = settings.values;
  const minimum = values["scoring.minimum_confidence"];
  const scored = leadFieldCatalogue(values).filter(
    (field) => field.group === "criterion" || field.group === "custom",
  );
  const missing = scored.filter((field) => field.required && !isKnown(lead, field.key, minimum));
  if (missing.length > 0) return null;
  const total = scored.reduce((sum, field) => sum + field.weight, 0);
  const credit = values["scoring.unknown_credit_percent"] / 100;
  const earned = scored.reduce(
    (sum, field) => sum + field.weight * (isKnown(lead, field.key, minimum) ? 1 : credit),
    0,
  );
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);
  const thresholds = values["scoring.thresholds"];
  const band = score >= thresholds.hot ? "hot" : score >= thresholds.warm ? "warm" : "cold";
  const outcome =
    values["routing.mode"] === "always_contact_later"
      ? "contact_later"
      : values[`routing.${band}_outcome`];
  return {
    outcome,
    score,
    band,
    reasons: ["Every required criterion is known (placeholder routing)."],
    decidedAt: now,
    settingsVersion: settings.version,
  };
}

export interface DryRunState {
  lead: LeadSnapshot;
  /** Every action of the conversation with its outcome, oldest first. */
  readonly actions: ExecutedAction[];
  handedOff: boolean;
  ended: "completed" | "stop_replying" | null;
  photoRequests: number;
  /** Slots `offer_times` hands out. Empty: booking is not available, as before C12. */
  readonly slots: { readonly id: string; readonly label: string }[];
  /** What `analyze_photos` reports per attachment id. */
  readonly photoFindings: Map<string, string>;
}

export interface MemoryToolRuntimeOptions {
  readonly state: DryRunState;
  readonly settings: AppResolvedSettings;
  /** Default: `placeholderRouting`. */
  readonly routing?: (
    lead: LeadSnapshot,
    settings: AppResolvedSettings,
    now: string,
  ) => RoutingDecision | null;
}

const done = (message: string | null, data: unknown = null): ActionOutcome => ({
  status: "applied",
  message,
  data,
});
const no = (message: string): ActionOutcome => ({ status: "rejected", message, data: null });

/**
 * A `ToolRuntime` that keeps its effects in memory. It stands in for the handlers of the
 * pipeline's composition: lead fields are merged into the lead record and routed, the other
 * actions change a few flags. Every call is recorded in `state.actions`.
 */
export function createMemoryToolRuntime(options: MemoryToolRuntimeOptions): ToolRuntime {
  const { state, settings } = options;
  const route = options.routing ?? placeholderRouting;
  const values = settings.values;

  function handle(action: EngineAction, context: ToolExecutionContext): ActionOutcome {
    switch (action.type) {
      case "update_lead_fields": {
        const fields = { ...state.lead.fields };
        for (const field of action.fields) fields[field.key] = { ...field, updatedAt: context.now };
        const lead: LeadSnapshot = { ...state.lead, fields };
        const routing = route(lead, settings, context.now);
        const status =
          routing === null
            ? "qualifying"
            : routing.outcome === "disqualify"
              ? "disqualified"
              : "qualified";
        state.lead = { ...lead, status, routing };
        return {
          ...done(`Saved: ${action.fields.map((field) => field.key).join(", ")}.`),
          ...(routing === null ? {} : { routing }),
        };
      }
      case "mark_not_a_fit":
        state.lead = { ...state.lead, status: "disqualified" };
        return done("Recorded. Close the conversation politely, as the routing rules describe.");
      case "escalate_emergency":
        return done("The on-call contacts are being alerted.", { alerted: true });
      case "handoff_to_human":
        state.handedOff = true;
        state.lead = { ...state.lead, status: "handed_off" };
        return done("A person has been asked to take over.");
      case "request_photo":
        if (state.photoRequests >= values["photos.max_requests"]) {
          return no("You have asked for photos as often as the business allows. Carry on without.");
        }
        state.photoRequests += 1;
        return done(null);
      case "analyze_photos": {
        const findings = action.attachmentIds.map(
          (id) => state.photoFindings.get(id) ?? "The photo shows the area the customer described.",
        );
        return done(null, { description: findings.join(" ") });
      }
      case "schedule_follow_up":
        return { status: "deferred", message: "The follow-up is scheduled.", data: null };
      case "offer_times":
        if (state.slots.length === 0) {
          return no(
            "Online booking is not available. Tell the customer the team will contact them to find a time.",
          );
        }
        return done(null, { slots: state.slots.slice(0, action.count) });
      case "book_meeting": {
        const slot = state.slots.find((entry) => entry.id === action.slotId);
        if (slot === undefined) return no("That time is not one of the offered slots.");
        state.lead = { ...state.lead, status: "meeting_booked" };
        return done(`Booked: ${slot.label}.`, { slot });
      }
      case "end_conversation":
        state.ended = action.disposition ?? "completed";
        return done(null);
    }
  }

  return {
    async execute(action, context) {
      const outcome = handle(action, context);
      state.actions.push({ toolCallId: context.toolCallId, action, outcome });
      return outcome;
    },
  };
}

export interface DryRunConversationOptions {
  readonly engine: ConversationEngine;
  readonly business: BusinessProfile;
  readonly settings: AppResolvedSettings;
  /** Null (the default): the engine uses its built-in playbook for the segment. */
  readonly playbook?: PlaybookSnapshot | null;
  /** Default: the test channel. */
  readonly channel?: ChannelId;
  readonly facts?: readonly KnowledgeFact[];
  readonly knowledge?: KnowledgeRetriever;
  readonly customer?: CustomerProfile;
  /** The time of the first message. Default: a Tuesday morning in the business's hours. */
  readonly startAt?: string;
  /** Replaces the in-memory runtime, for example with the pipeline's real handlers. */
  readonly tools?: (state: DryRunState) => ToolRuntime;
  readonly routing?: MemoryToolRuntimeOptions["routing"];
  readonly slots?: DryRunState["slots"];
  readonly logger?: Logger;
}

export interface CustomerMessage {
  readonly text: string | null;
  readonly photos?: readonly { readonly id: string; readonly shows?: string }[];
  readonly subject?: string;
}

export interface DryRunTurn {
  readonly input: EngineTurnInput;
  readonly result: EngineTurnResult;
  /** The texts that would have been sent, in order. */
  readonly replies: readonly string[];
  /** The model calls of this turn. */
  readonly modelCalls: readonly ModelCallRecord[];
}

export interface DryRunConversation {
  readonly state: DryRunState;
  readonly history: ConversationTurn[];
  readonly turns: DryRunTurn[];
  readonly ports: DryRunPorts;
  /** The customer writes one or more messages; the engine answers them in one turn. */
  customerSays(
    message: string | CustomerMessage | readonly (string | CustomerMessage)[],
    options?: { readonly afterMinutes?: number },
  ): Promise<DryRunTurn>;
  /** A turn without a new message: a follow-up that is due, or a released takeover. */
  trigger(
    trigger: Exclude<TurnTrigger, "inbound_message">,
    options?: { readonly afterMinutes?: number },
  ): Promise<DryRunTurn>;
  /** Adds a message a person at the business wrote. */
  teamMemberSays(text: string, options?: { readonly afterMinutes?: number }): void;
}

function isMessageList(
  value: string | CustomerMessage | readonly (string | CustomerMessage)[],
): value is readonly (string | CustomerMessage)[] {
  return Array.isArray(value);
}

const DEFAULT_START = "2026-11-10T17:00:00.000Z";

function id(prefix: number, counter: number): string {
  return `00000000-0000-4000-8${String(prefix).padStart(3, "0")}-${String(counter).padStart(12, "0")}`;
}

export function createDryRunConversation(options: DryRunConversationOptions): DryRunConversation {
  const channelId = options.channel ?? "test";
  const capabilities = CHANNEL_CAPABILITIES[channelId];
  const state: DryRunState = {
    lead: { id: null, status: "new", fields: {}, routing: null },
    actions: [],
    handedOff: false,
    ended: null,
    photoRequests: 0,
    slots: [...(options.slots ?? [])],
    photoFindings: new Map(),
  };
  const tools =
    options.tools?.(state) ??
    createMemoryToolRuntime({
      state,
      settings: options.settings,
      ...(options.routing === undefined ? {} : { routing: options.routing }),
    });
  const ports = createDryRunPorts({
    tools,
    knowledge: options.knowledge ?? staticKnowledge(options.facts ?? []),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const history: ConversationTurn[] = [];
  const turns: DryRunTurn[] = [];
  let clock = Date.parse(options.startAt ?? DEFAULT_START);
  let messages = 0;
  let traces = 0;
  const conversationId = id(1, 1);

  const nextMessageId = () => {
    messages += 1;
    return id(2, messages) as MessageId;
  };

  async function run(trigger: TurnTrigger, pending: ConversationTurn[]): Promise<DryRunTurn> {
    traces += 1;
    const now = new Date(clock).toISOString();
    const input: EngineTurnInput = {
      trace: {
        traceId: id(3, traces) as TraceId,
        agencyId: options.business.agencyId,
        businessId: options.business.id,
        conversationId: conversationId as EngineTurnInput["trace"]["conversationId"],
      },
      mode: "dry_run",
      trigger,
      now,
      business: options.business,
      ...(options.customer === undefined ? {} : { customer: options.customer }),
      channel: {
        id: channelId,
        capabilities,
        window: { open: true, closesAt: null },
      },
      settings: options.settings,
      playbook: options.playbook ?? null,
      lead: state.lead,
      history: [...history],
      pending,
    };
    const before = ports.modelCallLog.length;
    const result = await dryRunTurn(options.engine, input, ports);

    // What production does after a turn: the answered messages and the replies join the
    // history, and photo findings stay with their attachments.
    for (const executed of result.actions) {
      if (executed.action.type !== "analyze_photos" || executed.outcome.status !== "applied")
        continue;
      const description = (executed.outcome.data as { description?: string } | null)?.description;
      if (description === undefined) continue;
      const ids = new Set(executed.action.attachmentIds);
      for (const turn of pending) {
        turn.attachments.forEach((attachment, index) => {
          if (ids.has(attachment.id)) {
            (turn.attachments as TurnAttachment[])[index] = {
              ...attachment,
              analysis: description,
            };
          }
        });
      }
    }
    history.push(...pending);
    const replies = result.replies.map((draft) => draft.text);
    result.replies.forEach((draft, index) => {
      history.push({
        messageId: nextMessageId(),
        author: "bot",
        sentAt: new Date(clock + 5000 + index * 1000).toISOString(),
        text: draft.text,
        attachments: [],
        subject: draft.kind === "email" ? draft.subject : null,
      });
    });
    const turn: DryRunTurn = {
      input,
      result,
      replies,
      modelCalls: ports.modelCallLog.slice(before),
    };
    turns.push(turn);
    return turn;
  }

  const advance = (minutes: number | undefined, fallback: number) => {
    clock += (minutes ?? fallback) * 60_000;
  };

  return {
    state,
    history,
    turns,
    ports,
    async customerSays(message, runOptions = {}) {
      if (turns.length > 0 || history.length > 0) advance(runOptions.afterMinutes, 1);
      const list = isMessageList(message) ? message : [message];
      const pending = list.map((entry, index): ConversationTurn => {
        const item: CustomerMessage = typeof entry === "string" ? { text: entry } : entry;
        for (const photo of item.photos ?? []) {
          if (photo.shows !== undefined) state.photoFindings.set(photo.id, photo.shows);
        }
        return {
          messageId: nextMessageId(),
          author: "customer",
          sentAt: new Date(clock + index * 1000).toISOString(),
          text: item.text,
          attachments: (item.photos ?? []).map((photo): TurnAttachment => ({
            id: photo.id,
            kind: "image",
            mimeType: "image/jpeg",
            storage: { bucket: "dry-run", path: `dry-run/${photo.id}.jpg` },
            analysis: null,
          })),
          subject: item.subject ?? null,
        };
      });
      return run("inbound_message", pending);
    },
    async trigger(trigger, runOptions = {}) {
      advance(runOptions.afterMinutes, 120);
      return run(trigger, []);
    },
    teamMemberSays(text, runOptions = {}) {
      advance(runOptions.afterMinutes, 1);
      history.push({
        messageId: nextMessageId(),
        author: "human_agent",
        sentAt: new Date(clock).toISOString(),
        text,
        attachments: [],
        subject: null,
      });
    },
  };
}
