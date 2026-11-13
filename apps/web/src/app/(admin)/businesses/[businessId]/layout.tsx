import type { ReactNode } from "react";

import { StatusBadge } from "@/components/business/status";
import { type NavItem, TabNav } from "@/components/shell/nav";
import { requireBusinessPage } from "@/server/admin";
import { businessPeopleAccess } from "@/server/people";

/**
 * The frame of one business: its name, status and the tabs. A business the person may not
 * see is "not found", whatever the reason.
 */
export default async function BusinessLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId);
  const { business, staff } = page;
  // Client logins: agency staff always; a client owner only when the settings let them manage
  // their staff (C18).
  const people =
    staff ||
    (page.role === "client_owner" && (await businessPeopleAccess(page, business.id)) !== null);
  const base = `/businesses/${business.id}`;
  const tabs: NavItem[] = [
    { href: base, label: "Overview", exact: true },
    ...(staff && business.status === "onboarding"
      ? [{ href: `${base}/onboarding`, label: "Onboarding" }]
      : []),
    { href: `${base}/knowledge`, label: "Knowledge" },
    ...(staff ? [{ href: `${base}/playbook`, label: "Playbook" }] : []),
    { href: `${base}/alerts`, label: "Alert contacts" },
    { href: `${base}/settings`, label: "Settings" },
    ...(people ? [{ href: `${base}/people`, label: "People" }] : []),
    ...(staff
      ? [
          { href: `${base}/channels`, label: "Channels" },
          { href: `${base}/integrations`, label: "Integrations" },
        ]
      : []),
  ];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-slate-500">
          {business.segment?.name ?? "No segment yet"}
        </p>
        <StatusBadge status={business.status} />
      </div>
      <p className="mb-3 text-xl font-semibold break-words text-slate-900 sm:text-2xl">
        {business.name}
      </p>
      <div className="mb-6">
        <TabNav items={tabs} label="Business" />
      </div>
      {children}
    </div>
  );
}
