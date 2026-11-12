import { z } from "zod";

import type {
  AgencyId,
  BusinessId,
  ConversationId,
  IsoDateTime,
  MessageId,
  SegmentId,
  TraceId,
} from "../ids";
import type { Logger } from "../logger";
import type {
  AttachmentKind,
  ChannelCapabilities,
  ChannelId,
  MessagingWindowState,
} from "./channel";
import type { KnowledgeRetriever, PlaybookSnapshot } from "./knowledge";
import { LeadFieldValue, type LeadSnapshot, type RoutingDecision } from "./lead";
import type { ResolvedSettings } from "./settings";

/**
 * Conversation engine contract (owner: C4, package `@repo/ai`; stubbed by C3).
 *
 * The engine turns one conversation state into the bot's next turn. It performs no side
 * effects of its own: reading knowledge, executing tools and logging model calls all go
 * through `EnginePorts`, so the same engine runs live, in tests and in the evaluation harness
 * (`mode: "dry_run"`, where ports record instead of sending).
 */

export interface TraceContext {
  readonly traceId: TraceId;
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  /** Null for work that is not tied to one conversation (imports, playbook generation). */
  readonly conversationId: ConversationId | null;
}

export interface BusinessProfile {
  readonly id: BusinessId;
  readonly agencyId: AgencyId;
  readonly name: string;
  readonly segment: { readonly id: SegmentId; readonly slug: string; readonly name: string };
  /** IANA time zone, for example "America/Chicago". */
  readonly timezone: string;
  /**
   * How to reach the business, as stored with its profile. The engine uses it for the link
   * allow-list (the business's own website) and to say where the business is. Absent in
   * callers that predate it; every part is null when the profile does not have it.
   */
  readonly contact?: {
    readonly phone: string | null;
    readonly email: string | null;
    readonly websiteUrl: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  };
}

/** What is already known about the customer from the channel and earlier conversations. */
export interface CustomerProfile {
  readonly name: string | null;
  /** E.164, when the channel reveals it (WhatsApp) or the customer gave it before. */
  readonly phone: string | null;
  readonly email: string | null;
}

export const TURN_AUTHORS = ["customer", "bot", "human_agent"] as const;
export type TurnAuthor = (typeof TURN_AUTHORS)[number];

export interface TurnAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string | null;
  /** Private storage location, present once the pipeline has downloaded the bytes. */
  readonly storage: { readonly bucket: string; readonly path: string } | null;
  /** What an earlier `analyze_photos` action recorded about the file, if anything. */
  readonly analysis?: string | null;
}

/** One stored message as the engine sees it. */
export interface ConversationTurn {
  readonly messageId: MessageId;
  readonly author: TurnAuthor;
  readonly sentAt: IsoDateTime;
  readonly text: string | null;
  readonly attachments: readonly TurnAttachment[];
  /** Email subject, when the channel is email. */
  readonly subject: string | null;
}

export const TURN_TRIGGERS = ["inbound_message", "follow_up", "takeover_released"] as const;
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

/** The channel of the conversation as the engine and the action handlers see it. */
export interface TurnChannel {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  readonly window: MessagingWindowState;
}

export interface EngineTurnInput<
  TSettings extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly trace: TraceContext;
  /** "dry_run" must never cause an external send or a write outside the eval sandbox. */
  readonly mode: "live" | "dry_run";
  readonly trigger: TurnTrigger;
  /** Injected clock. The engine never calls Date.now(), so runs are reproducible. */
  readonly now: IsoDateTime;
  readonly business: BusinessProfile;
  /** Absent in callers that predate it: the engine then assumes nothing is known. */
  readonly customer?: CustomerProfile;
  readonly channel: TurnChannel;
  readonly settings: ResolvedSettings<TSettings>;
  /** Null only when the segment has no playbook yet. */
  readonly playbook: PlaybookSnapshot | null;
  /** Lead state and routing decision as of the end of the previous turn. */
  readonly lead: LeadSnapshot;
  /** Messages already answered, oldest first. */
  readonly history: readonly ConversationTurn[];
  /** Customer messages this turn must answer (the debounced batch). Empty for follow-ups. */
  readonly pending: readonly ConversationTurn[];
}

