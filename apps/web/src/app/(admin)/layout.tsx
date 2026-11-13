import type { ReactNode } from "react";

import type { Role } from "@repo/core";
import { listVisibleBusinesses } from "@repo/db";

import { AppShell } from "@/components/shell/app-shell";
import type { NavSection } from "@/components/shell/nav";
import { requireAccess, userDatabase } from "@/server/auth";
import { screenBusinesses } from "@/server/portal";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  agency_admin: "Agency admin",
  agency_member: "Agency member",
  client_owner: "Business owner",
  client_staff: "Business staff",
};

/**
 * The admin panel and client portal frame (C15). Navigation follows the role: agency staff
 * get the agency's screens, a client user only their own business and the operational screens
 * (C16) its client-portal settings allow; the audit log is for agency admins.
 */
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const { user, access } = await requireAccess();
  const staff = access.agencies.length > 0;
  const sections: NavSection[] = [];
  let roleLabel: string;
  if (staff) {
    roleLabel = ROLE_LABELS[access.agencies[0]!.role];
    sections.push({
      items: [
        { href: "/businesses", label: "Businesses" },
        { href: "/playbooks", label: "Playbooks" },
        { href: "/people", label: "People" },
        { href: "/settings", label: "Agency settings" },
      ],
    });
  } else {
    const own = await userDatabase(user).run((ctx) => listVisibleBusinesses(ctx));
    const role = access.businesses.find((membership) => membership.enabled)?.role;
    roleLabel = role === undefined ? "Client" : ROLE_LABELS[role];
    sections.push({
      items:
        own.length === 1
          ? [{ href: `/businesses/${own[0]!.id}`, label: "Your business" }]
          : [{ href: "/businesses", label: "Your businesses" }],
    });
  }
  // A client user sees the operational screens their business's client-portal settings
  // allow (C16); the pages check again on every request.
  const [inbox, leads, analytics] = staff
    ? [true, true, true]
    : await Promise.all(
        (["conversations", "leads", "analytics"] as const).map(
          async (screen) => (await screenBusinesses({ user, access }, screen)).length > 0,
        ),
      );
  const admin = access.agencies.some((agency) => agency.role === "agency_admin");
  const operations = [
    ...(inbox ? [{ href: "/inbox", label: "Inbox" }] : []),
    ...(leads ? [{ href: "/leads", label: "Leads" }] : []),
    ...(analytics ? [{ href: "/analytics", label: "Analytics" }] : []),
    ...(admin ? [{ href: "/audit", label: "Audit log" }] : []),
  ];
  if (operations.length > 0) sections.push({ title: "Operations", items: operations });
  if (staff) {
    sections.push({ title: "Tools", items: [{ href: "/dev/chat", label: "Test chat" }] });
  }
  return (
    <AppShell sections={sections} email={user.email} roleLabel={roleLabel}>
      {children}
    </AppShell>
  );
}
