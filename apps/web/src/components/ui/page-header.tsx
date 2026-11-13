import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight break-words text-slate-900">
          {title}
        </h1>
        {description !== undefined && (
          <div className="mt-1 max-w-3xl text-sm text-slate-600">{description}</div>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A page that is reserved for a later part of the build: a clear, empty slot. */
export function EmptySlot({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} />
      <div
        className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center"
        data-testid="empty-slot"
      >
        <p className="text-base font-medium text-slate-800">Not available yet</p>
        <div className="mx-auto mt-2 max-w-md text-sm text-slate-600">{description}</div>
      </div>
    </div>
  );
}
