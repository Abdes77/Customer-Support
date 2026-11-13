import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireAccess } from "@/server/auth";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

/**
 * Slot for C16: one conversation with its lead panel. Alerts and calendar events already
 * link here (`/inbox/<conversation id>`). Nothing about the conversation is read yet, so
 * nothing can leak through this page.
 */
export default async function ConversationPage({
  params,
}: {
  readonly params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  await requireAccess(`/inbox/${encodeURIComponent(conversationId)}`);
  return (
    <EmptySlot
      title="Conversation"
      description="The conversation view, with the lead's score and report, takeover and manual replies, is added in the next build step."
    />
  );
}
