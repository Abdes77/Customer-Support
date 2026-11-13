"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui/cn";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Reserved for a later build step (C16): shown, marked, and leads to an empty page. */
  readonly slot?: boolean;
  /** Active only on this exact path, not on paths below it. */
  readonly exact?: boolean;
}

export interface NavSection {
  readonly title?: string;
  readonly items: readonly NavItem[];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact === true) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The main navigation. Active links are marked for screen readers too. */
export function MainNav({ sections }: { readonly sections: readonly NavSection[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {sections.map((section, index) => (
        <div key={section.title ?? index}>
          {section.title !== undefined && (
            <p className="px-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {section.title}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href as Route}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium",
                      active
                        ? "bg-blue-50 text-blue-800"
                        : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.slot === true && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                        Soon
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Tabs inside a business: a scrollable row on phones. */
export function TabNav({
  items,
  label,
}: {
  readonly items: readonly NavItem[];
  readonly label: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-slate-200">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href as Route}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
                  active
                    ? "border-blue-700 text-blue-800"
                    : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900",
                )}
              >
                {item.label}
                {item.slot === true && (
                  <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500 uppercase">
                    Soon
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
