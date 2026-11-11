import { z } from "zod";

import {
  CHANNEL_CAPABILITIES,
  type ConversationTurn,
  type EnginePorts,
  type EngineTurnInput,
  type EngineTurnResult,
  type EventPayload,
  type Logger,
  type TraceId,
  type TurnAttachment,
} from "@repo/core";
import {
  and,
  attachments,
  type BusinessContext,
  conversations,
  conversationTurns,
  desc,
  eq,
  gt,
  inArray,
  lte,
  messages,
  ne,
  not,
  notInArray,
  or,
} from "@repo/db";
import { loadSettings } from "@repo/settings/server";

import { createToolRuntime } from "../actions";
import type { PipelineContext } from "../deps";
import { loadBusinessProfile } from "../ports/loaders";
import { createModelCallSink } from "../ports/model-calls";
import { messagingWindow } from "../send/window";
import type { ClaimedTurn } from "./claim";

type ReceivedData = EventPayload<"message.received">;

export type GenerateResult =
  | { readonly kind: "abandoned"; readonly reason: string }
  | { readonly kind: "result"; readonly result: EngineTurnResult };

const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
});

/** The engine is code we own, but its output decides what customers receive: check it. */
const EngineTurnResultSchema = z.object({
  outcome: z.enum(["replied", "no_reply", "refused", "failed"]),
  replies: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        text: z.string(),
        quickReplies: z.array(z.string()).optional(),
      }),
      z.object({ kind: z.literal("email"), subject: z.string().nullable(), text: z.string() }),
    ]),
  ),
  actions: z.array(
    z.object({
      toolCallId: z.string(),
      action: z.object({ type: z.string() }).loose(),
      outcome: z
        .object({
          status: z.enum(["applied", "deferred", "rejected", "failed"]),
          message: z.string().nullable(),
        })
        .loose(),
    }),
  ),
  promptVersion: z.string(),
  settingsVersion: z.string(),
  usage: Usage,
});

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

type Prepared =
  | { readonly kind: "abandoned"; readonly reason: string }
  | { readonly kind: "ready"; readonly input: EngineTurnInput };

/**
 * Step "generate" (steps 11 and 12): renew the turn lease and build the engine input from the
 * database, then call the engine outside any transaction. Runs again on a retry; the engine
 * has no side effects of its own, and action handlers are idempotent per tool-call id.
 */
export async function generateTurn(
  p: PipelineContext,
  data: ReceivedData,
  claim: ClaimedTurn,
  logger: Logger,
): Promise<GenerateResult> {
  const prepared = await p.db
    .forBusiness(data.businessId, { agencyId: data.agencyId })
    .run((ctx) => buildTurnInput(ctx, p, data, claim));
  if (prepared.kind === "abandoned") return prepared;
  const { input } = prepared;
  const turnLogger = logger.child({
    traceId: input.trace.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    turnId: claim.turnId,
  });
  const ports: EnginePorts = {
    knowledge: p.knowledge,
    tools: createToolRuntime({ registry: p.actions, logger: turnLogger }),
    modelCalls:
      p.modelCalls ??
      createModelCallSink({
        db: p.db,
        logger: turnLogger,
        mode: input.mode,
        settingsVersion: input.settings.version,
      }),
    logger: turnLogger,
  };

  const result = await p.engine.respond(input, ports);
  const checked = EngineTurnResultSchema.safeParse(result);
  if (!checked.success) {
    turnLogger.error("engine.invalid_result", {
      paths: checked.error.issues.map((issue) => issue.path.join(".")),
    });
    return {
      kind: "result",
      result: {
        outcome: "failed",
        replies: [],
        actions: [],
        promptVersion: typeof result.promptVersion === "string" ? result.promptVersion : "unknown",
        settingsVersion: input.settings.version,
        usage: ZERO_USAGE,
      },
    };
  }
  // Through JSON, so what the commit step receives is what a replay would receive.
  return { kind: "result", result: JSON.parse(JSON.stringify(result)) as EngineTurnResult };
}

function subjectOf(payload: Record<string, unknown>): string | null {
  const email = payload["email"];
  if (email !== null && typeof email === "object" && "subject" in email) {
    const subject = email.subject;
    if (typeof subject === "string") return subject;
  }
  const subject = payload["subject"];
  return typeof subject === "string" ? subject : null;
}

