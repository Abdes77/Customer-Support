import type { Metadata, Route } from "next";
import Link from "next/link";

import { AgencySwitcher } from "@/components/shell/agency-switcher";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { listStaffAgencies, requireStaffSession } from "@/server/admin";
import { getKnowledge } from "@/server/knowledge";

export const metadata: Metadata = { title: "Playbooks" };
export const dynamic = "force-dynamic";

/** One industry playbook per segment the agency serves. */
export default async function PlaybooksPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams)["agency"];
  const session = await requireStaffSession(
    "/playbooks",
    typeof requested === "string" ? requested : null,
  );
  const [agencies, segments] = await Promise.all([
    listStaffAgencies(session),
    getKnowledge().playbooks.listSegments(session.user, session.agencyId),
  ]);
  return (
    <div>
      <PageHeader
        title="Playbooks"
        description="Each segment has one industry playbook, generated the first time a business is onboarded in it and reused for the next. Every edit is kept as a version."
      />
      <AgencySwitcher agencies={agencies} current={session.agencyId} path="/playbooks" />
      {segments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-600">
          No segments yet. Onboarding a business creates its segment and playbook.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {segments.map((entry) => {
            const open =
              entry.generation !== null &&
              (entry.generation.status === "pending" || entry.generation.status === "running");
            return (
              <li key={entry.segment.id}>
                <Link
                  href={`/playbooks/${entry.segment.id}` as Route}
                  className="flex flex-col gap-2 px-4 py-4 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <span className="font-medium text-slate-900">{entry.segment.name}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {entry.activeVersion === null ? (
                      <Badge tone="amber">No playbook yet</Badge>
                    ) : (
                      <Badge tone="green">Version {entry.activeVersion} in force</Badge>
                    )}
                    <Badge>
                      {entry.versions} {entry.versions === 1 ? "version" : "versions"}
                    </Badge>
                    {open && <Badge tone="blue">Being written</Badge>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
