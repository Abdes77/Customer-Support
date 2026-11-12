import {
  KNOWLEDGE_CATEGORIES,
  type KnowledgeCategory,
  type KnowledgeFact,
  type KnowledgeRetriever,
} from "@repo/core";
import { and, asc, type Database, eq, inArray, knowledgeItems, sql } from "@repo/db";

import { MAX_ACTIVE_FACTS } from "./items";

/**
 * The retrieval function the conversation engine calls (`KnowledgeRetriever`, @repo/core).
 *
 * - `coreFacts`: every active fact of the business in a stable order. The engine keeps the
 *   categories of `knowledge.core_categories` and the pinned facts in the cached business
 *   section and leaves the rest to look-ups.
 * - `retrieve`: the facts relevant to a customer's message. Two signals are combined:
 *   PostgreSQL full-text search over title and content, and the kinds of fact the message
 *   asks about ("do you finance?" brings the financing facts even when no word matches).
 *
 * There is no vector index: a business has at most a few hundred short facts
 * (docs/DECISIONS.md 11).
 */

const COLUMNS = {
  id: knowledgeItems.id,
  category: knowledgeItems.category,
  title: knowledgeItems.title,
  content: knowledgeItems.content,
  source: knowledgeItems.source,
  isCore: knowledgeItems.isCore,
  position: knowledgeItems.position,
  updatedAt: knowledgeItems.updatedAt,
};

interface FactRow {
  readonly id: string;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly content: string;
  readonly source: string | null;
  readonly isCore: boolean;
  readonly position: number;
  readonly updatedAt: Date;
}

function toFact(row: FactRow): KnowledgeFact {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.isCore ? { pinned: true } : {}),
  };
}

const categoryRank = (category: string) => {
  const index = (KNOWLEDGE_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? KNOWLEDGE_CATEGORIES.length : index;
};

/** Facts read from the business's own website come after imported and hand-written ones. */
export function isWebsiteSource(source: string | null): boolean {
  return source !== null && (source === "website" || /^https?:\/\//i.test(source));
}

function byDisplayOrder(a: FactRow, b: FactRow): number {
  return (
    categoryRank(a.category) - categoryRank(b.category) ||
    Number(isWebsiteSource(a.source)) - Number(isWebsiteSource(b.source)) ||
    a.position - b.position ||
    a.id.localeCompare(b.id)
  );
}

const STOP_WORDS = new Set(
  (
    "a about after all also am an and any are as at be because been before being but by can could " +
    "did do does doing don for from get got had has have having he her here hers him his how i if in " +
    "into is it its just let like me more most my need no not now of off on once only or other our " +
    "out over own please she should so some such than thank thanks that the their them then there " +
    "these they this those through to too under until up us very want was we were what when where " +
    "which while who whom why will with would yes you your yours hi hello hey ok okay"
  ).split(" "),
);

const MAX_QUERY_WORDS = 24;

/** The words of a message worth searching for, without filler. */
export function searchTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    ),
  ].slice(0, MAX_QUERY_WORDS);
}

const INTENTS: readonly (readonly [KnowledgeCategory, RegExp])[] = [
  [
    "financing",
    /\b(financ\w*|payment plans?|pay (?:monthly|over time|in installments)|monthly payments?|installments?|loans?|credit|afford\w*|interest[- ]free)\b/i,
  ],
  ["warranties", /\b(warrant\w*|guarantee\w*|guaranty|covered if|stand behind)\b/i],
  [
    "licenses",
    /\b(licen[sc]e\w*|insured|insurance certificate|bonded|certified|certification\w*|accredited|permit\w*)\b/i,
  ],
  [
    "reviews",
    /\b(reviews?|ratings?|stars?|testimonials?|references|reputation|recommend\w*|bbb|yelp|google reviews?)\b/i,
  ],
  [
    "brands",
    /\b(brands?|manufacturers?|makes? and models?|which (?:products|materials)|carry|dealer)\b/i,
  ],
  [
    "pricing",
    /(\$|\b(price\w*|pricing|cost\w*|how much|quotes?|estimates?|fees?|charge\w*|rates?|discounts?|coupons?|specials?|deals?)\b)/i,
  ],
  [
    "hours",
    /\b(hours|open|closed?|closing|weekends?|saturdays?|sundays?|tonight|today|tomorrow|after[- ]hours|24\/7|holidays?|what time|how late|how early)\b/i,
  ],
  [
    "service_area",
    /\b(service area|areas? (?:do )?you (?:serve|cover)|do you (?:serve|cover|come|go|travel)|come out to|located|location|where are you|near me|zip(?: code)?|county|how far|out of (?:town|state))\b/i,
  ],
  [
    "team",
    /\b(owners?|who (?:owns|runs|will|is coming)|technicians?|crews?|employees|subcontract\w*|family[- ]owned|how long have you|years in business|experience\w*|background checks?)\b/i,
  ],
  [
    "differentiators",
    /\b(why (?:should|choose|you|pick)|what makes you|different from|better than|compared? to|competitors?|set you apart)\b/i,
  ],
  [
    "policies",
    /\b(polic\w+|cancel\w*|reschedul\w*|refunds?|deposits?|payment methods?|credit cards?|checks?|cash|contracts?|terms)\b/i,
  ],
  [
    "services",
    /\b(do you (?:do|offer|handle|install|repair|replace|fix|work on|service)|can you (?:do|install|repair|replace|fix)|services?|what (?:do|kind of work) you)\b/i,
  ],
];

