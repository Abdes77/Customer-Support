import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SettingsPanel } from "@/components/settings/settings-panel";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaffSession } from "@/server/admin";
import { findVisibleSegment } from "@/server/admin/segments";

export const metadata: Metadata = { title: "Segment settings" };
export const dynamic = "force-dynamic";

/** The defaults of one segment, between the agency's values and each business's own. */
export default async function SegmentSettingsPage({
  params,
}: {
  readonly params: Promise<{ segmentId: string }>;
}) {
  const { segmentId } = await params;
  const session = await requireStaffSession(`/settings/segments/${segmentId}`);
  const segment = await findVisibleSegment(session, segmentId);
  if (segment === null) notFound();
  return (
    <div>
      <PageHeader
        title={`${segment.name}: segment settings`}
        description={
          <>
            Defaults for every business in this segment. They override the{" "}
            <Link href="/settings" className="font-medium text-blue-700 underline">
              agency settings
            </Link>{" "}
            and are overridden by each business&apos;s own.
          </>
        }
      />
      <SettingsPanel session={session} target={{ scope: "segment", segmentId: segment.id }} />
    </div>
  );
}
