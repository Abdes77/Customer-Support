import type { Metadata } from "next";

import { CsvImport } from "@/components/knowledge/csv-import";
import { type FactView, KnowledgeEditor } from "@/components/knowledge/knowledge-editor";
import { CrawlButton } from "@/components/onboarding/crawl-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireBusinessPage } from "@/server/admin";
import { getKnowledge } from "@/server/knowledge";

export const metadata: Metadata = { title: "Knowledge" };
export const dynamic = "force-dynamic";

const RUN_KINDS: Readonly<Record<string, string>> = {
  csv: "CSV file",
  api: "Import API",
  website_crawl: "Website",
};

/**
 * The business's facts: what the bot knows about services, area, hours, licenses and the
 * rest. Agency staff edit and import; a client user reads.
 */
export default async function KnowledgePage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, {
    next: `/businesses/${businessId}/knowledge`,
  });
  const knowledge = getKnowledge().knowledge;
  const [items, imports] = await Promise.all([
    knowledge.list(page.user, page.business.id, { status: "all" }),
    page.staff ? knowledge.listImports(page.user, page.business.id, 10) : Promise.resolve([]),
  ]);
  const facts: FactView[] = items.map((item) => ({
    id: item.id,
    category: item.category,
    title: item.title,
    content: item.content,
    source: item.source,
    pinned: item.pinned,
    status: item.status,
    handEdited: item.handEdited,
    stale: item.stale,
    updatedAt: item.updatedAt,
  }));

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-slate-600">
        {page.staff
          ? "What the bot may tell customers about this business. Imported facts are updated by the next import unless a person edited them; facts from the website never replace imported or hand-written ones."
          : "What the bot tells customers about your business. Ask your agency to change anything here."}
      </p>
      <KnowledgeEditor businessId={page.business.id} facts={facts} editable={page.staff} />
      {page.staff && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Import a CSV file"
              description="Facts from the agency's lead-generation data."
            />
            <CardBody className="space-y-4">
              <CsvImport businessId={page.business.id} />
              {page.business.websiteUrl !== null && (
                <div className="border-t border-slate-100 pt-4">
                  <CrawlButton businessId={page.business.id} />
                </div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recent imports" />
            <CardBody>
              {imports.length === 0 ? (
                <p className="text-sm text-slate-600">No imports yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {imports.map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="min-w-0 truncate text-slate-800">
                        {RUN_KINDS[run.kind] ?? run.kind}
                        {run.fileName !== null ? `: ${run.fileName}` : ""}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-slate-500">
                        {run.createdAt.slice(0, 16).replace("T", " ")}
                        <Badge
                          tone={
                            run.status === "succeeded"
                              ? "green"
                              : run.status === "failed"
                                ? "red"
                                : "amber"
                          }
                        >
                          {run.status.replaceAll("_", " ")}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
