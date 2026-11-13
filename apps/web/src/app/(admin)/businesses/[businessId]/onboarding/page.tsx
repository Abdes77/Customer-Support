import type { Route } from "next";
import { redirect } from "next/navigation";

import { requireBusinessPage } from "@/server/admin";

export const dynamic = "force-dynamic";

/** The wizard opens at the segment step once the business exists, or at the end when it is live. */
export default async function OnboardingPage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const { business } = await requireBusinessPage(businessId, { staffOnly: true });
  const step =
    business.status !== "onboarding" ? "finish" : business.segment === null ? "segment" : "import";
  redirect(`/businesses/${business.id}/onboarding/${step}` as Route);
}
