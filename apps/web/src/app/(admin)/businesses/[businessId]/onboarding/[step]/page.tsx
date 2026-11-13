import { randomUUID } from "node:crypto";

import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { updateProfileAction } from "@/app/(admin)/_actions/business";
import { DevChat } from "@/app/dev/chat/chat";
import { AlertContacts } from "@/components/alerts/alert-contacts";
import { ReadinessPanel } from "@/components/alerts/readiness-panel";
import { ProfileForm } from "@/components/business/profile-form";
import { CsvImport } from "@/components/knowledge/csv-import";
import { ActivateForm } from "@/components/onboarding/activate-form";
import { CrawlButton } from "@/components/onboarding/crawl-button";
import { RefreshWhile } from "@/components/onboarding/refresh-while";
import { SegmentPicker } from "@/components/onboarding/segment-picker";
import { WIZARD_STEPS, type WizardStep, WizardSteps } from "@/components/onboarding/wizard-steps";
import { PlaybookDocumentView } from "@/components/playbook/document-view";
import { OriginBadge, originExplanation } from "@/components/playbook/origin";
import { buttonClass } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { type BusinessPage, requireBusinessPage } from "@/server/admin";
import { loadOnboarding, type OnboardingState } from "@/server/admin/onboarding";
import { getKnowledge } from "@/server/knowledge";
import { getServerPipeline } from "@/server/pipeline";

export const metadata: Metadata = { title: "Onboarding" };
export const dynamic = "force-dynamic";

