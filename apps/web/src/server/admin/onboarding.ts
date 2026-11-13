import type { EmergencyReadiness } from "@repo/handoff";
import type {
  KnowledgeItemRecord,
  PlaybookGenerationRecord,
  PlaybookVersionRecord,
} from "@repo/knowledge";

import type { StepStatus, WizardStep } from "@/components/onboarding/wizard-steps";
import { getHandoff } from "@/server/handoff";
import { getKnowledge } from "@/server/knowledge";

import type { BusinessPage } from "./index";

/*
 * Where a business stands in onboarding, read from the services that own each part: the
 * business row (C1), its facts and playbook (C6), its emergency readiness (C13).
 */

export interface OnboardingState {
  readonly facts: readonly KnowledgeItemRecord[];
  readonly readiness: EmergencyReadiness;
  /** The segment's playbook in force, or null. */
  readonly playbook: PlaybookVersionRecord | null;
  /** The newest generation run of the segment's playbook, if any. */
  readonly generation: PlaybookGenerationRecord | null;
  readonly statuses: Readonly<Record<WizardStep, StepStatus>>;
}

export async function loadOnboarding(page: BusinessPage): Promise<OnboardingState> {
  const knowledge = getKnowledge();
  const segmentId = page.business.segment?.id ?? null;
  const [facts, readiness, playbook, generations] = await Promise.all([
    knowledge.knowledge.list(page.user, page.business.id, { status: "active" }),
    getHandoff().readiness(page.tenant),
    segmentId === null ? null : knowledge.playbooks.getVersion(page.user, segmentId),
    segmentId === null ? [] : knowledge.playbooks.listGenerations(page.user, segmentId),
  ]);
  const generation = generations[0] ?? null;
  const generating =
    generation !== null && (generation.status === "pending" || generation.status === "running");
  return {
    facts,
    readiness,
    playbook,
    generation,
    statuses: {
      profile: "done",
      segment: segmentId === null ? "todo" : "done",
      import: facts.length > 0 ? "done" : "optional",
      playbook:
        playbook !== null && !generating
          ? "done"
          : generation?.status === "failed"
            ? "warning"
            : "todo",
      alerts: !readiness.enabled ? "done" : readiness.ready ? "done" : "warning",
      test: "optional",
      finish: page.business.status === "onboarding" ? "todo" : "done",
    },
  };
}
