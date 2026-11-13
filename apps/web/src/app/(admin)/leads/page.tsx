import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireAccess } from "@/server/auth";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

/** Slot for C16: the lead list with scores, reports and CSV export. */
export default async function LeadsPage() {
  await requireAccess("/leads");
  return (
    <EmptySlot
      title="Leads"
      description="The lead list, with scores, written reports, filters and CSV export, is added in the next build step."
    />
  );
}