type Params = Promise<{ businessId: string; step: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const VISITOR = /^[A-Za-z0-9_-]{8,64}$/;

function stepHref(businessId: string, step: WizardStep): Route {
  return `/businesses/${businessId}/onboarding/${step}` as Route;
}

function NextLink({
  businessId,
  step,
  label,
}: {
  businessId: string;
  step: WizardStep;
  label?: string;
}) {
  return (
    <Link href={stepHref(businessId, step)} className={buttonClass("primary")}>
      {label ?? "Continue"}
    </Link>
  );
}

const MODEL_NOTE = {
  live: null,
  offline:
    "This deployment has no Claude API key, so nothing here is written by the real model: a new segment gets the built-in starter playbook, and the test chat answers with the offline stand-in.",
  unconfigured:
    "The Claude API is not configured on this deployment: playbook generation and the bot's replies will fail until a key is set (docs/HUMAN_TODO.md).",
} as const;

/**
 * The onboarding wizard (C15): profile, segment, business data, playbook, alert contacts,
 * test chat, finish. Agency staff only. Every step can be revisited; the state of each one
 * is read from the services that own it.
 */
export default async function OnboardingStepPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { businessId, step: rawStep } = await params;
  const step = WIZARD_STEPS.find((candidate) => candidate.id === rawStep)?.id;
  const page = await requireBusinessPage(businessId, {
    staffOnly: true,
    next: `/businesses/${businessId}/onboarding/${rawStep}`,
  });
  if (step === undefined) notFound();
  const search = await searchParams;
  const state = await loadOnboarding(page);
  const modelNote = MODEL_NOTE[getServerPipeline().modelMode];

  let body: ReactNode;
  switch (step) {
    case "profile":
      body = <ProfileStep page={page} />;
      break;
    case "segment":
      body = await SegmentStep({ page });
      break;
    case "import":
      body = <ImportStep page={page} state={state} assigned={first(search["assigned"])} />;
      break;
    case "playbook":
      body = <PlaybookStep page={page} state={state} modelNote={modelNote} />;
      break;
    case "alerts":
      body = (
        <Card>
          <CardHeader
            title="Alert contacts"
            description="Who hears about new leads, and who is alerted, then called, when a customer reports an emergency."
          />
          <CardBody className="space-y-4">
            <AlertContacts page={page} />
            <NextLink businessId={page.business.id} step="test" />
          </CardBody>
        </Card>
      );
      break;
    case "test": {
      const visitor = first(search["visitor"]);
      if (visitor === undefined || !VISITOR.test(visitor)) {
        redirect(
          `${stepHref(page.business.id, "test")}?visitor=onboarding-${randomUUID()}` as Route,
        );
      }
      body = <TestStep page={page} visitor={visitor} modelNote={modelNote} />;
      break;
    }
    case "finish":
      body = <FinishStep page={page} state={state} />;
      break;
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <WizardSteps businessId={page.business.id} current={step} statuses={state.statuses} />
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

function ProfileStep({ page }: { readonly page: BusinessPage }) {
  const b = page.business;
  return (
    <Card>
      <CardHeader title="Profile" description="Who the business is and where it works." />
      <CardBody>
        <ProfileForm
          action={updateProfileAction}
          businessId={b.id}
          submitLabel={b.status === "onboarding" ? "Save and continue" : "Save"}
          initial={{
            name: b.name,
            timezone: b.timezone,
            websiteUrl: b.websiteUrl ?? "",
            phone: b.phone ?? "",
            email: b.email ?? "",
            addressLine1: b.addressLine1 ?? "",
            addressLine2: b.addressLine2 ?? "",
            city: b.city ?? "",
            state: b.state ?? "",
            postalCode: b.postalCode ?? "",
          }}
        />
      </CardBody>
    </Card>
  );
}

async function SegmentStep({ page }: { readonly page: BusinessPage }) {
  const segments = await getKnowledge().playbooks.listSegments(page.user, page.business.agencyId);
  return (
    <Card>
      <CardHeader
        title="Segment"
        description="The kind of business. Each segment has one industry playbook: common jobs, how customers describe problems, urgency signals, the questions that qualify a lead, objections and price norms."
      />
      <CardBody>
        <SegmentPicker
          businessId={page.business.id}
          currentSegmentId={page.business.segment?.id ?? null}
          nextHref={`/businesses/${page.business.id}/onboarding/import`}
          segments={segments.map((entry) => ({
            id: entry.segment.id,
            name: entry.segment.name,
            activeVersion: entry.activeVersion,
            generating:
              entry.generation !== null &&
              (entry.generation.status === "pending" || entry.generation.status === "running"),
          }))}
        />
      </CardBody>
    </Card>
  );
}

function ImportStep({
  page,
  state,
  assigned,
}: {
  readonly page: BusinessPage;
  readonly state: OnboardingState;
  readonly assigned: string | undefined;
}) {
  return (
    <Card>
      <CardHeader
        title="Business data"
        description="Import what the agency's lead-generation data knows about the business: services, service area, hours, licenses, warranties, financing and more. You can also skip this and add facts by hand later."
      />
      <CardBody className="space-y-5">
        {assigned === "reused" && (
          <Callout tone="success" title="Segment saved">
            The segment&apos;s existing playbook is reused for this business.
          </Callout>
        )}
        {assigned === "generating" && (
          <Callout tone="info" title="Segment saved">
            The segment&apos;s playbook is being written now. You will review it in the playbook
            step.
          </Callout>
        )}
        <p className="text-sm text-slate-700" data-testid="fact-count">
          {state.facts.length === 0
            ? "No facts yet."
            : `${state.facts.length} ${state.facts.length === 1 ? "fact" : "facts"} so far.`}{" "}
          <Link
            href={`/businesses/${page.business.id}/knowledge` as Route}
            className="font-medium text-blue-700 underline"
          >
            Open the knowledge editor
          </Link>
        </p>
        <CsvImport businessId={page.business.id} />
        {page.business.websiteUrl !== null && (
          <div className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-sm text-slate-700">
              Or collect facts from the business&apos;s own website (when &quot;Read the business
              website&quot; is on in its settings).
            </p>
            <CrawlButton businessId={page.business.id} />
          </div>
        )}
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <NextLink
            businessId={page.business.id}
            step="playbook"
            label={state.facts.length === 0 ? "Skip for now" : "Continue"}
          />
        </div>
      </CardBody>
    </Card>
  );
}

function PlaybookStep({
  page,
  state,
  modelNote,
}: {
  readonly page: BusinessPage;
  readonly state: OnboardingState;
  readonly modelNote: string | null;
}) {
  const segment = page.business.segment;
  if (segment === null) {
    return (
      <Card>
        <CardHeader title="Playbook" />
        <CardBody>
          <Callout tone="warning" title="Choose a segment first">
            The playbook belongs to the business&apos;s segment.{" "}
            <Link href={stepHref(page.business.id, "segment")} className="font-medium underline">
              Choose the segment
            </Link>
          </Callout>
        </CardBody>
      </Card>
    );
  }
  const generation = state.generation;
  const generating =
    generation !== null && (generation.status === "pending" || generation.status === "running");
  const playbook = state.playbook;
  return (
    <Card>
      <CardHeader
        title={`Playbook: ${segment.name}`}
        description="Review the industry playbook the bot will follow. It is shared by every business in the segment; this business can replace sections with its own."
        actions={
          <Link
            href={`/playbooks/${segment.id}` as Route}
            className={buttonClass("secondary", "sm")}
          >
            Open in the playbook editor
          </Link>
        }
      />
      <CardBody className="space-y-4">
        <RefreshWhile active={generating} />
        {modelNote !== null && <Callout tone="warning">{modelNote}</Callout>}
        {generating && (
          <Callout
            tone="info"
            title="Researching and writing the playbook…"
            testId="playbook-generating"
          >
            This takes a few minutes with the Claude API. The page updates by itself.
          </Callout>
        )}
        {generation?.status === "failed" && playbook === null && (
          <Callout tone="danger" title="The playbook could not be generated">
            {generation.errorMessage ?? "The generation failed."} Open the playbook editor to try
            again.
          </Callout>
        )}
        {playbook !== null && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="playbook-origin">
              <span className="text-sm font-medium text-slate-900">Version {playbook.version}</span>
              <OriginBadge origin={playbook.origin} />
            </div>
            <p className="text-sm text-slate-700">{originExplanation(playbook.origin)}</p>
            {playbook.document === null ? (
              <Callout tone="danger">
                This version cannot be read. Open the playbook editor.
              </Callout>
            ) : (
              <PlaybookDocumentView document={playbook.document} />
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <NextLink businessId={page.business.id} step="alerts" />
          <Link
            href={`/businesses/${page.business.id}/playbook` as Route}
            className={buttonClass("secondary")}
          >
            Override sections for this business
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function TestStep({
  page,
  visitor,
  modelNote,
}: {
  readonly page: BusinessPage;
  readonly visitor: string;
  readonly modelNote: string | null;
}) {
  const server = getServerPipeline();
  return (
    <Card>
      <CardHeader
        title="Test chat"
        description="Write to the bot as a customer would. Messages go through the test channel and the real pipeline, with this business's knowledge, playbook and settings."
        actions={
          <Link
            href={stepHref(page.business.id, "test")}
            className={buttonClass("secondary", "sm")}
          >
            New conversation
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {modelNote !== null && <Callout tone="warning">{modelNote}</Callout>}
        <DevChat
          key={visitor}
          businessId={page.business.id}
          visitorId={visitor}
          available={server.testChannel !== null}
        />
        <div className="border-t border-slate-100 pt-4">
          <NextLink businessId={page.business.id} step="finish" />
        </div>
      </CardBody>
    </Card>
  );
}

function FinishStep({
  page,
  state,
}: {
  readonly page: BusinessPage;
  readonly state: OnboardingState;
}) {
  const b = page.business;
  const items: { label: string; ok: boolean; detail: string; step: WizardStep }[] = [
    { label: "Profile", ok: true, detail: b.name, step: "profile" },
    {
      label: "Segment",
      ok: b.segment !== null,
      detail: b.segment?.name ?? "Not chosen yet: the business cannot go live without one.",
      step: "segment",
    },
    {
      label: "Business data",
      ok: state.facts.length > 0,
      detail:
        state.facts.length > 0
          ? `${state.facts.length} facts`
          : "No facts yet: the bot knows only the profile and the playbook.",
      step: "import",
    },
    {
      label: "Playbook",
      ok: state.playbook !== null,
      detail:
        state.playbook === null
          ? "Not ready yet."
          : `Version ${state.playbook.version}${state.playbook.origin === "starter" ? " (built-in starter, not generated by the real model)" : ""}`,
      step: "playbook",
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Finish"
        description="Check what is in place, then let the bot answer this business's customers."
      />
      <CardBody className="space-y-5">
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {items.map((item) => (
            <li key={item.label} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">
                  <span
                    aria-hidden="true"
                    className={item.ok ? "text-emerald-600" : "text-amber-600"}
                  >
                    {item.ok ? "✓" : "•"}
                  </span>{" "}
                  {item.label}
                </p>
                <p className="text-sm break-words text-slate-600">{item.detail}</p>
              </div>
              <Link
                href={stepHref(b.id, item.step)}
                className="shrink-0 text-sm font-medium text-blue-700 underline"
              >
                Edit
              </Link>
            </li>
          ))}
        </ul>
        <ReadinessPanel readiness={state.readiness} />
        {b.status === "onboarding" ? (
          b.segment === null ? (
            <Callout tone="warning">Choose the segment before activating the business.</Callout>
          ) : (
            <ActivateForm
              businessId={b.id}
              emergencyReady={!state.readiness.enabled || state.readiness.ready}
            />
          )
        ) : (
          <Callout tone="success" title="The business is live">
            <Link href={`/businesses/${b.id}` as Route} className="font-medium underline">
              Go to its overview
            </Link>
          </Callout>
        )}
      </CardBody>
    </Card>
  );
}
