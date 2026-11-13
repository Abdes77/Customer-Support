import type { Metadata, Route } from "next";
import Link from "next/link";

import { ReadinessPanel } from "@/components/alerts/readiness-panel";
import { StatusButton } from "@/components/business/status-button";
import { OriginBadge } from "@/components/playbook/origin";
import { buttonClass } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireBusinessPage } from "@/server/admin";
import { getHandoff } from "@/server/handoff";
import { getKnowledge } from "@/server/knowledge";

export const metadata: Metadata = { title: "Business" };
export const dynamic = "force-dynamic";

function Row({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{value ?? "—"}</dd>
    </div>
  );
}

/** One business at a glance: profile, emergency readiness, playbook and knowledge. */
export default async function BusinessOverviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ businessId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId);
  const { business, staff } = page;
  const activated = (await searchParams)["activated"] === "1";
  const knowledge = getKnowledge();
  const [readiness, facts, playbook] = await Promise.all([
    getHandoff().readiness(page.tenant),
    knowledge.knowledge.list(page.user, business.id, { status: "active" }),
    staff && business.segment !== null
      ? knowledge.playbooks.getVersion(page.user, business.segment.id)
      : Promise.resolve(null),
  ]);
  const address = [
    business.addressLine1,
    business.addressLine2,
    [business.city, [business.state, business.postalCode].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", "),
  ]
    .filter((part) => part !== null && part !== "")
    .join(", ");

  return (
    <div className="space-y-6">
      {activated && (
        <Callout tone="success" title="The business is live">
          The bot now answers this business&apos;s customers on its connected channels.
        </Callout>
      )}
      {business.status === "onboarding" && staff && (
        <Callout tone="info" title="Onboarding is not finished">
          <Link
            href={`/businesses/${business.id}/onboarding` as Route}
            className="font-medium underline"
          >
            Continue onboarding
          </Link>
        </Callout>
      )}
      <ReadinessPanel readiness={readiness} contactsHref={`/businesses/${business.id}/alerts`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Profile"
            actions={
              staff ? (
                <Link
                  href={`/businesses/${business.id}/onboarding/profile` as Route}
                  className={buttonClass("secondary", "sm")}
                >
                  Edit
                </Link>
              ) : undefined
            }
          />
          <CardBody>
            <dl className="divide-y divide-slate-100">
              <Row label="Website" value={business.websiteUrl} />
              <Row label="Phone" value={business.phone} />
              <Row label="Email" value={business.email} />
              <Row label="Address" value={address === "" ? null : address} />
              <Row label="Time zone" value={business.timezone} />
            </dl>
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Knowledge"
              actions={
                <Link
                  href={`/businesses/${business.id}/knowledge` as Route}
                  className={buttonClass("secondary", "sm")}
                >
                  Open
                </Link>
              }
            />
            <CardBody>
              <p className="text-sm text-slate-700">
                {facts.length} active {facts.length === 1 ? "fact" : "facts"}
                {facts.some((fact) => fact.stale)
                  ? `, ${facts.filter((fact) => fact.stale).length} due for review`
                  : ""}
                .
              </p>
            </CardBody>
          </Card>
          {staff && (
            <Card>
              <CardHeader
                title="Playbook"
                actions={
                  <Link
                    href={`/businesses/${business.id}/playbook` as Route}
                    className={buttonClass("secondary", "sm")}
                  >
                    Open
                  </Link>
                }
              />
              <CardBody>
                {business.segment === null ? (
                  <p className="text-sm text-slate-700">No segment yet.</p>
                ) : playbook === null ? (
                  <p className="text-sm text-slate-700">
                    {business.segment.name}: no playbook yet.
                  </p>
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                    {business.segment.name}, version {playbook.version}{" "}
                    <OriginBadge origin={playbook.origin} />
                  </p>
                )}
              </CardBody>
            </Card>
          )}
          {staff && (business.status === "active" || business.status === "paused") && (
            <Card>
              <CardHeader
                title="Status"
                description={
                  business.status === "active"
                    ? "Live: the bot answers this business's customers."
                    : "Paused: the bot does not answer this business's customers."
                }
              />
              <CardBody>
                <StatusButton
                  businessId={business.id}
                  status={business.status}
                  emergencyReady={!readiness.enabled || readiness.ready}
                />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
