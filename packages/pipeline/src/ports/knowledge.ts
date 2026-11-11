import type { KnowledgeRetriever } from "@repo/core";

/**
 * No business knowledge. The default until C4 ships its placeholder and C6 the real retriever,
 * which replace it at the composition root.
 */
export const emptyKnowledgeRetriever: KnowledgeRetriever = {
  coreFacts: async () => [],
  retrieve: async () => [],
};
