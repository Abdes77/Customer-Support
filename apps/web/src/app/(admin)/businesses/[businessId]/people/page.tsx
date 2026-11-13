import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatDateTime } from "@/components/inbox/labels";
import { PeopleManager } from "@/components/people/people-manager";
import { Callout } from "@/components/ui/callout";
import { requireAccess } from "@/server/auth";
import { businessPeopleAccess, createPeopleActions } from "@/server/people";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

const ROLE_LABELS: Readonly<Record<string, string>> = {
  client_owner: "Business owner",
  client_staff: "Business staff",
};

/**
 * The business's client logins (C18): its owners and staff. Agency staff see them, agency
 * admins manage them; a client owner manages their staff only when client logins are on and
 * the business's `client_portal.owner_manages_staff` allows it. Anyone else: not found.
 */
export default async function BusinessPeoplePage({
  params,
}: {
  readonly params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const session = await requireAccess(`/businesses/${businessId}/people`);
  const access = await businessPeopleAccess(session, businessId);
  if (access === null) notFound();
  const people = await createPeopleActions({ inviter: null }).listBusiness(session, access);
  const staff = access.role === "agency_admin" || access.role === "agency_member";
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Limited logins for the business&apos;s own people. A business owner and their staff see only
        this business, and only what its client-portal settings allow.
      </p>
      {staff && !access.portalEnabled && (
        <Callout tone="warning" title="Client logins are switched off">
          People listed here cannot sign in until client logins are switched on in this
          business&apos;s{" "}
          <Link
            href={`/businesses/${access.tenant.businessId}/settings` as Route}
            className="font-medium underline"
          >
            settings
          </Link>{" "}
          (Client portal).
        </Callout>
      )}
      {staff && access.manageRoles.length === 0 && (
        <Callout tone="info">Only agency admins add or remove client logins.</Callout>
      )}
      <PeopleManager
        scope={{ kind: "business", businessId: access.tenant.businessId }}
        people={people.map((person) => ({ ...person, since: formatDateTime(person.since) }))}
        currentUserId={session.user.id}
        roleLabels={ROLE_LABELS}
        grantableRoles={access.manageRoles}
        removableRoles={access.manageRoles}
        changeRoles={access.changeRoles}
      />
    </div>
  );
}
