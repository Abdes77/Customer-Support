import type { Metadata, Route } from "next";
import Link from "next/link";

import { listAuditLog, listVisibleBusinesses } from "@repo/db";
import { findSetting } from "@repo/settings";

import { formatDateTime } from "@/components/inbox/labels";
import { AgencySwitcher } from "@/components/shell/agency-switcher";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { listStaffAgencies, requireStaffSession } from "@/server/admin";
import { userDatabase } from "@/server/auth";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE = 50;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** A stored value as one short line of text; sensitive settings never show theirs. */
function show(value: unknown, targetType: string | null, targetId: string | null): string {
  if (targetType === "setting" && targetId !== null && findSetting(targetId)?.sensitive === true) {
    return "[hidden: sensitive setting]";
  }
  if (value === null || value === undefined) return "–";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Who changed what and when (C16), for agency admins: row-level security lets admins read
 * their agency's entries and nobody else any. Values under secret-sounding names are hidden,
 * and sensitive settings show no value at all.
 */
export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireStaffSession("/audit", first(params["agency"]));
  if (session.agencyRole !== "agency_admin") {
    return (
      <div>
        <PageHeader title="Audit log" />
        <Callout tone="info">The audit log is for agency admins.</Callout>
      </div>
    );
  }
  const agencies = await listStaffAgencies(session);
  const businesses = (
    await userDatabase(session.user).run((ctx) =>
      listVisibleBusinesses(ctx, { includeArchived: true }),
    )
  ).filter((business) => business.agencyId === session.agencyId);
  const business = businesses.find((item) => item.id === first(params["business"]));
  const action = (first(params["action"]) ?? "").trim().slice(0, 60);
  const page = Math.min(Math.max(Number.parseInt(first(params["page"]) ?? "1", 10) || 1, 1), 2000);
  const result = await userDatabase(session.user).run((ctx) =>
    listAuditLog(ctx, {
      agencyId: session.agencyId,
      ...(business === undefined ? {} : { businessId: business.id }),
      ...(action === "" ? {} : { action }),
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
  );
  const href = (target: number) => {
    const query = new URLSearchParams({ agency: session.agencyId, page: String(target) });
    if (business !== undefined) query.set("business", business.id);
    if (action !== "") query.set("action", action);
    return `/audit?${query.toString()}` as Route;
  };

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every change to settings, knowledge, playbooks, businesses, connections, conversations and who has access."
      />
      <AgencySwitcher agencies={agencies} current={session.agencyId} path="/audit" />
      <form method="get" className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <input type="hidden" name="agency" value={session.agencyId} />
        <div className="sm:w-64">
          <label htmlFor="business" className="sr-only">
            Business
          </label>
          <Select id="business" name="business" defaultValue={business?.id ?? ""}>
            <option value="">All businesses</option>
            {businesses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1">
          <label htmlFor="action" className="sr-only">
            Action
          </label>
          <Input
            id="action"
            name="action"
            placeholder="Action starts with, e.g. settings."
            defaultValue={action}
          />
        </div>
        <button type="submit" className={buttonClass("secondary")}>
          Filter
        </button>
      </form>
      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="font-medium text-slate-800">No entries.</p>
        </div>
      ) : (
        <ul
          aria-label="Audit entries"
          className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          {result.rows.map((row) => (
            <li key={row.id} className="space-y-1 px-4 py-3 sm:px-6" data-testid="audit-row">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-slate-700">{row.action}</span>
                <Badge>
                  {row.actorType === "user"
                    ? (row.actorName ?? "A former user")
                    : (row.actorName ?? row.actorType)}
                </Badge>
                {row.businessName !== null && (
                  <span className="text-slate-600">{row.businessName}</span>
                )}
                <span className="ml-auto text-xs text-slate-500">
                  {formatDateTime(row.createdAt)}
                </span>
              </div>
              {row.summary !== null && (
                <p className="text-sm break-words text-slate-800">
                  {row.summary}
                  {row.targetType === "user" && (
                    <span className="text-slate-600">
                      {" "}
                      · {row.targetName ?? "a person no longer on the team"}
                    </span>
                  )}
                </p>
              )}
              {(row.before !== null || row.after !== null) && (
                <p className="text-xs break-all text-slate-500">
                  {show(row.before, row.targetType, row.targetId)} →{" "}
                  {show(row.after, row.targetType, row.targetId)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Pages" className="mt-4 flex justify-between">
        {page > 1 ? (
          <Link href={href(page - 1)} className={buttonClass("secondary", "sm")}>
            Newer
          </Link>
        ) : (
          <span />
        )}
        {result.more && (
          <Link href={href(page + 1)} className={buttonClass("secondary", "sm")}>
            Older
          </Link>
        )}
      </nav>
    </div>
  );
}
