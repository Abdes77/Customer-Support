import type { Metadata } from "next";

import { EmptySlot } from "@/components/ui/page-header";
import { requireStaffSession } from "@/server/admin";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

/** Slot for C16: the audit log viewer (agency admins read the audit log). */
export default async function AuditPage() {
  await requireStaffSession("/audit");
  return (
    <EmptySlot
      title="Audit log"
      description="The audit log viewer, with every change to settings, knowledge, playbooks and businesses, is added in the next build step."
    />
  );
}
