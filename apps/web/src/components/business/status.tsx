import type { BusinessStatus } from "@repo/db";

import { Badge, type BadgeTone } from "@/components/ui/badge";

const STATUS: Readonly<Record<BusinessStatus, { label: string; tone: BadgeTone }>> = {
  onboarding: { label: "Onboarding", tone: "amber" },
  active: { label: "Active", tone: "green" },
  paused: { label: "Paused", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export function StatusBadge({ status }: { readonly status: BusinessStatus }) {
  const { label, tone } = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

/** Whether an emergency at the business reaches a person (C13's readiness). */
export function ReadinessBadge({
  ready,
  enabled,
}: {
  readonly ready: boolean;
  readonly enabled: boolean;
}) {
  if (!enabled) return <Badge tone="neutral">Emergencies off</Badge>;
  return ready ? (
    <Badge tone="green">Emergencies reach a person</Badge>
  ) : (
    <Badge tone="red">Emergencies reach nobody</Badge>
  );
}
