import { analyzePhotos, type ModelClient, type PhotoInput } from "@repo/ai";
import type {
  ActionHandler,
  ActionOutcome,
  ConversationId,
  ExecutedAction,
  Logger,
  ToolExecutionContext,
} from "@repo/core";
import {
  and,
  attachments,
  type BusinessTenant,
  conversations,
  conversationTurns,
  count,
  type Database,
  eq,
  inArray,
  isNotNull,
  messages,
  sql,
} from "@repo/db";
import type { TenantStorage } from "@repo/db/storage";
import type { AppSettings } from "@repo/settings";

import type { AnyActionHandler } from "../actions";
import { createModelCallSink } from "../ports/model-calls";

/**
 * The action handlers the conversation engine's own chunk (C4) owns: asking for a photo,
 * looking at photos, and ending a conversation. Each one decides with the turn's settings
 * snapshot and the stored state, never on the model's word.
 *
 * In dry-run mode (invariant I8) a handler answers what it would do and writes nothing.
 */

export interface EngineHandlerDeps {
  readonly db: Database;
  readonly model: ModelClient;
  readonly storage: (tenant: BusinessTenant) => TenantStorage;
  readonly logger: Logger;
}

const applied = (message: string | null, data: unknown = null): ActionOutcome => ({
  status: "applied",
  message,
  data,
});
const rejected = (message: string): ActionOutcome => ({ status: "rejected", message, data: null });

function valuesOf(context: ToolExecutionContext): AppSettings {
  // The engine checked the snapshot against the registry before it called any tool.
  return context.settings.values as unknown as AppSettings;
}

function scope(db: Database, context: ToolExecutionContext) {
  return db.forBusiness(context.trace.businessId, { agencyId: context.trace.agencyId });
}

function isExecuted(value: unknown): value is ExecutedAction {
  if (value === null || typeof value !== "object") return false;
  const entry = value as { action?: { type?: unknown }; outcome?: { status?: unknown } };
  return typeof entry.action?.type === "string" && typeof entry.outcome?.status === "string";
}

