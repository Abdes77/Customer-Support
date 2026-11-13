import type { ReactNode } from "react";

import { cn } from "./cn";

export type CalloutTone = "info" | "success" | "warning" | "danger";

const TONES: Readonly<Record<CalloutTone, string>> = {
  info: "border-blue-200 bg-blue-50 text-blue-950",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950",
  warning: "border-amber-300 bg-amber-50 text-amber-950",
  danger: "border-red-300 bg-red-50 text-red-950",
};

/** A boxed message. `danger` and `warning` are announced to screen readers. */
export function Callout({
  tone = "info",
  title,
  children,
  className,
  testId,
}: {
  readonly tone?: CalloutTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      data-testid={testId}
      className={cn("rounded-lg border px-4 py-3 text-sm", TONES[tone], className)}
    >
      {title !== undefined && <p className="font-semibold">{title}</p>}
      {children !== undefined && (
        <div className={cn(title !== undefined && "mt-1", "space-y-1")}>{children}</div>
      )}
    </div>
  );
}
