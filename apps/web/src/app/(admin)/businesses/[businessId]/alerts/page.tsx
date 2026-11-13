import type { Metadata } from "next";

import { AlertContacts } from "@/components/alerts/alert-contacts";
import { requireBusinessPage } from "@/server/admin";

export const metadata: Metadata = { title: "Alert contacts" };
export const dynamic = "force-dynamic";

export default async function AlertsPage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, { next: `/businesses/${businessId}/alerts` });
  return <AlertContacts page={page} />;
}