/** How often an action was carried out in earlier turns of the conversation. */
async function countEarlier(
  db: Database,
  context: ToolExecutionContext,
  conversationId: ConversationId,
  type: ExecutedAction["action"]["type"],
): Promise<number> {
  const rows = await scope(db, context).run((ctx) =>
    ctx.tx
      .select({ actions: conversationTurns.actions })
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, conversationId)),
  );
  let total = 0;
  for (const row of rows) {
    for (const entry of row.actions) {
      if (
        isExecuted(entry) &&
        entry.action.type === type &&
        (entry.outcome.status === "applied" || entry.outcome.status === "deferred")
      ) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * `request_photo`: the bot may ask for a photo `photos.max_requests` times per conversation,
 * and only where the channel can carry one.
 */
export function requestPhotoHandler(deps: EngineHandlerDeps): ActionHandler<"request_photo"> {
  return {
    type: "request_photo",
    async handle(_action, context) {
      const values = valuesOf(context);
      if (values["photos.request_mode"] === "never") {
        return rejected("This business does not ask customers for photos. Carry on without one.");
      }
      if (!context.channel.capabilities.inboundMedia.includes("image")) {
        return rejected("The customer cannot send photos on this channel. Carry on without one.");
      }
      const conversationId = context.trace.conversationId;
      if (conversationId === null || context.mode === "dry_run") return applied(null);
      const earlier = await countEarlier(deps.db, context, conversationId, "request_photo");
      const max = values["photos.max_requests"];
      if (earlier >= max) {
        return rejected(
          `You have already asked for photos ${earlier} ${earlier === 1 ? "time" : "times"} in this conversation, which is the most the business allows. Do not ask again; carry on without one.`,
        );
      }
      return applied(null, { request: earlier + 1, of: max });
    },
  };
}

/** "Photo 1: ... Photo 2: ..." split per photo, when the description is laid out that way. */
function perPhoto(description: string, photos: number): string[] {
  const parts = description
    .split(/(?=^Photo \d+:)/m)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === photos ? parts : Array.from({ length: photos }, () => description);
}

/**
 * `analyze_photos`: looks at photos of this conversation with the photo-analysis model and
 * keeps what it saw with each attachment, so later turns and the lead report can use it.
 */
export function analyzePhotosHandler(deps: EngineHandlerDeps): ActionHandler<"analyze_photos"> {
  return {
    type: "analyze_photos",
    async handle(action, context) {
      const values = valuesOf(context);
      if (!values["photos.analysis_enabled"]) {
        return rejected(
          "Photo analysis is switched off for this business. The photos are stored for the team: thank the customer and carry on.",
        );
      }
      const conversationId = context.trace.conversationId;
      if (conversationId === null) return rejected("There is no conversation to take photos from.");

      const { rows, analyzedBefore } = await scope(deps.db, context).run(async (ctx) => {
        // Only attachments of messages of this very conversation: an id from anywhere else
        // finds nothing.
        const found = await ctx.tx
          .select({
            id: attachments.id,
            kind: attachments.kind,
            mimeType: attachments.mimeType,
            status: attachments.status,
            path: attachments.storagePath,
            analysis: attachments.analysis,
          })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(
            and(
              eq(messages.conversationId, conversationId),
              inArray(attachments.id, action.attachmentIds),
            ),
          );
        const [done] = await ctx.tx
          .select({ total: count() })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(
            and(eq(messages.conversationId, conversationId), isNotNull(attachments.analyzedAt)),
          );
        return { rows: found, analyzedBefore: done?.total ?? 0 };
      });

      const byId = new Map(rows.map((row) => [row.id, row]));
      const unknown = action.attachmentIds.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        return rejected(
          "Some of these are not photos of this conversation. Use the ids from the conversation.",
        );
      }
      const already = rows.filter((row) => (row.analysis ?? "").trim().length > 0);
      const fresh = rows.filter(
        (row) =>
          (row.analysis ?? "").trim().length === 0 &&
          row.kind === "image" &&
          row.status === "stored" &&
          row.path !== null,
      );
      const allowance = Math.max(0, values["photos.max_per_conversation"] - analyzedBefore);
      const chosen = fresh.slice(0, allowance);
      if (chosen.length === 0) {
        if (already.length > 0) {
          return applied("These photos were looked at before.", {
            description: already.map((row) => row.analysis).join("\n"),
          });
        }
        return rejected(
          fresh.length > 0
            ? "The business analyzes only a limited number of photos per conversation, and that number is reached. The photo is stored for the team: thank the customer and carry on."
            : "The photo could not be opened. It is stored for the team: thank the customer and carry on.",
        );
      }

      const storage = deps.storage({
        agencyId: context.trace.agencyId,
        businessId: context.trace.businessId,
      });
      const photos: PhotoInput[] = [];
      for (const row of chosen) {
        const object = row.path === null ? null : await storage.get(row.path);
        if (object !== null) {
          photos.push({
            id: row.id,
            mediaType: row.mimeType ?? object.contentType,
            bytes: object.bytes,
          });
        }
      }
      const result = await analyzePhotos({
        model: deps.model,
        photos,
        question: action.question,
        business: context.business,
        values,
        trace: context.trace,
        sink: createModelCallSink({
          db: deps.db,
          logger: deps.logger,
          mode: context.mode,
          settingsVersion: context.settings.version,
        }),
        logger: deps.logger,
      });
      if (result.text === null) {
        return rejected(
          "The photo could not be analyzed. It is stored for the team: thank the customer and carry on.",
        );
      }

      if (context.mode === "live") {
        const descriptions = perPhoto(result.text, result.analyzed.length);
        const analyzedAt = new Date(context.now);
        await scope(deps.db, context).run(async (ctx) => {
          for (const [index, id] of result.analyzed.entries()) {
            await ctx.tx
              .update(attachments)
              .set({ analysis: descriptions[index] ?? result.text, analyzedAt })
              .where(eq(attachments.id, id));
          }
        });
      }
      return applied(null, {
        description: result.text,
        analyzed: result.analyzed,
        notAnalyzed: result.skipped,
      });
    },
  };
}

/**
 * `end_conversation`: records that the bot considers the conversation finished. The
 * conversation stays open for the inbox. With "stop_replying" the guard below keeps the bot
 * silent from then on; with "completed" the customer's next message simply reopens it.
 */
export function endConversationHandler(deps: EngineHandlerDeps): ActionHandler<"end_conversation"> {
  return {
    type: "end_conversation",
    async handle(action, context) {
      const conversationId = context.trace.conversationId;
      const disposition = action.disposition ?? "completed";
      if (conversationId === null || context.mode === "dry_run")
        return applied(null, { disposition });
      const ended = { at: context.now, reason: action.reason.slice(0, 300), disposition };
      await scope(deps.db, context).run((ctx) =>
        ctx.tx
          .update(conversations)
          .set({
            metadata: sql`${conversations.metadata} || ${JSON.stringify({ ended })}::jsonb`,
          })
          .where(eq(conversations.id, conversationId)),
      );
      return applied(null, { disposition });
    },
  };
}

export function engineActionHandlers(deps: EngineHandlerDeps): AnyActionHandler[] {
  return [requestPhotoHandler(deps), analyzePhotosHandler(deps), endConversationHandler(deps)];
}
