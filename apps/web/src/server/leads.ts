import { type BusinessId, CHANNEL_IDS, LEAD_STATUSES, ROUTING_OUTCOMES } from "@repo/core";
import {
  csvLine,
  getDatabase,
  isCalendarDay,
  type LeadFilter,
  type LeadRow,
  listLeads,
  recordSystemAudit,
} from "@repo/db";

import { type SessionAccess, userDatabase } from "@/server/auth";
import { businessIdsFor, type ScreenBusiness, screenBusinesses } from "@/server/portal";

/*
 * The lead list's filters and its CSV export (C16). The page and the export read the same
 * GET parameters through `leadFilterFrom`, and both ask `screenBusinesses` which businesses
 * the person may see ("leads") or export ("export"), so the file never holds more than the
 * list would show.
 */

type Params = Readonly<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export interface LeadQuery {
  readonly filter: Omit<LeadFilter, "limit" | "offset">;
  readonly page: number;
}

/** The filters in the address, each checked against its vocabulary; anything else is dropped. */
export function leadFilterFrom(params: Params, allowed: readonly ScreenBusiness[]): LeadQuery {
  const business = allowed.find((item) => item.id === first(params["business"]))?.id;
  const status = LEAD_STATUSES.find((item) => item === first(params["status"]));
  const outcome = ROUTING_OUTCOMES.find((item) => item === first(params["outcome"]));
  const channel = CHANNEL_IDS.find((item) => item === first(params["channel"]));
  const band = (first(params["band"]) ?? "").trim().slice(0, 40);
  const from = first(params["from"]) ?? "";
  const to = first(params["to"]) ?? "";
  const q = (first(params["q"]) ?? "").trim().slice(0, 100);
  const sort = first(params["sort"]) === "score" ? "score" : "newest";
  const page = Math.min(Math.max(Number.parseInt(first(params["page"]) ?? "1", 10) || 1, 1), 2000);
  return {
    page,
    filter: {
      ...(business === undefined ? {} : { businessId: business }),
      ...(status === undefined ? {} : { status }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(channel === undefined ? {} : { channel }),
      ...(band === "" ? {} : { band }),
      ...(isCalendarDay(from) ? { from } : {}),
      ...(isCalendarDay(to) ? { to } : {}),
      ...(q === "" ? {} : { q }),
      sort,
    },
  };
}

/** The same filters as GET parameters (for the export link and paging). */
export function leadQueryString(
  filter: LeadQuery["filter"],
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  const values: Record<string, string | undefined> = {
    business: filter.businessId,
    status: filter.status,
    outcome: filter.outcome,
    channel: filter.channel,
    band: filter.band,
    from: filter.from,
    to: filter.to,
    q: filter.q,
    sort: filter.sort === "score" ? "score" : undefined,
    ...extra,
  };
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, value);
  return params.toString();
}

export const EXPORT_LIMIT = 5000;

const HEADER = [
  "Business",
  "Customer",
  "Phone",
  "Email",
  "Channel",
  "Status",
  "Score",
  "Band",
  "Routing",
  "Created (UTC)",
  "Qualified (UTC)",
];

/** The CSV of the person's export, or null when they may export nothing. */
export async function exportLeadsCsv(
  session: SessionAccess,
  params: Params,
): Promise<{ readonly csv: string; readonly count: number } | null> {
  const allowed = await screenBusinesses(session, "export");
  if (allowed.length === 0) return null;
  const { filter } = leadFilterFrom(params, allowed);
  const includeReports = allowed.every((business) => business.permissions.viewReports);
  const { rows } = await userDatabase(session.user).run((ctx) =>
    listLeads(ctx, {
      ...filter,
      businessIds: businessIdsFor(session, allowed),
      includeReports,
      limit: EXPORT_LIMIT,
    }),
  );
  const lines = [csvLine(includeReports ? [...HEADER, "Report summary"] : HEADER)];
  for (const row of rows) lines.push(csvLine(cells(row, includeReports)));
  // Who downloaded which business's leads, in each business's own log.
  const counts = new Map<BusinessId, number>();
  for (const row of rows) counts.set(row.businessId, (counts.get(row.businessId) ?? 0) + 1);
  for (const business of allowed) {
    const count = counts.get(business.id);
    if (count === undefined) continue;
    await getDatabase()
      .forBusiness(business.id, { agencyId: business.agencyId })
      .run((ctx) =>
        recordSystemAudit(
          ctx,
          { type: "user", userId: session.user.id, label: session.user.email },
          {
            action: "leads.export",
            targetType: "business",
            targetId: business.id,
            summary: `Downloaded ${count} lead${count === 1 ? "" : "s"} as CSV.`,
            metadata: { count },
          },
        ),
      );
  }
  return { csv: `\uFEFF${lines.join("\r\n")}\r\n`, count: rows.length };
}

function cells(row: LeadRow, includeReports: boolean): unknown[] {
  const base = [
    row.businessName,
    row.contactName,
    row.phone,
    row.email,
    row.channel,
    row.status,
    Math.round(row.score),
    row.band,
    row.routingOutcome,
    row.createdAt,
    row.qualifiedAt,
  ];
  return includeReports ? [...base, row.summary] : base;
}
