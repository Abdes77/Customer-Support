"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Reloads the page's server data every few seconds while `active` (a playbook being written). */
export function RefreshWhile({
  active,
  intervalMs = 3000,
}: {
  readonly active: boolean;
  readonly intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
