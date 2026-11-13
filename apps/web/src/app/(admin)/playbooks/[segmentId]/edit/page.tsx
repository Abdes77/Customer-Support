import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PlaybookEditor } from "@/components/playbook/playbook-editor";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaffSession } from "@/server/admin";
import { findVisibleSegment } from "@/server/admin/segments";
import { getKnowledge } from "@/server/knowledge";

export const metadata: Metadata = { title: "Edit playbook" };
export const dynamic = "force-dynamic";

/** Edits the version in force; saving stores a new version. */
export default async function EditPlaybookPage({
  params,
}: {
  readonly params: Promise<{ segmentId: string }>;
}) {
  const { segmentId } = await params;
  const session = await requireStaffSession(`/playbooks/${segmentId}/edit`);
  const segment = await findVisibleSegment(session, segmentId);
  if (segment === null) notFound();
  const active = await getKnowledge().playbooks.getVersion(session.user, segment.id);
  return (
    <div>
      <PageHeader
        title={`Edit the ${segment.name} playbook`}
        description={
          <>
            Saving stores a new version and puts it in force for every business in the segment.{" "}
            <Link
              href={`/playbooks/${segment.id}` as Route}
              className="font-medium text-blue-700 underline"
            >
              Back to the versions
            </Link>
          </>
        }
      />
      {active?.document == null ? (
        <Callout tone="warning">There is no readable version to edit yet.</Callout>
      ) : (
        <PlaybookEditor
          segmentId={segment.id}
          baseVersion={active.version}
          document={active.document}
        />
      )}
    </div>
  );
}
