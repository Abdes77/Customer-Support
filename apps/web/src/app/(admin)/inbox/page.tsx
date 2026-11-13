import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireAccess } from "@/server/auth";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

/** Slot for C16: the live inbox across channels and businesses. */
export default async function InboxPage() {
  await requireAccess("/inbox");
  return (
    <EmptySlot
      title="Inbox"
      description="The live inbox, with every conversation across channels and businesses, human takeover and manual replies, is added in the next build step."
    />
  );
}
