import type { Metadata } from "next";

import { createBusinessAction } from "@/app/(admin)/_actions/business";
import { ProfileForm } from "@/components/business/profile-form";
import { WizardSteps } from "@/components/onboarding/wizard-steps";
import { AgencySwitcher } from "@/components/shell/agency-switcher";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { listStaffAgencies, requireStaffSession } from "@/server/admin";

export const metadata: Metadata = { title: "Onboard a business" };
export const dynamic = "force-dynamic";

/** Step 1 of onboarding: the business's profile. Creating it opens the rest of the wizard. */
export default async function NewBusinessPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams)["agency"];
  const session = await requireStaffSession(
    "/businesses/new",
    typeof requested === "string" ? requested : null,
  );
  const agencies = await listStaffAgencies(session);
  return (
    <div>
      <PageHeader
        title="Onboard a business"
        description="Six short steps: the profile, the segment and its playbook, the business's own data, alert contacts, and a test chat with the bot."
      />
      <AgencySwitcher agencies={agencies} current={session.agencyId} path="/businesses/new" />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <WizardSteps businessId={null} current="profile" statuses={{}} />
        <Card className="min-w-0 flex-1">
          <CardHeader title="Profile" description="Who the business is and where it works." />
          <CardBody>
            <ProfileForm
              action={createBusinessAction}
              businessId={null}
              agencyId={session.agencyId}
              submitLabel="Create and continue"
              initial={{
                name: "",
                timezone: "America/Chicago",
                websiteUrl: "",
                phone: "",
                email: "",
                addressLine1: "",
                addressLine2: "",
                city: "",
                state: "",
                postalCode: "",
              }}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
