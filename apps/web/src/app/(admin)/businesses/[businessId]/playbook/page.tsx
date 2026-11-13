import type { Metadata, Route } from "next";
import Link from "next/link";

import { PLAYBOOK_SECTION_LABELS, type PlaybookSection } from "@repo/core";
import { OVERRIDABLE_SECTIONS } from "@repo/knowledge";

import { PlaybookDocumentView } from "@/components/playbook/document-view";
import { OriginBadge } from "@/components/playbook/origin";
import { OverrideEditor } from "@/components/playbook/override-editor";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireBusinessPage } from "@/server/admin";
import { getKnowledge } from "@/server/knowledge";

export const metadata: Metadata = { title: "Business playbook" };
export const dynamic = "force-dynamic";

/**
 * The playbook this business's bot follows: the segment's, with the sections the business
 * replaced with its own.
 */
export default async function BusinessPlaybookPage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, {
    staffOnly: true,
    next: `/businesses/${businessId}/playbook`,
  });
  const segment = page.business.segment;
  if (segment === null) {
    return (
      <Callout tone="warning" title="No segment yet">
        <Link
          href={`/businesses/${page.business.id}/onboarding/segment` as Route}
          className="font-medium underline"
        >
          Choose the business&apos;s segment
        </Link>
      </Callout>
    );
  }
  const playbooks = getKnowledge().playbooks;
  const [active, overrides] = await Promise.all([
    playbooks.getVersion(page.user, segment.id),
    playbooks.listOverrides(page.user, page.business.id),
  ]);
  if (active?.document == null) {
    return <Callout tone="warning">The {segment.name} playbook is not ready yet.</Callout>;
  }
  const own = new Map(overrides.map((override) => [override.section, override]));
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          {segment.name} playbook, version {active.version} <OriginBadge origin={active.origin} />
        </p>
        <Link href={`/playbooks/${segment.id}` as Route} className={buttonClass("secondary", "sm")}>
          Open the segment&apos;s playbook
        </Link>
      </div>
      {OVERRIDABLE_SECTIONS.map((section: PlaybookSection) => {
        const override = own.get(section);
        const ownContent = override?.content ?? null;
        const document =
          ownContent === null ? active.document! : { ...active.document!, [section]: ownContent };
        return (
          <Card key={section}>
            <CardHeader
              title={PLAYBOOK_SECTION_LABELS[section]}
              description={
                ownContent !== null ? (
                  <Badge tone="violet">This business&apos;s own version</Badge>
                ) : (
                  "The segment's version."
                )
              }
            />
            <CardBody className="space-y-3">
              {override?.content === null && (
                <Callout tone="warning">
                  The stored override of this section is invalid and ignored; the segment&apos;s
                  version applies.
                </Callout>
              )}
              {override?.baseVersion != null && override.baseVersion !== active.version && (
                <Callout tone="info">
                  Written against version {override.baseVersion}; the segment is now at version{" "}
                  {active.version}.
                </Callout>
              )}
              <PlaybookDocumentView
                document={document}
                sections={[section]}
                overridden={ownContent === null ? [] : [section]}
              />
              <OverrideEditor
                businessId={page.business.id}
                section={section}
                segmentContent={active.document![section]}
                ownContent={ownContent}
              />
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
