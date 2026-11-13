import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cn } from "./cn";

const control =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30 disabled:bg-slate-50 disabled:text-slate-500 sm:text-sm aria-[invalid=true]:border-red-500";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "pr-8", className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-sm font-medium text-slate-800", className)} {...props} />;
}

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 rounded border-slate-300 text-blue-700 accent-blue-700 focus-visible:ring-2 focus-visible:ring-blue-600",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled control with optional help and an error line. */
export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly help?: ReactNode;
  readonly error?: string | null;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help !== undefined && help !== null && <p className="text-xs text-slate-500">{help}</p>}
      {error !== undefined && error !== null && (
        <p className="text-xs font-medium text-red-700">{error}</p>
      )}
    </div>
  );
}
