import type { ChannelId, EventPayload } from "@repo/core";
import { attachments, eq, messages } from "@repo/db";
import { isPermanentError } from "@repo/jobs";

import { loadConnectionContext } from "../connection";
import type { PipelineContext } from "../deps";

type ReceivedData = EventPayload<"message.received">;

/** Larger downloads are refused (and the attachment marked failed). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type AttachmentStepResult = "stored" | "skipped" | "failed" | "already_done";

/**
 * One attachment download (step 11), in its own step so a retry repeats only what failed.
 * The adapter fetches the bytes with the connection's credentials; they go to the tenant's
 * private storage and the row records where. A permanent failure marks the attachment
 * failed and the turn goes on without it.
 */
export async function downloadAttachment(
  p: PipelineContext,
  data: ReceivedData,
  channel: ChannelId,
  attachmentId: string,
): Promise<AttachmentStepResult> {
  const scope = p.db.forBusiness(data.businessId, { agencyId: data.agencyId });
  const row = await scope.run(async (ctx) => {
    const [found] = await ctx.tx
      .select({
        status: attachments.status,
        source: attachments.source,
        mimeType: attachments.mimeType,
        fileName: attachments.fileName,
        messageId: attachments.messageId,
        conversationId: messages.conversationId,
        connectionId: messages.channelConnectionId,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    return found;
  });
  if (row?.status !== "pending") return "already_done";

  const mark = (values: Partial<typeof attachments.$inferInsert>) =>
    scope.run(async (ctx) => {
      await ctx.tx.update(attachments).set(values).where(eq(attachments.id, attachmentId));
    });

  const source = row.source;
  const adapter = p.adapters.find(channel);
  if (source === null || source.type === "storage" || adapter?.fetchAttachment === undefined) {
    await mark({ status: "skipped", error: "No way to download this attachment." });
    return "skipped";
  }

  try {
    const connection = await scope.run((ctx) => loadConnectionContext(ctx, p.db, row.connectionId));
    const file = await adapter.fetchAttachment(connection, source);
    if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      await mark({ status: "failed", error: "The file is too large." });
      return "failed";
    }
    const stored = await p
      .storage({ agencyId: data.agencyId, businessId: data.businessId })
      .putAttachment(
        {
          conversationId: row.conversationId,
          messageId: row.messageId,
          fileName: row.fileName,
        },
        file.bytes,
        { contentType: file.mimeType },
      );
    await mark({
      status: "stored",
      storageBucket: stored.bucket,
      storagePath: stored.path,
      sizeBytes: file.bytes.byteLength,
      mimeType: row.mimeType ?? file.mimeType,
      error: null,
    });
    return "stored";
  } catch (error) {
    if (!isPermanentError(error)) throw error;
    await mark({ status: "failed", error: (error as Error).message.slice(0, 500) });
    return "failed";
  }
}
