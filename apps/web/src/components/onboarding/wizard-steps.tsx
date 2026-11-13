import type { Route } from "next";
import Link from "next/link";

import { cn } from "@/components/ui/cn";

export const WIZARD_STEPS = [
  { id: "profile", label: "Profile" },
  { id: "segment", label: "Segment" },
  { id: "import", label: "Business data" },
  { id: "playbook", label: "Playbook" },
  { id: "alerts", label: "Alert contacts" },
  { id: "test", label: "Test chat" },
  { id: "finish", label: "Finish" },
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

export type StepStatus = "done" | "todo" | "warning" | "optional";

const MARK: Readonly<Record<StepStatus, { symbol: string; className: string; text: string }>> = {
  done: { symbol: "✓", className: "bg-emerald-600 text-white", text: "done" },
  todo: { symbol: "", className: "border border-slate-300 bg-white text-slate-500", text: "to do" },
  warning: { symbol: "!", className: "bg-red-600 text-white", text: "needs attention" },
  optional: {
    symbol: "",
    className: "border border-dashed border-slate-300 bg-white text-slate-500",
    text: "optional",
  },
};

/** The wizard's steps, with what is done; every step can be visited once the business exists. */
export function WizardSteps({
  businessId,
  current,
  statuses,
}: {
  readonly businessId: string | null;
  readonly current: WizardStep;
  readonly statuses: Partial<Record<WizardStep, StepStatus>>;
}) {
  return (
    <nav aria-label="Onboarding steps" className="lg:sticky lg:top-6 lg:w-56 lg:shrink-0">
      <ol className="relative flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible">
        {WIZARD_STEPS.map((step, index) => {
          const status = statuses[step.id] ?? "todo";
          const mark = MARK[status];
          const active = step.id === current;
          const content = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  mark.className,
                  active && status === "todo" && "border-blue-600 text-blue-700",
                )}
              >
                {mark.symbol === "" ? index + 1 : mark.symbol}
              </span>
              <span className="whitespace-nowrap">{step.label}</span>
              <span className="sr-only">({mark.text})</span>
            </>
          );
          const className = cn(
            "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm",
            active ? "bg-blue-50 font-semibold text-blue-900" : "text-slate-700",
          );
          return (
            <li key={step.id}>
              {businessId === null ? (
                <span className={className} aria-current={active ? "step" : undefined}>
                  {content}
                </span>
              ) : (
                <Link
                  href={`/businesses/${businessId}/onboarding/${step.id}` as Route}
                  className={cn(className, !active && "hover:bg-slate-100")}
                  aria-current={active ? "step" : undefined}
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
