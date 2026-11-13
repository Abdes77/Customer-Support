import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "./cn";

/*
 * shadcn/ui-style primitives, kept in source as shadcn intends, written for Tailwind 4 without
 * Radix (DECISIONS). Server and client components both use them.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-blue-700 text-white shadow-sm hover:bg-blue-800 disabled:bg-blue-700/50 disabled:text-white",
  secondary:
    "border border-slate-300 bg-white text-slate-800 shadow-sm hover:bg-slate-50 disabled:text-slate-400",
  ghost: "text-slate-700 hover:bg-slate-100 disabled:text-slate-400",
  danger:
    "border border-red-200 bg-white text-red-700 shadow-sm hover:bg-red-50 disabled:text-red-300",
  link: "text-blue-700 underline-offset-2 hover:underline disabled:text-slate-400",
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed",
    variant === "link" ? "h-auto px-0" : SIZES[size],
    VARIANTS[variant],
    extra,
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly children?: ReactNode;
}) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...props}>
      {children}
    </button>
  );
}
