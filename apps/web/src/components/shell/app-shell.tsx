import type { ReactNode } from "react";

import { MainNav, type NavSection } from "./nav";

/**
 * The frame of every admin page: the navigation in a sidebar on wide screens and behind a
 * menu button on phones (a `<details>` element, so it works before any script loads), the
 * signed-in person and the sign-out button.
 */
export function AppShell({
  sections,
  email,
  roleLabel,
  children,
}: {
  readonly sections: readonly NavSection[];
  readonly email: string | null;
  readonly roleLabel: string;
  readonly children: ReactNode;
}) {
  const account = (
    <div className="border-t border-slate-200 pt-4">
      <p className="truncate text-sm font-medium text-slate-900" title={email ?? undefined}>
        {email ?? "Signed in"}
      </p>
      <p className="text-xs text-slate-500">{roleLabel}</p>
      <form action="/auth/sign-out" method="post" className="mt-3">
        <button
          type="submit"
          className="text-sm font-medium text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          Sign out
        </button>
      </form>
    </div>
  );
  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <aside className="hidden w-64 shrink-0 flex-col justify-between gap-6 border-r border-slate-200 bg-white px-3 py-5 lg:sticky lg:top-0 lg:flex lg:h-screen lg:overflow-y-auto">
        <div className="flex flex-col gap-6">
          <Brand />
          <MainNav sections={sections} />
        </div>
        <div className="px-3">{account}</div>
      </aside>

      <details className="group border-b border-slate-200 bg-white lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Brand />
          <span className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700">
            <span className="group-open:hidden">Menu</span>
            <span className="hidden group-open:inline">Close</span>
          </span>
        </summary>
        <div className="flex flex-col gap-4 px-3 pb-4">
          <MainNav sections={sections} />
          <div className="px-3">{account}</div>
        </div>
      </details>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <a
      href="/businesses"
      className="flex items-center gap-2 px-3 text-sm font-semibold text-slate-900"
    >
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-md bg-blue-700 text-xs font-bold text-white"
      >
        HS
      </span>
      Reply bot admin
    </a>
  );
}
