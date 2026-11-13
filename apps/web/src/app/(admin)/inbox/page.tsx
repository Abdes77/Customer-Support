import type { Metadata, Route } from "next";
import Link from "next/link";

import { CHANNEL_IDS } from "@repo/core";
import { listInbox } from "@repo/db";

import {
  ago,
  channelLabel,
  currentTime,
  LeadStatusBadge,
  ScoreBadge,
} from "@/components/inbox/labels";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { requireAccess, userDatabase } from "@/server/auth";
import { businessIdsFor, screenBusinesses } from "@/server/portal";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const PAGE = 50;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Every conversation the person may read, across channels and businesses, newest first:
 * agency staff see their agency's, a client user their own business's when its settings let
 * them. Filters are GET parameters; the list refreshes itself (Realtime or polling).
 */
export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAccess("/inbox");
  const allowed = await screenBusinesses(session, "conversations");
  const staff = session.access.agencies.length > 0;
  const params = await searchParams;
  const business = allowed.find((item) => item.id === first(params["business"]))?.id;
  const channel = CHANNEL_IDS.find((item) => item === first(params["channel"]));
  const status =
    (["open", "closed", "all"] as const).find((s) => s === first(params["status"])) ?? "open";
  const assigned =
    (["any", "me", "unassigned"] as const).find((s) => s === first(params["assigned"])) ?? "any";
  const unread = first(params["unread"]) === "1";
  const takenOver = first(params["takeover"]) === "1";
  const q = (first(params["q"]) ?? "").trim().slice(0, 100);
  const page = Math.min(Math.max(Number.parseInt(first(params["page"]) ?? "1", 10) || 1, 1), 2000);

  const result = await userDatabase(session.user).run((ctx) =>
    listInbox(ctx, {
      businessIds: businessIdsFor(session, allowed),
      ...(business === undefined ? {} : { businessId: business }),
      ...(channel === undefined ? {} : { channel }),
      status,
      assigned: staff ? assigned : "any",
      unread,
      takenOver,
      ...(q === "" ? {} : { q }),
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
  );
  const now = currentTime();
  // Lead scores only where the person may see leads (client_portal.view_leads).
  const leadsVisible = new Set(
    allowed.filter((item) => item.permissions.viewLeads).map((item) => item.id),
  );
  const query = (overrides: Record<string, string>) => {
    const next = new URLSearchParams();
    const base: Record<string, string> = {
      ...(business === undefined ? {} : { business }),
      ...(channel === undefined ? {} : { channel }),
      ...(status === "open" ? {} : { status }),
      ...(assigned === "any" ? {} : { assigned }),
      ...(unread ? { unread: "1" } : {}),
      ...(takenOver ? { takeover: "1" } : {}),
      ...(q === "" ? {} : { q }),
      ...overrides,
    };
    for (const [key, value] of Object.entries(base)) if (value !== "") next.set(key, value);
    const text = next.toString();
    return (text === "" ? "/inbox" : `/inbox?${text}`) as Route;
  };

  return (
    <div>
      <PageHeader
        title="Inbox"
        description={
          staff
            ? "Every conversation across your businesses and channels. Open one to read it, take it over and reply."
            : "Your business's conversations with customers."
        }
        actions={
          <LiveRefresh channel="inbox" pollSeconds={10} tables={[{ table: "conversations" }]} />
        }
      />
      {allowed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="font-medium text-slate-800">There are no conversations for you to see.</p>
          <p className="mt-2 text-sm text-slate-600">
            Your agency decides what your login can see. Ask them if you expected conversations
            here.
          </p>
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
                Search conversations
              </label>
              <Input
                id="q"
                name="q"
                type="search"
                placeholder="Search names, phone, email or messages"
                defaultValue={q}
              />
            </div>
            {allowed.length > 1 && (
              <div>
                <label htmlFor="business" className="sr-only">
                  Business
                </label>
                <Select id="business" name="business" defaultValue={business ?? ""}>
                  <option value="">All businesses</option>
                  {allowed.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <label htmlFor="channel" className="sr-only">
                Channel
              </label>
              <Select id="channel" name="channel" defaultValue={channel ?? ""}>
                <option value="">All channels</option>
                {CHANNEL_IDS.map((item) => (
                  <option key={item} value={item}>
                    {channelLabel(item)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="status" className="sr-only">
                Status
              </label>
              <Select id="status" name="status" defaultValue={status}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">Open and closed</option>
              </Select>
            </div>
            {staff && (
              <div>
                <label htmlFor="assigned" className="sr-only">
                  Assigned
                </label>
                <Select id="assigned" name="assigned" defaultValue={assigned}>
                  <option value="any">Anyone</option>
                  <option value="me">Assigned to me</option>
                  <option value="unassigned">Unassigned</option>
                </Select>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-700">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  name="unread"
                  value="1"
                  defaultChecked={unread}
                  className="size-4 accent-blue-700"
                />
                Unread
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  name="takeover"
                  value="1"
                  defaultChecked={takenOver}
                  className="size-4 accent-blue-700"
                />
                Taken over
              </label>
            </div>
            <div className="flex gap-2">
              <button type="submit" className={buttonClass("secondary")}>
                Filter
              </button>
              <Link href="/inbox" className={buttonClass("ghost")}>
                Clear
              </Link>
            </div>
          </form>

          {result.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <p className="font-medium text-slate-800">No conversation matches.</p>
            </div>
          ) : (
            <ul
              aria-label="Conversations"
              className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              {result.rows.map((row) => (
                <li key={row.id} data-testid="inbox-row">
                  <Link
                    href={`/inbox/${row.id}` as Route}
                    className="flex flex-col gap-1.5 px-4 py-3 hover:bg-slate-50 sm:px-6"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={
                          row.unreadCount > 0
                            ? "min-w-0 truncate font-semibold text-slate-900"
                            : "min-w-0 truncate font-medium text-slate-800"
                        }
                      >
                        {row.contactName ?? "Unknown customer"}
                      </span>
                      {row.unreadCount > 0 && <Badge tone="blue">{row.unreadCount} unread</Badge>}
                      {row.takenOver && <Badge tone="amber">Taken over</Badge>}
                      {row.status === "closed" && <Badge tone="neutral">Closed</Badge>}
                      <span className="ml-auto text-xs text-slate-500">
                        {ago(row.lastMessageAt, now)}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-sm break-words text-slate-600">
                      {row.lastMessageAuthor === "customer"
                        ? ""
                        : row.lastMessageAuthor === "human_agent"
                          ? "Team: "
                          : "Bot: "}
                      {row.lastMessageText ??
                        row.subject ??
                        (row.lastMessageAuthor === null ? "" : "A photo or file")}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{channelLabel(row.channel)}</span>
                      {allowed.length > 1 && <span className="truncate">· {row.businessName}</span>}
                      {staff && row.assignedUserName !== null && (
                        <span>· {row.assignedUserName}</span>
                      )}
                      {leadsVisible.has(row.businessId) && (
                        <>
                          <ScoreBadge score={row.leadScore} band={row.leadBand} />
                          <LeadStatusBadge status={row.leadStatus} />
                        </>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Pages" className="mt-4 flex justify-between">
            {page > 1 ? (
              <Link
                href={query({ page: String(page - 1) })}
                className={buttonClass("secondary", "sm")}
              >
                Newer
              </Link>
            ) : (
              <span />
            )}
            {result.more && (
              <Link
                href={query({ page: String(page + 1) })}
                className={buttonClass("secondary", "sm")}
              >
                Older
              </Link>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
