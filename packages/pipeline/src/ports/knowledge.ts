import type { KnowledgeCategory, KnowledgeFact, KnowledgeRetriever } from "@repo/core";
import { and, asc, type Database, eq, inArray, knowledgeItems, sql } from "@repo/db";

/** No business knowledge. For tests that do not care about facts. */
export const emptyKnowledgeRetriever: KnowledgeRetriever = {
  coreFacts: async () => [],
  retrieve: async () => [],
};

const MAX_FACTS = 300;
const MAX_QUERY_WORDS = 24;

function toFact(row: {
  id: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  source: string | null;
  updatedAt: Date;
}): KnowledgeFact {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The words of a customer's message that are worth searching for, as an OR query. */
export function searchQuery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    ),
  ].slice(0, MAX_QUERY_WORDS);
  return words.length === 0 ? null : words.join(" | ");
}

/**
 * The knowledge retriever until `packages/knowledge` (C6) provides the real one. It reads the
 * `knowledge_items` table that C1 created and the seed fills:
 *
 * - `coreFacts` returns every active fact of the business in a stable order (category, then
 *   position, then id). The engine keeps the categories named in `knowledge.core_categories`
 *   in the cached business section and leaves the rest to look-ups.
 * - `retrieve` is a full-text search over title and content (the generated `search` column)
 *   for any word of the message, best match first.
 */
export function createKnowledgeRetriever(options: { readonly db: Database }): KnowledgeRetriever {
  const { db } = options;
  const columns = {
    id: knowledgeItems.id,
    category: knowledgeItems.category,
    title: knowledgeItems.title,
    content: knowledgeItems.content,
    source: knowledgeItems.source,
    updatedAt: knowledgeItems.updatedAt,
  };
  return {
    async coreFacts(businessId) {
      const rows = await db
        .forBusiness(businessId)
        .run((ctx) =>
          ctx.tx
            .select(columns)
            .from(knowledgeItems)
            .where(eq(knowledgeItems.status, "active"))
            .orderBy(
              asc(knowledgeItems.category),
              asc(knowledgeItems.position),
              asc(knowledgeItems.id),
            )
            .limit(MAX_FACTS),
        );
      return rows.map(toFact);
    },

    async retrieve({ businessId, text, categories, limit }) {
      const query = searchQuery(text);
      if (query === null) return [];
      const tsQuery = sql`to_tsquery('english', ${query})`;
      const rows = await db.forBusiness(businessId).run((ctx) =>
        ctx.tx
          .select(columns)
          .from(knowledgeItems)
          .where(
            and(
              eq(knowledgeItems.status, "active"),
              sql`${knowledgeItems.search} @@ ${tsQuery}`,
              categories === undefined || categories.length === 0
                ? undefined
                : inArray(knowledgeItems.category, [...categories]),
            ),
          )
          .orderBy(sql`ts_rank(${knowledgeItems.search}, ${tsQuery}) desc`, asc(knowledgeItems.id))
          .limit(Math.min(Math.max(limit ?? 8, 1), 30)),
      );
      return rows.map(toFact);
    },
  };
}
