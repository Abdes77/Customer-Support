import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireBusinessPage } from "@/server/admin";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

/**
 * Slot for C16: calendars, Calendly, CRMs (with field mapping) and outgoing webhooks, on the
 * server functions of C12 and C14 (see docs/BUILD_PLAN.md).
 */
export default async function IntegrationsPage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  await requireBusinessPage(businessId, { staffOnly: true });
  return (
    <EmptySlot
      title="Integrations"
      description="Connecting calendars, Calendly, CRMs with their field mapping, and webhooks is added in the next build step. Their settings are already on the Settings tab."
    />
  );
}