/** Why a contact is not a lead. The first four mirror `scoring.auto_disqualify` in settings. */
export const NOT_A_FIT_CATEGORIES = [
  "spam",
  "solicitation",
  "job_seeker",
  "wrong_number",
  "service_not_offered",
  "outside_service_area",
  "other",
] as const;
export type NotAFitCategory = (typeof NOT_A_FIT_CATEGORIES)[number];

export const END_DISPOSITIONS = ["completed", "stop_replying"] as const;
export type EndDisposition = (typeof END_DISPOSITIONS)[number];

const FollowUpDelay = z.object({
  /** ISO 8601 duration from now, for example "PT2H" or "P1D". */
  after: z.string().min(1),
  reason: z.string(),
});

/**
 * Everything the model can do besides writing text. C4 maps each tool it exposes onto one of
 * these; the pipeline validates the action again and hands it to the owning chunk's handler.
 */
export const EngineAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_lead_fields"),
    fields: z.array(LeadFieldValue.omit({ updatedAt: true })).min(1),
  }),
  z.object({
    type: z.literal("request_photo"),
    /** What the customer should photograph, for example "the electrical panel label". */
    subject: z.string().min(1),
  }),
  z.object({
    type: z.literal("analyze_photos"),
    attachmentIds: z.array(z.string().min(1)).min(1),
    question: z.string().min(1),
  }),
  z.object({ type: z.literal("schedule_follow_up"), ...FollowUpDelay.shape }),
  z.object({
    type: z.literal("offer_times"),
    /** Customer preference in their own words, for example "weekday mornings". */
    preference: z.string().nullable(),
    count: z.number().int().min(1).max(5),
  }),
  z.object({
    type: z.literal("book_meeting"),
    /**
     * Slot id returned by a previous "offer_times" action. When the customer already has a
     * meeting, booking another slot moves it (rescheduling, C12).
     */
    slotId: z.string().min(1),
  }),
  z.object({
    /** The customer cancels their booked meeting (C12; added after C4, additive). */
    type: z.literal("cancel_meeting"),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("escalate_emergency"),
    /** Emergency class key from the emergency settings, for example "gas_leak". */
    emergencyClass: z.string().min(1),
    summary: z.string().min(1),
  }),
  z.object({
    type: z.literal("handoff_to_human"),
    reason: z.string().min(1),
    urgency: z.enum(["normal", "high"]),
  }),
  z.object({
    type: z.literal("mark_not_a_fit"),
    reason: z.string().min(1),
    /** Why the contact is not a lead, as a closed list lead routing (C5) can act on. */
    category: z.enum(NOT_A_FIT_CATEGORIES).optional(),
  }),
  z.object({
    type: z.literal("end_conversation"),
    reason: z.string().min(1),
    /**
     * "completed": the conversation reached its natural end; the bot answers if the customer
     * writes again. "stop_replying": the bot stays silent from now on (spam, abuse after a
     * warning) until a person reopens the conversation. Default: "completed".
     */
    disposition: z.enum(END_DISPOSITIONS).optional(),
  }),
]);
export type EngineAction = z.infer<typeof EngineAction>;
export type EngineActionType = EngineAction["type"];

/**
 * What happened to an action. `data` is fed back to the model as the tool result, so an
 * "update_lead_fields" outcome carries the fresh routing decision and an "offer_times"
 * outcome carries the real slots.
 */
export interface ActionOutcome {
  /**
   * applied: done now. deferred: accepted, executed after the turn by a durable step.
   * rejected: not allowed by settings or state (the model must adapt its reply).
   * failed: tried and failed; the model must not promise the result.
   */
  readonly status: "applied" | "deferred" | "rejected" | "failed";
  readonly message: string | null;
  readonly data: unknown;
  /** Present on "update_lead_fields" outcomes: the decision the reply must follow. */
  readonly routing?: RoutingDecision;
}