async function buildTurnInput(
  ctx: BusinessContext,
  p: PipelineContext,
  data: ReceivedData,
  claim: ClaimedTurn,
): Promise<Prepared> {
  const [turn] = await ctx.tx
    .select({ status: conversationTurns.status })
    .from(conversationTurns)
    .where(eq(conversationTurns.id, claim.turnId))
    .limit(1);
  if (turn?.status !== "running") return { kind: "abandoned", reason: "turn_not_running" };

  // Still ours? Then renew the lease, so the engine call gets the whole lease time however
  // long the claim, the downloads and earlier attempts of this step took. A run that crashes
  // still frees the conversation once the renewed lease runs out.
  const [conversation] = await ctx.tx
    .update(conversations)
    .set({ turnLeaseExpiresAt: new Date(p.clock().getTime() + p.options.leaseSeconds * 1000) })
    .where(
      and(
        eq(conversations.id, data.conversationId),
        eq(conversations.turnLeaseOwner, claim.turnId),
      ),
    )
    .returning({
      id: conversations.id,
      channel: conversations.channel,
      handled: conversations.handledThroughSeq,
      lastInboundAt: conversations.lastInboundAt,
    });
  if (conversation === undefined) return { kind: "abandoned", reason: "lease_lost" };
  const business = await loadBusinessProfile(ctx);
  if (business === null) return { kind: "abandoned", reason: "business_without_segment" };

  const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
  const values = settings.values;
  const capabilities =
    p.adapters.find(conversation.channel)?.capabilities ??
    CHANNEL_CAPABILITIES[conversation.channel];
  const now = p.clock();

  const columns = {
    id: messages.id,
    direction: messages.direction,
    author: messages.author,
    kind: messages.kind,
    text: messages.text,
    payload: messages.payload,
    sequence: messages.sequence,
    sentAt: messages.sentAt,
    createdAt: messages.createdAt,
  };
  const pendingFilter = and(
    eq(messages.direction, "inbound"),
    ne(messages.kind, "reaction"),
    gt(messages.sequence, conversation.handled),
    lte(messages.sequence, claim.throughSeq),
  );
  const pendingRows = await ctx.tx
    .select(columns)
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), pendingFilter))
    .orderBy(messages.sequence);
  const historyRows = (
    await ctx.tx
      .select(columns)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          not(pendingFilter!),
          or(
            // Customer messages up to the turn's range; newer ones belong to the next turn.
            and(eq(messages.direction, "inbound"), lte(messages.sequence, claim.throughSeq)),
            // Every reply that went out or is on its way, whatever its sequence: a reply of
            // the previous turn can be numbered after a customer message that came in while
            // it was being written, and the engine must still see it. Drafts that were never
            // sent (superseded, failed) are not part of the conversation. While this turn
            // holds the lease, no other turn adds bot messages.
            and(
              eq(messages.direction, "outbound"),
              notInArray(messages.status, ["superseded", "failed"]),
            ),
          ),
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(values["conversation.history_messages"])
  ).reverse();

  const ids = [...historyRows, ...pendingRows].map((row) => row.id);
  const attachmentRows =
    ids.length === 0
      ? []
      : await ctx.tx
          .select({
            id: attachments.id,
            messageId: attachments.messageId,
            kind: attachments.kind,
            mimeType: attachments.mimeType,
            status: attachments.status,
            bucket: attachments.storageBucket,
            path: attachments.storagePath,
          })
          .from(attachments)
          .where(inArray(attachments.messageId, ids))
          .orderBy(attachments.createdAt, attachments.id);
  const byMessage = new Map<string, TurnAttachment[]>();
  for (const row of attachmentRows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      mimeType: row.mimeType,
      storage:
        row.status === "stored" && row.bucket !== null && row.path !== null
          ? { bucket: row.bucket, path: row.path }
          : null,
    });
    byMessage.set(row.messageId, list);
  }

  const maxCharacters = values["limits.max_inbound_characters"];
  const toTurn = (row: (typeof pendingRows)[number]): ConversationTurn => ({
    messageId: row.id,
    author: row.author,
    sentAt: (row.sentAt ?? row.createdAt).toISOString(),
    // The bot reads at most this much of one customer message (`limits.max_inbound_characters`).
    text:
      row.author === "customer" && row.text !== null && row.text.length > maxCharacters
        ? row.text.slice(0, maxCharacters)
        : row.text,
    attachments: byMessage.get(row.id) ?? [],
    subject: subjectOf(row.payload),
  });

  const input: EngineTurnInput = {
    trace: {
      traceId: claim.traceId as TraceId,
      agencyId: data.agencyId,
      businessId: data.businessId,
      conversationId: data.conversationId,
    },
    mode: "live",
    trigger: "inbound_message",
    now: now.toISOString(),
    business,
    channel: {
      id: conversation.channel,
      capabilities,
      window: messagingWindow(capabilities, conversation.lastInboundAt, now),
    },
    settings,
    playbook: await p.loaders.playbook(ctx, business),
    lead: await p.loaders.lead(ctx, conversation.id),
    history: historyRows.map(toTurn),
    pending: pendingRows.map(toTurn),
  };
  return { kind: "ready", input };
}
