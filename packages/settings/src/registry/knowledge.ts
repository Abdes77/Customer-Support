import { KNOWLEDGE_CATEGORIES } from "@repo/core";

import { defineCategory, setting } from "../define";
import { f } from "../fields";

/** How business knowledge is gathered and used. Consumed by knowledge (C6) and the engine (C4). */
export const knowledgeSettings = defineCategory("knowledge", {
  "knowledge.core_categories": setting({
    label: "Facts in every reply",
    help: "Knowledge of these kinds is always in front of the bot. Everything else is looked up when a message calls for it.",
    field: f.multiSelect(KNOWLEDGE_CATEGORIES, { minItems: 1 }),
    default: ["services", "service_area", "hours", "licenses", "warranties", "financing"],
  }),
  "knowledge.retrieval_limit": setting({
    label: "Facts looked up per message",
    help: "The most additional facts the bot looks up for one customer message.",
    field: f.integer({ min: 1, max: 30, unit: "facts" }),
    default: 8,
  }),
  "knowledge.use_reviews": setting({
    label: "Mention reviews",
    help: "The bot may mention ratings and reviews that are in the business's knowledge. It never quotes a review that is not there.",
    field: f.boolean(),
    default: true,
  }),
  "knowledge.website_crawl": setting({
    label: "Read the business website",
    help: "Facts are also collected from the business's own website. Imported and hand-edited facts always win over what the website says.",
    field: f.boolean(),
    default: false,
  }),
  "knowledge.crawl_max_pages": setting({
    label: "Website pages to read",
    help: "The most pages read from the website in one pass.",
    field: f.integer({ min: 1, max: 200, unit: "pages" }),
    default: 25,
  }),
  "knowledge.stale_after_days": setting({
    label: "Flag facts older than",
    help: "Facts that have not been confirmed for this long are flagged for review in the knowledge editor. The bot keeps using them.",
    field: f.nullable(f.integer({ min: 30, max: 1095, unit: "days" }), "Never flag"),
    default: 365,
  }),
  "knowledge.playbook_research_searches": setting({
    label: "Web searches per research step",
    help: "A segment's playbook is researched on the web in three steps before it is written. This is the most searches the model may run in each step. More searches take longer and cost more.",
    field: f.integer({ min: 1, max: 15, unit: "searches" }),
    default: 5,
    // A playbook belongs to a segment of the agency, never to one business.
    scopes: ["global", "segment"],
  }),
});
