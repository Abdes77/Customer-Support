import type { Metadata, Route } from "next";
import Link from "next/link";

import { CHANNEL_IDS, LEAD_STATUSES, ROUTING_OUTCOMES } from "@repo/core";
import { listLeads } from "@repo/db";

import {
  channelLabel,
  formatDateTime,
  LEAD_STATUS_LABELS,
  LeadStatusBadge,
  ROUTING_LABELS,
  ScoreBadge,
} from "@/components/inbox/labels";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { requireAccess, userDatabase } from "@/server/auth";
import { leadFilterFrom, leadQueryString } from "@/server/leads";
import { businessIdsFor, screenBusinesses } from "@/server/portal";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * Every lead the person may see, with score, status, routing and (where allowed) the report's
 * summary; filters are GET parameters, and the export downloads the same filtered list as CSV
 * for the businesses whose settings allow it.
 */
export default async function LeadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAccess("/leads");
  const allowed = await screenBusinesses(session, "leads");
  const exportable = await screenBusinesses(session, "export");
  const conversationsAllowed = new Set(
    allowed
      .filter((business) => business.permissions.viewConversations)
      .map((business) => business.id),
  );
  const { filter, page } = leadFilterFrom(await searchParams, allowed);
  const includeReports =
    allowed.length > 0 && allowed.every((business) => business.permissions.viewReports);
  const result = await userDatabase(session.user).run((ctx) =>
    listLeads(ctx, {
      ...filter,
      businessIds: businessIdsFor(session, allowed),
      includeReports,
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
  );
  const pageHref = (target: number) =>
    `/leads?${leadQueryString(filter, { page: String(target) })}` as Route;

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Every lead with its score, status and what the bot told them."
        actions={
          exportable.length > 0 ? (
            <a
              href={`/api/leads/export?${leadQueryString(filter)}`}
              className={buttonClass("secondary")}
              data-testid="export-csv"
            >
              Download CSV
            </a>
          ) : undefined
        }
      />
      {allowed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="font-medium text-slate-800">There are no leads for you to see.</p>
        </div>
      ) : (
        <>
          <form
            method="get"
            role="search"
            className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
          >
            <div className="sm:col-span-2">
              <label htmlFor="q" className="sr-only">
                Search leads
              </label>
              <Input
                id="q"
                name="q"
                type="search"
                placeholder="Search name, phone or email"
                defaultValue={filter.q ?? ""}
              />
            </div>
            {allowed.length > 1 && (
              <div>
                <label htmlFor="business" className="sr-only">
                  Business
                </label>
                <Select id="business" name="business" defaultValue={filter.businessId ?? ""}>
                  <option value="">All businesses</option>
                  {allowed.map((business) => (
                    <option key={business.id} value={business.id}>
                      {business.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <label htmlFor="status" className="sr-only">
                Status
              </label>
              <Select id="status" name="status" defaultValue={filter.status ?? ""}>
                <option value="">Any status</option>
                {LEAD_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {LEAD_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="outcome" className="sr-only">
                Routing
              </label>
              <Select id="outcome" name="outcome" defaultValue={filter.outcome ?? ""}>
                <option value="">Any routing</option>
                {ROUTING_OUTCOMES.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {ROUTING_LABELS[outcome]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="channel" className="sr-only">
                Channel
              </label>
              <Select id="channel" name="channel" defaultValue={filter.channel ?? ""}>
                <option value="">All channels</option>
                {CHANNEL_IDS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channelLabel(channel)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="from">
                From
              </label>
              <Input
                id="from"
                name="from"
                type="date"
                defaultValue={filter.from ?? ""}
                aria-label="Created from"
              />
              <label className="sr-only" htmlFor="to">
                To
              </label>
              <Input
                id="to"
                name="to"
                type="date"
                defaultValue={filter.to ?? ""}
                aria-label="Created until"
              />
            </div>
            <div>
              <label htmlFor="sort" className="sr-only">
                Sort
              </label>
              <Select id="sort" name="sort" defaultValue={filter.sort ?? "newest"}>
                <option value="newest">Newest first</option>
                <option value="score">Highest score first</option>
              </Select>
            </div>
            <div className="flex gap-2">
              <button type="submit" className={buttonClass("secondary")}>
                Filter
              </button>
              <Link href="/leads" className={buttonClass("ghost")}>
                Clear
              </Link>
            </div>
          </form>

          {result.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <p className="font-medium text-slate-800">No lead matches.</p>
            </div>
          ) : (
            <ul
              aria-label="Leads"
              className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              {result.rows.map((lead) => {
                const body = (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-medium text-slate-900">
                        {lead.contactName ?? "Unknown customer"}
                      </span>
                      <ScoreBadge score={lead.score} band={lead.band} />
                      <LeadStatusBadge status={lead.status} />
                      <span className="ml-auto text-xs text-slate-500">
                        {formatDateTime(lead.createdAt)}
                      </span>
                    </div>
                    {lead.summary !== null && (
                      <p className="line-clamp-2 text-sm break-words text-slate-600">
                        {lead.summary}
                      </p>
                    )}
                    <p className="flex flex-wrap gap-x-2 text-xs text-slate-500">
                      <span>{channelLabel(lead.channel)}</span>
                      {allowed.length > 1 && <span>· {lead.businessName}</span>}
                      {lead.routingOutcome !== null && (
                        <span>
                          ·{" "}
                          {ROUTING_LABELS[lead.routingOutcome as keyof typeof ROUTING_LABELS] ??
                            lead.routingOutcome}
                        </span>
                      )}
                      {lead.phone !== null && <span className="break-all">· {lead.phone}</span>}
                      {lead.email !== null && <span className="break-all">· {lead.email}</span>}
                    </p>
                  </>
                );
                return (
                  <li key={lead.id} data-testid="lead-row">
                    {conversationsAllowed.has(lead.businessId) ? (
                      <Link
                        href={`/inbox/${lead.conversationId}` as Route}
                        className="flex flex-col gap-1.5 px-4 py-3 hover:bg-slate-50 sm:px-6"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="flex flex-col gap-1.5 px-4 py-3 sm:px-6">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <nav aria-label="Pages" className="mt-4 flex justify-between">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className={buttonClass("secondary", "sm")}>
                Previous
              </Link>
            ) : (
              <span />
            )}
            {result.more && (
              <Link href={pageHref(page + 1)} className={buttonClass("secondary", "sm")}>
                Next
              </Link>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
