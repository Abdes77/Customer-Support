import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireAccess } from "@/server/auth";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

/** Slot for C16: conversations, response time, qualification rate, bookings, drop-off. */
export default async function AnalyticsPage() {
  await requireAccess("/analytics");
  return (
    <EmptySlot
      title="Analytics"
      description="Conversations, first-response time, qualification rate, booked meetings and where conversations drop off are added in the next build step."
    />
  );
}
