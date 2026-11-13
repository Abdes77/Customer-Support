import type { KnowledgeRetriever } from "@repo/core";

/**
 * No business knowledge. For tests that do not care about facts. The retriever a deployment
 * uses is `createKnowledgeRetriever` in `@repo/knowledge` (C6), registered in
 * `src/composition`.
 */
export const emptyKnowledgeRetriever: KnowledgeRetriever = {
  coreFacts: async () => [],
  retrieve: async () => [],
};
