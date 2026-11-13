import type { Route } from "next";
import Link from "next/link";

import { cn } from "@/components/ui/cn";
import type { StaffAgencyOption } from "@/server/admin";

/**
 * For a person who is staff of more than one agency: which agency an agency page shows, and
 * links to the others. Nothing is drawn for the usual single agency.
 */
export function AgencySwitcher({
  agencies,
  current,
  path,
}: {
  readonly agencies: readonly StaffAgencyOption[];
  readonly current: string;
  readonly path: string;
}) {
  if (agencies.length < 2) return null;
  return (
    <nav aria-label="Agency" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-600">Agency:</span>
      {agencies.map((agency) => (
        <Link
          key={agency.id}
          href={`${path}?agency=${agency.id}` as Route}
          aria-current={agency.id === current ? "page" : undefined}
          className={cn(
            "rounded-md border px-2.5 py-1 break-words",
            agency.id === current
              ? "border-blue-700 bg-blue-50 font-medium text-blue-800"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          {agency.name}
        </Link>
      ))}
    </nav>
  );
}
