import type { KnowledgeCategory } from "@repo/core";
import { and, type BusinessContext, count, eq, inArray, knowledgeItems, like, max } from "@repo/db";

import { isHandEdited, MAX_ACTIVE_FACTS } from "../knowledge/items";
import { isWebsiteSource } from "../knowledge/retriever";
import { comparable, shortHash, slug } from "../knowledge/text";
import type { ExtractedFact } from "./extract";

/**
 * Storing the facts read from a business's website. They are the lowest rank of knowledge
 * (`knowledge.website_crawl`: "imported and hand-edited facts always win over what the
 * website says"):
 *
 * - a website fact is not stored when the business already has an imported or hand-written
 *   fact of the same category and title, or any fact with the same text;
 * - a website fact a person edited or archived stays as the person left it;
 * - reading the site again updates the website's own facts in place (stable keys).
 */

export const WEBSITE_KEY_PREFIX = "website:";

/** The most facts one business keeps from its website. */
export const MAX_WEBSITE_FACTS = 80;

export function websiteKey(fact: Pick<ExtractedFact, "category" | "title" | "content">): string {
  const named = slug(fact.title);
  return `${WEBSITE_KEY_PREFIX}${fact.category}:${named.length > 0 ? named : `text-${shortHash(fact.content)}`}`;
}

export interface WebsiteFactCounts {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Left alone: a person's version, or a better-ranked fact says the same. */
  readonly kept: number;
  /** Not stored because the business is at its limit. */
  readonly overLimit: number;
}

export async function storeWebsiteFacts(
  ctx: BusinessContext,
  input: {
    readonly importRunId: string;
    readonly pageUrl: string;
    readonly facts: readonly ExtractedFact[];
  },
): Promise<WebsiteFactCounts> {
  const counts = { created: 0, updated: 0, unchanged: 0, kept: 0, overLimit: 0 };
  if (input.facts.length === 0) return counts;
  const businessId = ctx.tenant.businessId;

  const activeFacts = await ctx.tx
    .select({
      category: knowledgeItems.category,
      title: knowledgeItems.title,
      content: knowledgeItems.content,
      source: knowledgeItems.source,
    })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.status, "active")));
  // What outranks the website: by category and title, and any fact by its text.
  const betterTitles = new Set(
    activeFacts
      .filter((fact) => !isWebsiteSource(fact.source) && fact.title.trim().length > 0)
      .map((fact) => `${fact.category}:${comparable(fact.title)}`),
  );
  const texts = new Set(activeFacts.map((fact) => comparable(fact.content)));
  let active = activeFacts.length;

  const [websiteRow] = await ctx.tx
    .select({ value: count() })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.businessId, businessId),
        eq(knowledgeItems.status, "active"),
        like(knowledgeItems.importKey, `${WEBSITE_KEY_PREFIX}%`),
      ),
    );
  let fromWebsite = websiteRow?.value ?? 0;

  const keys = input.facts.map(websiteKey);
  const existing = await ctx.tx
    .select()
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.businessId, businessId), inArray(knowledgeItems.importKey, keys)));
  const byKey = new Map(existing.map((row) => [row.importKey ?? "", row]));
  const positions = new Map<KnowledgeCategory, number>();
  const nextPosition = async (category: KnowledgeCategory): Promise<number> => {
    let next = positions.get(category);
    if (next === undefined) {
      const [row] = await ctx.tx
        .select({ value: max(knowledgeItems.position) })
        .from(knowledgeItems)
        .where(
          and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.category, category)),
        );
      next = (row?.value ?? -1) + 1;
    }
    positions.set(category, next + 1);
    return next;
  };

  const handled = new Set<string>();
  for (const fact of input.facts) {
    const key = websiteKey(fact);
    if (handled.has(key)) continue;
    handled.add(key);
    const current = byKey.get(key);
    if (current !== undefined) {
      const personsVersion =
        isHandEdited(current.metadata) ||
        (current.status === "archived" && current.metadata["archivedBy"] !== "import");
      if (personsVersion) {
        counts.kept += 1;
      } else if (current.content === fact.content && current.status === "active") {
        counts.unchanged += 1;
      } else {
        await ctx.tx
          .update(knowledgeItems)
          .set({
            title: fact.title,
            content: fact.content,
            source: input.pageUrl,
            importRunId: input.importRunId,
          })
          .where(eq(knowledgeItems.id, current.id));
        counts.updated += 1;
      }
      continue;
    }
    const titled = fact.title.trim().length > 0;
    if (
      (titled && betterTitles.has(`${fact.category}:${comparable(fact.title)}`)) ||
      texts.has(comparable(fact.content))
    ) {
      counts.kept += 1;
      continue;
    }
    if (active >= MAX_ACTIVE_FACTS || fromWebsite >= MAX_WEBSITE_FACTS) {
      counts.overLimit += 1;
      continue;
    }
    await ctx.tx.insert(knowledgeItems).values({
      ...ctx.tenant,
      category: fact.category,
      title: fact.title,
      content: fact.content,
      source: input.pageUrl,
      importRunId: input.importRunId,
      importKey: key,
      position: await nextPosition(fact.category),
    });
    texts.add(comparable(fact.content));
    active += 1;
    fromWebsite += 1;
    counts.created += 1;
  }
  return counts;
}
