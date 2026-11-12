import { z } from "zod";

import { AgencyId, BusinessId, SegmentId, TraceId } from "../ids";

/**
 * Knowledge and playbook events (owner: C6). Ids only, at-least-once delivery, consumers
 * must be idempotent.
 */

/**
 * A segment needs a playbook: a business was onboarded in a segment that has none, or an
 * admin asked for a new one. Triggers `knowledge-playbook-generate`.
 */
export const PlaybookGenerationRequestedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  segmentId: SegmentId,
  /** The `playbook_generations` row that tracks the run. */
  generationId: z.uuid(),
  /** The business whose onboarding asked for the playbook; null for an admin's request. */
  businessId: BusinessId.nullable(),
});
export type PlaybookGenerationRequestedEvent = z.infer<typeof PlaybookGenerationRequestedEvent>;

/** A long-running import (a website crawl) was requested. Triggers `knowledge-import`. */
export const KnowledgeImportRequestedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  /** The `import_runs` row that tracks the run. */
  importRunId: z.uuid(),
});
export type KnowledgeImportRequestedEvent = z.infer<typeof KnowledgeImportRequestedEvent>;

export const KNOWLEDGE_EVENTS = {
  "playbook.generation_requested": PlaybookGenerationRequestedEvent,
  "knowledge.import_requested": KnowledgeImportRequestedEvent,
} as const;
