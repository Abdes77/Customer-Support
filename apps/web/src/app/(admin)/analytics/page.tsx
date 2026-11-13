import type { Metadata } from "next";

import { type AnalyticsSummary, computeAnalytics, FUNNEL_STEPS, type FunnelStep } from "@repo/db";

import { channelLabel } from "@/components/inbox/labels";
import { buttonClass } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { requireAccess, userDatabase } from "@/server/auth";
import { businessIdsFor, screenBusinesses } from "@/server/portal";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const PERIODS = [7, 30, 90, 365] as const;

const STEP_LABELS: Readonly<Record<FunnelStep, string>> = {
  started: "Wrote to us",
  answered: "Got an answer",
  engaged: "Replied to the bot",
  qualified: "Qualified",
  booked: "Booked a meeting",
};

function duration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function percent(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

function Tile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={testId}>
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums" data-value>
        {value}
      </p>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  testId,
}: {
  readonly title: string;
  readonly rows: readonly (AnalyticsSummary & { readonly key: string; readonly label: string })[];
  readonly testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader title={title} />
      <CardBody className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No conversations in this period.</p>
        ) : (
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">
                  {title.replace("By ", "").replace(/^./, (c) => c.toUpperCase())}
                </th>
                <th className="py-2 pr-4 text-right font-medium">Conversations</th>
                <th className="py-2 pr-4 text-right font-medium">First response</th>
                <th className="py-2 pr-4 text-right font-medium">Qualified</th>
                <th className="py-2 pr-4 text-right font-medium">Booked</th>
                <th className="py-2 font-medium">Most stop after</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-slate-100" data-row={row.key}>
                  <td className="py-2 pr-4 font-medium break-words text-slate-900">{row.label}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.conversations}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {duration(row.firstResponseMedianSeconds)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {row.qualified} ({percent(row.qualificationRate)})
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.bookedMeetings}</td>
                  <td className="py-2 text-slate-600">
                    {row.dropOffStep === null ? "–" : STEP_LABELS[row.dropOffStep.after]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Conversations, first-response time, qualification rate, booked meetings and where
 * conversations stop, for the businesses the person may see analytics of (C16). Computed from
 * the stored rows as the signed-in person, so row-level security applies to every number.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAccess("/analytics");
  const allowed = await screenBusinesses(session, "analytics");
  const params = await searchParams;
  const days = PERIODS.find((value) => String(value) === first(params["days"])) ?? 30;
  const business = allowed.find((item) => item.id === first(params["business"]));
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  const scoped = business === undefined ? businessIdsFor(session, allowed) : [business.id];
  const report =
    allowed.length === 0
      ? null
      : await userDatabase(session.user).run((ctx) =>
          computeAnalytics(ctx, { from, to, businessIds: scoped }),
        );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Conversations that started in the chosen period."
      />
      {report === null ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="font-medium text-slate-800">There are no analytics for you to see.</p>
        </div>
      ) : (
        <>
          <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-48">
              <label htmlFor="days" className="sr-only">
                Period
              </label>
              <Select id="days" name="days" defaultValue={String(days)}>
                {PERIODS.map((value) => (
                  <option key={value} value={value}>
                    Last {value} days
                  </option>
                ))}
              </Select>
            </div>
            {allowed.length > 1 && (
              <div className="sm:w-64">
                <label htmlFor="business" className="sr-only">
                  Business
                </label>
                <Select id="business" name="business" defaultValue={business?.id ?? ""}>
                  <option value="">All businesses</option>
                  {allowed.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <button type="submit" className={buttonClass("secondary")}>
              Show
            </button>
          </form>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Tile
              testId="kpi-conversations"
              label="Conversations"
              value={String(report.total.conversations)}
            />
            <Tile
              testId="kpi-first-response"
              label="First response (median)"
              value={duration(report.total.firstResponseMedianSeconds)}
              hint={`Mean ${duration(report.total.firstResponseMeanSeconds)}`}
            />
            <Tile
              testId="kpi-qualification"
              label="Qualification rate"
              value={percent(report.total.qualificationRate)}
              hint={`${report.total.qualified} qualified`}
            />
            <Tile
              testId="kpi-booked"
              label="Booked meetings"
              value={String(report.total.bookedMeetings)}
            />
            <Tile
              testId="kpi-drop-off"
              label="Most stop after"
              value={
                report.total.dropOffStep === null
                  ? "–"
                  : STEP_LABELS[report.total.dropOffStep.after]
              }
              hint={
                report.total.dropOffStep === null
                  ? undefined
                  : `${report.total.dropOffStep.lost} conversation${report.total.dropOffStep.lost === 1 ? "" : "s"}`
              }
            />
          </div>

          <Card data-testid="funnel">
            <CardHeader
              title="Where conversations stop"
              description="How far each conversation got."
            />
            <CardBody>
              <ol className="space-y-3">
                {FUNNEL_STEPS.map((step) => {
                  const reached = report.total.reached[step];
                  const share =
                    report.total.conversations === 0 ? 0 : reached / report.total.conversations;
                  return (
                    <li key={step} data-step={step}>
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="text-slate-800">{STEP_LABELS[step]}</span>
                        <span className="text-slate-600 tabular-nums">
                          {reached}
                          {step !== "booked" &&
                            report.total.stoppedAt[step] > 0 &&
                            ` · ${report.total.stoppedAt[step]} stopped here`}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-100" aria-hidden="true">
                        <div
                          className="h-2 rounded-full bg-blue-600"
                          style={{ width: `${Math.round(share * 100)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardBody>
          </Card>

          {allowed.length > 1 && business === undefined && (
            <Breakdown title="By business" rows={report.byBusiness} testId="by-business" />
          )}
          <Breakdown
            title="By channel"
            rows={report.byChannel.map((row) => ({ ...row, label: channelLabel(row.key) }))}
            testId="by-channel"
          />
          {session.access.agencies.length > 0 && (
            <Breakdown title="By segment" rows={report.bySegment} testId="by-segment" />
          )}
        </>
      )}
    </div>
  );
}
