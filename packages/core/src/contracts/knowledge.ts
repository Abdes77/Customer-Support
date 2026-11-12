import { z } from "zod";

import { type BusinessId, IsoDateTime, SegmentId } from "../ids";

/**
 * Business knowledge and industry playbooks as the engine consumes them (owner: C6, package
 * `@repo/knowledge`).
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
  /**
   * True for a fact the agency pinned: it is in every prompt whatever its category. Absent
   * means not pinned.
   */
  pinned: z.boolean().optional(),
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

/*
 * The industry playbook of one segment. A playbook is written by a model from web research
 * and edited by people, and its text ends up in the system prompt of every business of the
 * segment, so every text has a length limit and every list a size limit.
 */

/** One line: a name, a phrase, a term. */
const short = z.string().trim().min(1).max(200);
/** A sentence or two. */
const medium = z.string().trim().min(1).max(600);
/** A short paragraph. */
const long = z.string().trim().min(1).max(1200);

const list = <T extends z.ZodType>(item: T) => z.array(item).max(40);

export const PlaybookJob = z.object({ name: short, scope: long });
export const PlaybookPhrase = z.object({ phrase: short, meaning: medium });
export const PlaybookUrgencySignal = z.object({
  signal: medium,
  level: z.enum(["emergency", "urgent", "routine"]),
});
export const PlaybookQuestion = z.object({ question: medium, why: medium });
export const PlaybookObjection = z.object({ objection: medium, response: long });
export const PlaybookTerm = z.object({ term: short, definition: medium });
export const PlaybookSource = z.object({
  title: short,
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export type PlaybookSource = z.infer<typeof PlaybookSource>;

/**
 * A typical price range for one kind of job, as numbers, so that what the bot is shown and
 * what the output guard allows are the same figures by construction.
 */
export const PlaybookPriceNorm = z
  .object({
    job: short,
    /** Low end of the typical range, in US dollars. */
    lowUsd: z.number().finite().min(0).max(10_000_000),
    /** High end of the typical range, in US dollars. Never below the low end. */
    highUsd: z.number().finite().min(0).max(10_000_000),
    /** What the range is for: "per job", "per square (100 sq ft)", "per visit". */
    unit: short,
    /** Where the range applies: "US national", "Mountain West", "Minnesota". */
    region: short,
    notes: medium.nullable(),
  })
  .refine((norm) => norm.lowUsd <= norm.highUsd, {
    message: "The low end of a price range cannot be above its high end.",
    path: ["highUsd"],
  });
export type PlaybookPriceNorm = z.infer<typeof PlaybookPriceNorm>;

/** The structured industry playbook for one segment (owner: C6). */
export const PlaybookDocument = z.object({
  commonJobs: list(PlaybookJob),
  customerLanguage: list(PlaybookPhrase),
  urgencySignals: list(PlaybookUrgencySignal),
  /** In the order they should usually be asked. */
  qualificationQuestions: list(PlaybookQuestion),
  objections: list(PlaybookObjection),
  seasonalPatterns: list(medium),
  /** Stored always; shown to the bot and quoted to customers only as the pricing settings allow. */
  priceNorms: list(PlaybookPriceNorm),
  permitsAndRegulations: list(medium),
  vocabulary: list(PlaybookTerm),
  sources: list(PlaybookSource),
});
export type PlaybookDocument = z.infer<typeof PlaybookDocument>;

/** The sections of a playbook, in the order they are shown and rendered. */
export const PLAYBOOK_SECTIONS = [
  "commonJobs",
  "customerLanguage",
  "urgencySignals",
  "qualificationQuestions",
  "objections",
  "seasonalPatterns",
  "priceNorms",
  "permitsAndRegulations",
  "vocabulary",
  "sources",
] as const satisfies readonly (keyof PlaybookDocument)[];
export const PlaybookSection = z.enum(PLAYBOOK_SECTIONS);
export type PlaybookSection = z.infer<typeof PlaybookSection>;

/** The schema of one section, for validating a per-business override of that section. */
export const PLAYBOOK_SECTION_SCHEMAS = PlaybookDocument.shape;

export const PLAYBOOK_SECTION_LABELS: Readonly<Record<PlaybookSection, string>> = {
  commonJobs: "Common jobs",
  customerLanguage: "How customers describe problems",
  urgencySignals: "Urgency signals",
  qualificationQuestions: "Qualification questions",
  objections: "Objections and good answers",
  seasonalPatterns: "Seasonal patterns",
  priceNorms: "Price norms",
  permitsAndRegulations: "Permits and regulations",
  vocabulary: "Vocabulary",
  sources: "Sources",
};

/** "$1,500" or "$89.50". Written out by hand so the text never depends on locale data. */
function usd(amount: number): string {
  const [whole = "0", fraction] = (Math.round(amount * 100) / 100).toString().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}${fraction === undefined ? "" : `.${fraction.padEnd(2, "0")}`}`;
}

/**
 * A price norm in words: "$400 to $1,500 per job (US national)". The engine's prompt and the
 * admin panel both use this, and the output guard allows exactly the two figures in it.
 */
export function formatPriceNorm(norm: PlaybookPriceNorm): string {
  const range =
    norm.lowUsd === norm.highUsd
      ? `about ${usd(norm.lowUsd)}`
      : `${usd(norm.lowUsd)} to ${usd(norm.highUsd)}`;
  return `${range} ${norm.unit} (${norm.region})`;
}

/** The playbook version in force for a business, after per-business section overrides. */
export const PlaybookSnapshot = z.object({
  segmentId: SegmentId,
  segmentSlug: z.string().min(1),
  version: z.number().int().positive(),
  document: PlaybookDocument,
  /** Sections the business replaced with its own. Absent or empty: the segment's playbook as it is. */
  overriddenSections: z.array(PlaybookSection).optional(),
});
export type PlaybookSnapshot = z.infer<typeof PlaybookSnapshot>;
