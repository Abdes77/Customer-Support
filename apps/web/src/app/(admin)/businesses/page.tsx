import type { Metadata, Route } from "next";
import Link from "next/link";

import type { EmergencyReadiness } from "@repo/handoff";
import { type BusinessDetails, BUSINESS_STATUSES, listVisibleBusinesses } from "@repo/db";

import { ReadinessBadge, StatusBadge } from "@/components/business/status";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { adminLogger } from "@/server/admin";
import { requireAccess, userDatabase } from "@/server/auth";
import { getHandoff } from "@/server/handoff";

export const metadata: Metadata = { title: "Businesses" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function readinessOf(business: BusinessDetails): Promise<EmergencyReadiness | null> {
  if (business.status === "archived") return null;
  try {
    return await getHandoff().readiness({ agencyId: business.agencyId, businessId: business.id });
  } catch (error) {
    adminLogger.error("admin.readiness.failed", { businessId: business.id, error });
    return null;
  }
}

/**
 * Every business the signed-in person may see: all of the agency's for staff, their own for
 * a client user. Search and the status filter are plain GET parameters.
 */
export default async function BusinessesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, access } = await requireAccess("/businesses");
  const staff = access.agencies.length > 0;
  const params = await searchParams;
  const query = (first(params["q"]) ?? "").trim().slice(0, 100);
  const status = first(params["status"]) ?? "";
  const all = await userDatabase(user).run((ctx) =>
    listVisibleBusinesses(ctx, { includeArchived: status === "archived" }),
  );
  const needle = query.toLowerCase();
  const shown = all.filter(
    (business) =>
      (status === "" || business.status === status) &&
      (needle === "" ||
        business.name.toLowerCase().includes(needle) ||
        (business.city ?? "").toLowerCase().includes(needle) ||
        (business.segment?.name ?? "").toLowerCase().includes(needle)),
  );
  const readiness = staff
    ? await Promise.all(shown.map((business) => readinessOf(business)))
    : shown.map(() => null);

  return (
    <div>
      <PageHeader
        title={staff ? "Businesses" : "Your businesses"}
        description={
          staff
            ? "Every client business of your agency. Open one to edit its knowledge, playbook and settings."
            : undefined
        }
        actions={
          staff ? (
            <Link href="/businesses/new" className={buttonClass("primary")}>
              Onboard a business
            </Link>
          ) : undefined
        }
      />

      <form
        method="get"
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
        role="search"
      >
        <div className="flex-1">
          <label htmlFor="q" className="sr-only">
            Search businesses
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            placeholder="Search by name, city or segment"
            defaultValue={query}
          />
        </div>
        <div className="sm:w-48">
          <label htmlFor="status" className="sr-only">
            Status
          </label>
          <Select id="status" name="status" defaultValue={status}>
            <option value="">All statuses</option>
            {BUSINESS_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClass("secondary")}>
          Filter
        </button>
      </form>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="font-medium text-slate-800">
            {all.length === 0 ? "No businesses yet." : "No business matches."}
          </p>
          {staff && all.length === 0 && (
            <p className="mt-2 text-sm text-slate-600">
              <Link href="/businesses/new" className="font-medium text-blue-700 underline">
                Onboard the first business
              </Link>
            </p>
          )}
        </div>
      ) : (
        <ul
          className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          aria-label="Businesses"
        >
          {shown.map((business, index) => {
            const ready = readiness[index] ?? null;
            const href = (
              business.status === "onboarding" && staff
                ? `/businesses/${business.id}/onboarding/segment`
                : `/businesses/${business.id}`
            ) as Route;
            return (
              <li key={business.id}>
                <Link
                  href={href}
                  className="flex flex-col gap-2 px-4 py-4 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{business.name}</p>
                    <p className="truncate text-sm text-slate-600">
                      {[
                        business.segment?.name ?? "No segment yet",
                        [business.city, business.state].filter(Boolean).join(", "),
                      ]
                        .filter((part) => part !== "")
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge status={business.status} />
                    {ready !== null && (
                      <ReadinessBadge ready={ready.ready} enabled={ready.enabled} />
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
