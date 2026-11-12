/**
 * Allowed workspace dependencies, by package. This is the dependency graph from
 * docs/ARCHITECTURE.md ("Folder layout and package layers") in executable form;
 * `pnpm check:boundaries` (part of `pnpm verify`) fails when a package.json disagrees.
 *
 * Lower layers never import higher ones. Domain packages (layer 4) do not import each other:
 * they communicate through @repo/core contracts, events and the database.
 * To change an edge, edit this file and add a line to docs/DECISIONS.md saying why.
 */

const FOUNDATION = ["@repo/core", "@repo/db", "@repo/jobs", "@repo/observability"];
const DOMAIN_BASE = [...FOUNDATION, "@repo/settings"];
const DOMAIN_WITH_MODEL = [...DOMAIN_BASE, "@repo/ai"];

/** @type {Record<string, readonly string[] | "*">} */
export const ALLOWED_DEPENDENCIES = {
  // Layer 0: contracts and primitives. No workspace dependencies, safe in the browser.
  "@repo/core": [],

  // Layer 1: infrastructure.
  "@repo/db": ["@repo/core"],
  "@repo/jobs": ["@repo/core"],
  "@repo/observability": ["@repo/core"],

  // Layer 2: settings.
  "@repo/settings": ["@repo/core", "@repo/db"],

  // Layer 3: model client and conversation engine (everything else reaches it through ports).
  "@repo/ai": [...DOMAIN_BASE],

  // Layer 4: domain packages.
  "@repo/knowledge": DOMAIN_WITH_MODEL,
  "@repo/leads": DOMAIN_WITH_MODEL,
  "@repo/handoff": DOMAIN_WITH_MODEL,
  "@repo/scheduling": DOMAIN_BASE,
  "@repo/integrations": DOMAIN_BASE,
  "@repo/channel-test": DOMAIN_BASE,
  // The widget reads business hours through @repo/ai to show its closed notice (DECISIONS).
  "@repo/channel-widget": DOMAIN_WITH_MODEL,
  "@repo/channel-meta": ["@repo/core", "@repo/observability"],
  "@repo/channel-whatsapp": [...DOMAIN_BASE, "@repo/channel-meta"],
  "@repo/channel-messenger-instagram": [...DOMAIN_BASE, "@repo/channel-meta"],
  "@repo/channel-email": DOMAIN_BASE,

  // Browser bundle: types from core only.
  "@repo/widget-embed": ["@repo/core"],

  // Layer 5: the message pipeline composes the engine with the domain packages.
  // `@repo/channel-test` is a devDependency only: the pipeline's tests drive the real test
  // channel. Production adapters are wired in apps/web/src/server, never here.
  "@repo/pipeline": [
    ...DOMAIN_WITH_MODEL,
    "@repo/knowledge",
    "@repo/leads",
    "@repo/handoff",
    "@repo/scheduling",
    "@repo/channel-test",
  ],

  // Layer 6: the evaluation harness drives the same composition in dry-run mode.
  "@repo/evals": [...DOMAIN_WITH_MODEL, "@repo/knowledge", "@repo/leads", "@repo/pipeline"],

  // Layer 7: the deployable app may import anything.
  "@repo/web": "*",
};
