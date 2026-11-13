import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RefreshWhile } from "@/components/onboarding/refresh-while";
import { DiffView } from "@/components/playbook/diff-view";
import { PlaybookDocumentView } from "@/components/playbook/document-view";
import {
  EDITED_WITHOUT_MODEL,
  editedWithoutModel,
  OriginBadge,
  originExplanation,
} from "@/components/playbook/origin";
import { RegenerateButton, RollbackButton } from "@/components/playbook/version-actions";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaffSession } from "@/server/admin";
import { findVisibleSegment } from "@/server/admin/segments";
import { getKnowledge } from "@/server/knowledge";
import { getServerPipeline } from "@/server/pipeline";

export const metadata: Metadata = { title: "Playbook" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const positive = (value: string | undefined) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

/** A segment's playbook: the version in force, every version, the difference between two, rollback. */
export default async function SegmentPlaybookPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ segmentId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { segmentId } = await params;
  const session = await requireStaffSession(`/playbooks/${segmentId}`);
  const segment = await findVisibleSegment(session, segmentId);
  if (segment === null) notFound();
  const search = await searchParams;
  const playbooks = getKnowledge().playbooks;
  const [versions, generations] = await Promise.all([
    playbooks.listVersions(session.user, segment.id),
    playbooks.listGenerations(session.user, segment.id),
  ]);
  const active = versions.find((version) => version.isActive) ?? null;
  const wanted = positive(first(search["version"]));
  const shownVersion = wanted ?? active?.version;
  const shown =
    shownVersion === undefined
      ? null
      : await playbooks.getVersion(session.user, segment.id, shownVersion);
  const from = positive(first(search["from"]));
  const to = positive(first(search["to"]));
  const diff =
    from !== undefined && to !== undefined && from !== to
      ? await playbooks.diffVersions(session.user, segment.id, from, to).catch(() => null)
      : null;
  const generation = generations[0] ?? null;
  const generating =
    generation !== null && (generation.status === "pending" || generation.status === "running");
  const saved = positive(first(search["saved"]));
  const modelMode = getServerPipeline().modelMode;

  return (
    <div className="space-y-6">
      <RefreshWhile active={generating} />
      <PageHeader
        title={`${segment.name} playbook`}
        description="Shared by every business in the segment. Businesses can replace sections with their own on their Playbook tab."
        actions={
          <>
            <Link
              href={`/settings/segments/${segment.id}` as Route}
              className={buttonClass("secondary", "sm")}
            >
              Segment settings
            </Link>
            <RegenerateButton segmentId={segment.id} disabled={generating} />
            {active !== null && (
              <Link
                href={`/playbooks/${segment.id}/edit` as Route}
                className={buttonClass("primary", "sm")}
              >
                Edit
              </Link>
            )}
          </>
        }
      />
      {saved !== undefined && <Callout tone="success">Version {saved} saved and in force.</Callout>}
      {modelMode !== "live" && (
        <Callout tone="warning">
          This deployment has no Claude API key: regenerating stores the built-in starter playbook,
          not one written by the real model.
        </Callout>
      )}
      {generating && (
        <Callout tone="info" title="Researching and writing a new version…">
          The page updates by itself.
        </Callout>
      )}
      {generation?.status === "failed" && (
        <Callout tone="danger" title="The last generation failed">
          {generation.errorMessage ?? "No reason was recorded."}
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {shown === null ? (
            <Callout tone="warning">There is no version to show yet.</Callout>
          ) : (
            <Card>
              <CardHeader
                title={`Version ${shown.version}${shown.isActive ? " (in force)" : ""}`}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <OriginBadge origin={shown.origin} /> {shown.createdAt.slice(0, 10)}
                    {shown.changeNote !== null && <span>· {shown.changeNote}</span>}
                  </span>
                }
                actions={
                  !shown.isActive ? (
                    <RollbackButton
                      segmentId={segment.id}
                      toVersion={shown.version}
                      baseVersion={active?.version ?? null}
                    />
                  ) : undefined
                }
              />
              <CardBody className="space-y-3">
                <p className="text-sm text-slate-600">{originExplanation(shown.origin)}</p>
                {editedWithoutModel(versions, shown) && (
                  <Callout tone="warning">{EDITED_WITHOUT_MODEL}</Callout>
                )}
                {shown.issues.length > 0 && (
                  <Callout tone="warning" title="Notes on this version">
                    <ul className="list-disc pl-5">
                      {shown.issues.slice(0, 10).map((issue, index) => (
                        <li key={index}>
                          {issue.path === "" ? "" : `${issue.path}: `}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )}
                {shown.document === null ? (
                  <Callout tone="danger">This version cannot be read.</Callout>
                ) : (
                  <PlaybookDocumentView document={shown.document} />
                )}
              </CardBody>
            </Card>
          )}
          {diff !== null && (
            <Card>
              <CardHeader title={`What changed from version ${from} to version ${to}`} />
              <CardBody>
                <DiffView diff={diff} />
              </CardBody>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Versions" />
            <CardBody>
              <ol className="space-y-2 text-sm">
                {versions.map((version) => (
                  <li
                    key={version.version}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <Link
                      href={`/playbooks/${segment.id}?version=${version.version}` as Route}
                      className="font-medium text-blue-700 underline-offset-2 hover:underline"
                      aria-current={version.version === shown?.version ? "true" : undefined}
                    >
                      Version {version.version}
                    </Link>
                    <span className="flex flex-wrap gap-1">
                      {version.isActive && <Badge tone="green">In force</Badge>}
                      <OriginBadge origin={version.origin} />
                    </span>
                    {version.changeNote !== null && (
                      <span className="w-full truncate text-xs text-slate-500">
                        {version.changeNote}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
          {versions.length > 1 && (
            <Card>
              <CardHeader title="Compare versions" />
              <CardBody>
                <form method="get" className="space-y-2">
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-700">From</span>
                    <Select name="from" defaultValue={String(from ?? versions[1]?.version ?? "")}>
                      {versions.map((version) => (
                        <option key={version.version} value={version.version}>
                          Version {version.version}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-700">To</span>
                    <Select name="to" defaultValue={String(to ?? versions[0]?.version ?? "")}>
                      {versions.map((version) => (
                        <option key={version.version} value={version.version}>
                          Version {version.version}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {shownVersion !== undefined && (
                    <input type="hidden" name="version" value={shownVersion} />
                  )}
                  <button type="submit" className={buttonClass("secondary", "sm")}>
                    Show the changes
                  </button>
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
