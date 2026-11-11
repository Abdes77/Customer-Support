import { z } from "zod";

import { type BusinessId, IsoDateTime, SegmentId } from "../ids";

/**
 * Business knowledge and industry playbooks as the engine consumes them (owner: C6, package
 * `@repo/knowledge`). C4 builds against these shapes before C6 exists.
 */

export const KNOWLEDGE_CATEGORIES = [
  "services",
  "service_area",
  "hours",
  "licenses",
  "warranties",
  "financing",
  "team",
  "brands",
  "reviews",
  "differentiators",
  "pricing",
  "policies",
  "faq",
  "other",
] as const;
export const KnowledgeCategory = z.enum(KNOWLEDGE_CATEGORIES);
export type KnowledgeCategory = z.infer<typeof KnowledgeCategory>;

export const KnowledgeFact = z.object({
  id: z.string().min(1),
  category: KnowledgeCategory,
  title: z.string(),
  content: z.string(),
  /** Where the fact came from: "csv_import", "api", "website", "manual" or a URL. */
  source: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type KnowledgeFact = z.infer<typeof KnowledgeFact>;

export interface KnowledgeRetriever {
  /**
   * Facts that go into every prompt for the business (profile, services, area, hours).
   * Must return the same facts in the same order until the knowledge is edited, because the
   * engine places them in the cached part of the prompt.
   */
  coreFacts(businessId: BusinessId): Promise<readonly KnowledgeFact[]>;

  /** Facts relevant to the latest customer messages. Placed after the cached prefix. */
  retrieve(query: {
    readonly businessId: BusinessId;
    readonly text: string;
    readonly categories?: readonly KnowledgeCategory[];
    readonly limit?: number;
  }): Promise<readonly KnowledgeFact[]>;
}

const PlaybookSource = z.object({ title: z.string(), url: z.url() });

/** The structured industry playbook for one segment (v0; C6 owns and may extend it). */
export const PlaybookDocument = z.object({
  commonJobs: z.array(z.object({ name: z.string(), scope: z.string() })),
  customerLanguage: z.array(z.object({ phrase: z.string(), meaning: z.string() })),
  urgencySignals: z.array(
    z.object({ signal: z.string(), level: z.enum(["emergency", "urgent", "routine"]) }),
  ),
  /** In the order they should usually be asked. */
  qualificationQuestions: z.array(z.object({ question: z.string(), why: z.string() })),
  objections: z.array(z.object({ objection: z.string(), response: z.string() })),
  seasonalPatterns: z.array(z.string()),
  /** Stored always; quoted to customers only as far as the pricing settings allow. */
  priceNorms: z.array(
    z.object({ job: z.string(), range: z.string(), notes: z.string().nullable() }),
  ),
  permitsAndRegulations: z.array(z.string()),
  vocabulary: z.array(z.object({ term: z.string(), definition: z.string() })),
  sources: z.array(PlaybookSource),
});
export type PlaybookDocument = z.infer<typeof PlaybookDocument>;

/** The playbook version in force for a business, after per-business section overrides. */
export const PlaybookSnapshot = z.object({
  segmentId: SegmentId,
  segmentSlug: z.string().min(1),
  version: z.number().int().positive(),
  document: PlaybookDocument,
});
export type PlaybookSnapshot = z.infer<typeof PlaybookSnapshot>;
