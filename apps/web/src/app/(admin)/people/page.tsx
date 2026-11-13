import type { Metadata } from "next";

import { formatDateTime } from "@/components/inbox/labels";
import { PeopleManager } from "@/components/people/people-manager";
import { AgencySwitcher } from "@/components/shell/agency-switcher";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { listStaffAgencies, requireStaffSession } from "@/server/admin";
import { createPeopleActions, ROLE_WORDS } from "@/server/people";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

const ROLE_LABELS: Readonly<Record<string, string>> = {
  agency_admin: "Agency admin",
  agency_member: "Agency member",
};

/**
 * The agency's own people (C18): agency admins and members. Staff see the list; admins add
 * someone by email, change a role and remove access. Client logins are on each business's
 * People tab.
 */
export default async function AgencyPeoplePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams)["agency"];
  const session = await requireStaffSession(
    "/people",
    typeof requested === "string" ? requested : null,
  );
  const [agencies, people] = await Promise.all([
    listStaffAgencies(session),
    createPeopleActions({ inviter: null }).listAgency(session, session.agencyId),
  ]);
  const admin = session.agencyRole === "agency_admin";
  return (
    <div>
      <PageHeader
        title="People"
        description={`Who works in the admin panel for this agency. An ${ROLE_WORDS.agency_admin} manages people, API keys and agency-wide settings; an ${ROLE_WORDS.agency_member} works on every business.`}
      />
      <AgencySwitcher agencies={agencies} current={session.agencyId} path="/people" />
      {!admin && (
        <Callout tone="info" className="mb-4">
          Only agency admins add people, change roles or remove access.
        </Callout>
      )}
      <PeopleManager
        scope={{ kind: "agency", agencyId: session.agencyId }}
        people={people.map((person) => ({ ...person, since: formatDateTime(person.since) }))}
        currentUserId={session.user.id}
        roleLabels={ROLE_LABELS}
        grantableRoles={admin ? ["agency_admin", "agency_member"] : []}
        removableRoles={admin ? ["agency_admin", "agency_member"] : []}
        changeRoles={admin}
      />
      <p className="mt-4 text-sm text-slate-600">
        Client owners and staff get their logins on each business&apos;s People tab.
      </p>
    </div>
  );
}