export interface ToolExecutionContext {
  readonly trace: TraceContext;
  readonly mode: "live" | "dry_run";
  /**
   * Model tool-call id: the idempotency key for the action within one attempt of a turn. A
   * turn that is retried calls the model again and gets new ids, so a handler whose effect
   * must happen once per conversation (an emergency alert, a booking) also checks its own
   * stored state.
   */
  readonly toolCallId: string;
  readonly now: IsoDateTime;
  /**
   * The settings snapshot the turn runs under. Handlers decide with these values, not with a
   * fresh read, so the reply and the action follow the same rules (`settings.version`).
   */
  readonly settings: ResolvedSettings;
  readonly channel: TurnChannel;
  readonly business: BusinessProfile;
}

/** Executes actions on behalf of the engine. The pipeline supplies the implementation. */
export interface ToolRuntime {
  execute(action: EngineAction, context: ToolExecutionContext): Promise<ActionOutcome>;
}

/** Implemented by the chunk that owns an action; registered at the pipeline's composition root. */
export interface ActionHandler<TType extends EngineActionType = EngineActionType> {
  readonly type: TType;
  handle(
    action: Extract<EngineAction, { type: TType }>,
    context: ToolExecutionContext,
  ): Promise<ActionOutcome>;
}

export interface ExecutedAction {
  readonly toolCallId: string;
  readonly action: EngineAction;
  readonly outcome: ActionOutcome;
}

/** One request to the Claude API, as stored for audits, cost tracking and cache checks. */
export interface ModelCallRecord {
  readonly trace: TraceContext;
  /** What the call was for: "reply", "photo_analysis", "playbook", "report", "eval_judge"... */
  readonly purpose: string;
  readonly model: string;
  readonly effort: string;
  readonly promptVersion: string;
  readonly startedAt: IsoDateTime;
  readonly latencyMs: number;
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly cacheCreationInputTokens: number;
  };
  /** Provider request id for support tickets. */
  readonly requestId: string | null;
  /** Full request and response. Stored in the tenant-scoped table only; never in app logs. */
  readonly request: unknown;
  readonly response: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface ModelCallSink {
  record(call: ModelCallRecord): Promise<void>;
}

export interface EnginePorts {
  readonly knowledge: KnowledgeRetriever;
  readonly tools: ToolRuntime;
  readonly modelCalls: ModelCallSink;
  readonly logger: Logger;
}

export type ReplyDraft =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly quickReplies?: readonly string[];
    }
  | {
      readonly kind: "email";
      /** Null keeps the thread's subject. */
      readonly subject: string | null;
      readonly text: string;
    };

export interface EngineTurnResult {
  /**
   * replied: `replies` has at least one draft. no_reply: staying silent is correct (spam,
   * conversation ended, human took over). refused: the model declined; the pipeline hands
   * off to a human. failed: unrecoverable error after retries; the pipeline dead-letters.
   */
  readonly outcome: "replied" | "no_reply" | "refused" | "failed";
  /** Drafts in sending order. The pipeline splits, persists and sends them. */
  readonly replies: readonly ReplyDraft[];
  readonly actions: readonly ExecutedAction[];
  readonly promptVersion: string;
  readonly settingsVersion: string;
  /** Totals over every model call of the turn. */
  readonly usage: ModelCallRecord["usage"];
  /** How the turn went, for the turn record, tests and the evaluation harness. */
  readonly diagnostics?: EngineTurnDiagnostics;
}

export interface EngineTurnDiagnostics {
  readonly modelCalls: number;
  readonly toolRounds: number;
  /** Output-guard rules a draft broke, for example "too_long" or "price_not_allowed". */
  readonly guardViolations: readonly string[];
  /** Times the model was asked to write the reply again because of the guard. */
  readonly rewrites: number;
  /** True when the reply was written by code, not the model (after-hours message, fallback). */
  readonly deterministicReply: boolean;
  /** Short machine-readable notes, for example "after_hours:auto_reply". Never customer text. */
  readonly notes: readonly string[];
}

export interface ConversationEngine {
  respond(input: EngineTurnInput, ports: EnginePorts): Promise<EngineTurnResult>;
}
