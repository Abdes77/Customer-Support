import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireBusinessPage } from "@/server/admin";

export const metadata: Metadata = { title: "Channels" };
export const dynamic = "force-dynamic";

/**
 * Slot for C16: the connection pages for the website widget, WhatsApp, Instagram and
 * Messenger, and email, on the server functions of C8 to C11 (see docs/BUILD_PLAN.md).
 */
export default async function ChannelsPage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  await requireBusinessPage(businessId, { staffOnly: true });
  return (
    <EmptySlot
      title="Channels"
      description="Connecting the website chat, WhatsApp, Instagram, Messenger and email inboxes is added in the next build step. Until then the business can be tried on the test chat."
    />
  );
}
