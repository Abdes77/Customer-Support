import type { Metadata } from "next";

import { SettingsPanel } from "@/components/settings/settings-panel";
import { requireBusinessPage } from "@/server/admin";

export const metadata: Metadata = { title: "Business settings" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Every setting of one business, from the registry: the value in force, where it comes
 * from, override and reset. A client user sees the settings their agency lets them change.
 */
export default async function BusinessSettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ businessId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, {
    next: `/businesses/${businessId}/settings`,
  });
  const category = first((await searchParams)["category"]);
  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-slate-600">
        {page.staff
          ? "Values come from the registry default, then the agency, then the segment, then this business. Override a value here to change it for this business only; reset it to inherit again."
          : "The settings your agency lets you change for your business."}
      </p>
      <SettingsPanel
        session={page}
        target={{ scope: "business", businessId: page.business.id }}
        {...(category === undefined ? {} : { initialCategory: category })}
      />
    </div>
  );
}
