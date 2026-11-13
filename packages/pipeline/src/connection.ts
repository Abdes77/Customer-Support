import { type ChannelConnectionContext, type ChannelConnectionId, NotFoundError } from "@repo/core";
import { type BusinessContext, channelConnections, type Database, eq } from "@repo/db";

/**
 * Loads a channel connection with its credentials decrypted, for the one vendor call that
 * needs them. Call it inside the step that makes the call, never put the result in a step
 * output, an event or a log (ARCHITECTURE §3, "Secrets").
 */
export async function loadConnectionContext(
  ctx: BusinessContext,
  db: Database,
  connectionId: ChannelConnectionId,
): Promise<ChannelConnectionContext> {
  const [row] = await ctx.tx
    .select({
      id: channelConnections.id,
      businessId: channelConnections.businessId,
      externalAccountId: channelConnections.externalAccountId,
      config: channelConnections.config,
    })
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId))
    .limit(1);
  if (row === undefined) {
    throw new NotFoundError("Channel connection not found.", { details: { connectionId } });
  }
  const credentials = await db.secrets.channel.read(ctx, connectionId);
  return {
    connectionId: row.id,
    businessId: row.businessId,
    externalAccountId: row.externalAccountId,
    credentials,
    config: row.config,
  };
}
