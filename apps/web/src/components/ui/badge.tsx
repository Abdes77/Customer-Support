import type { ReactNode } from "react";

import { cn } from "./cn";

export type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  blue: "bg-blue-50 text-blue-800 ring-blue-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
