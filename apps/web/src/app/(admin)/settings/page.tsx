import type { Metadata, Route } from "next";
import Link from "next/link";

import { SettingsPanel } from "@/components/settings/settings-panel";
import { AgencySwitcher } from "@/components/shell/agency-switcher";
import { PageHeader } from "@/components/ui/page-header";
import { listStaffAgencies, requireStaffSession } from "@/server/admin";
import { listVisibleSegments } from "@/server/admin/segments";

export const metadata: Metadata = { title: "Agency settings" };
export const dynamic = "force-dynamic";

/** Agency-wide values: the defaults every business inherits unless its segment or itself overrides. */
export default async function AgencySettingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams)["agency"];
  const session = await requireStaffSession(
    "/settings",
    typeof requested === "string" ? requested : null,
  );
  const [agencies, visibleSegments] = await Promise.all([
    listStaffAgencies(session),
    listVisibleSegments(session),
  ]);
  // Row-level security shows the segments of every agency the user is staff of.
  const segments = visibleSegments.filter((segment) => segment.agencyId === session.agencyId);
  return (
    <div>
      <PageHeader
        title="Agency settings"
        description={
          session.agencyRole === "agency_admin"
            ? "Values set here apply to every business of the agency unless a segment or the business overrides them."
            : "Values set here apply to every business of the agency. Only an agency admin can change them."
        }
      />
      <AgencySwitcher agencies={agencies} current={session.agencyId} path="/settings" />
      {segments.length > 0 && (
        <p className="mb-4 text-sm text-slate-600">
          Segment defaults:{" "}
          {segments.map((segment, index) => (
            <span key={segment.id}>
              {index > 0 && ", "}
              <Link
                href={`/settings/segments/${segment.id}` as Route}
                className="font-medium text-blue-700 underline-offset-2 hover:underline"
              >
                {segment.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      <SettingsPanel session={session} target={{ scope: "global", agencyId: session.agencyId }} />
    </div>
  );
}