/** The kinds of fact a message asks about, most specific first. */
export function askedCategories(text: string): KnowledgeCategory[] {
  return INTENTS.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
/** Facts of an asked-about category that may join a look-up without a matching word. */
const PER_INTENT = 6;
/** What "this is the kind of fact the message asks about" is worth, next to a word match of 0 to 1. */
const INTENT_BONUS = 0.4;

export function createKnowledgeRetriever(options: { readonly db: Database }): KnowledgeRetriever {
  const { db } = options;
  return {
    async coreFacts(businessId) {
      const rows = await db.forBusiness(businessId).run(
        (ctx) =>
          ctx.tx
            .select(COLUMNS)
            .from(knowledgeItems)
            .where(eq(knowledgeItems.status, "active"))
            // A fixed read order, so that the cap cuts the same facts every time.
            .orderBy(
              asc(knowledgeItems.category),
              asc(knowledgeItems.position),
              asc(knowledgeItems.id),
            )
            .limit(MAX_ACTIVE_FACTS),
        { readOnly: true },
      );
      return [...rows].sort(byDisplayOrder).map(toFact);
    },

    async retrieve({ businessId, text, categories, limit }) {
      const terms = searchTerms(text);
      const allowed = categories === undefined || categories.length === 0 ? null : [...categories];
      const asked = askedCategories(text).filter(
        (category) => allowed === null || allowed.includes(category),
      );
      if (terms.length === 0 && asked.length === 0) return [];
      const wanted = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const inCategories = allowed === null ? undefined : inArray(knowledgeItems.category, allowed);

      const { matches, intent } = await db.forBusiness(businessId).run(
        async (ctx) => {
          const tsQuery = sql`to_tsquery('english', ${terms.join(" | ")})`;
          const rank = sql<number>`ts_rank(${knowledgeItems.search}, ${tsQuery})`;
          const found =
            terms.length === 0
              ? []
              : await ctx.tx
                  .select({ ...COLUMNS, rank })
                  .from(knowledgeItems)
                  .where(
                    and(
                      eq(knowledgeItems.status, "active"),
                      sql`${knowledgeItems.search} @@ ${tsQuery}`,
                      inCategories,
                    ),
                  )
                  .orderBy(sql`${rank} desc`, asc(knowledgeItems.id))
                  .limit(MAX_LIMIT);
          const byIntent =
            asked.length === 0
              ? []
              : await ctx.tx
                  .select(COLUMNS)
                  .from(knowledgeItems)
                  .where(
                    and(
                      eq(knowledgeItems.status, "active"),
                      inArray(knowledgeItems.category, asked),
                    ),
                  )
                  .orderBy(asc(knowledgeItems.position), asc(knowledgeItems.id))
                  .limit(PER_INTENT * asked.length);
          return { matches: found, intent: byIntent };
        },
        { readOnly: true },
      );

      // Score: how well the words match (best match = 1), plus a bonus when the fact is of a
      // kind the message asks about. The bonus is smaller than a good word match, so that a
      // generic fact of the right kind does not push aside the fact that names the thing asked
      // about; a fact with both signals leads.
      const best = Math.max(...matches.map((row) => Number(row.rank)), 0);
      const scored = new Map<string, { row: FactRow; score: number }>();
      for (const row of matches) {
        const share = best > 0 ? Number(row.rank) / best : 0;
        scored.set(row.id, {
          row,
          score: share + (asked.includes(row.category) ? INTENT_BONUS : 0),
        });
      }
      const perCategory = new Map<string, number>();
      for (const row of [...intent].sort(byDisplayOrder)) {
        if (scored.has(row.id)) continue;
        const taken = perCategory.get(row.category) ?? 0;
        if (taken >= PER_INTENT) continue;
        perCategory.set(row.category, taken + 1);
        // Earlier-asked categories and earlier facts first, all below a good word match.
        const order = asked.indexOf(row.category) * 0.05 + taken * 0.01;
        scored.set(row.id, { row, score: INTENT_BONUS - order });
      }
      return [...scored.values()]
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(isWebsiteSource(a.row.source)) - Number(isWebsiteSource(b.row.source)) ||
            byDisplayOrder(a.row, b.row),
        )
        .slice(0, wanted)
        .map((entry) => toFact(entry.row));
    },
  };
}
