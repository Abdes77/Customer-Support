import type { ConversationId, LeadSnapshot } from "@repo/core";
import { type BusinessContext, eq, leads } from "@repo/db";

import { loadLatestDecision, loadLeadFields } from "./store/lead-store";

const NEW_LEAD: LeadSnapshot = { id: null, status: "new", fields: {}, routing: null };

/**
 * The lead as a turn's engine input sees it (`TurnLoaders.lead`): status, every field (the
 * system fields included, so the model knows an emergency was escalated) and the routing
 * decision in force, which is the one with the highest `sequence`.
 */
export async function loadLeadSnapshot(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<LeadSnapshot> {
  const [lead] = await ctx.tx
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .limit(1);
  if (lead === undefined) return NEW_LEAD;
  const latest = await loadLatestDecision(ctx, lead.id);
  return {
    id: lead.id,
    status: lead.status,
    fields: await loadLeadFields(ctx, lead.id),
    routing: latest?.decision ?? null,
  };
}
