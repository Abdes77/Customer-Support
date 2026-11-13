/** Joins class names, skipping empty ones (shadcn/ui's `cn`, without tailwind-merge). */
export function cn(...classes: readonly (string | false | null | undefined)[]): string {
  return classes
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(" ");
}
