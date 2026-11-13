import type { PlaybookDocument } from "@repo/core";
import { starterPlaybook } from "@repo/knowledge";
import { PEST_CONTROL_PLAYBOOK, ROOFING_PLAYBOOK } from "@repo/knowledge/testing";

import type { EvalSegment } from "./businesses";

/**
 * The segment playbook each evaluation business runs with, stored in the sandbox as the
 * segment's active version.
 *
 * - Roofing and pest control use the complete playbooks of `@repo/knowledge/testing`: ten
 *   sections, price norms as numbers, sources. They are hand-written fixtures, not research.
 * - The other four trades use the product's built-in starter document (no prices, no
 *   sources), which is what a segment has before its playbook is generated.
 *
 * Both kinds are fixed, so a change in a score comes from the prompt, the engine or the
 * settings, never from a playbook that was researched differently on another day. The
 * quality of generated playbooks has its own live check (docs/HUMAN_TODO.md, step 26).
 */
export interface EvalPlaybook {
  readonly document: PlaybookDocument;
  readonly origin: "import" | "starter";
}

export function evalPlaybook(segment: EvalSegment, segmentSlug: string): EvalPlaybook {
  if (segment === "roofing") return { document: ROOFING_PLAYBOOK, origin: "import" };
  if (segment === "pest_control") return { document: PEST_CONTROL_PLAYBOOK, origin: "import" };
  return { document: starterPlaybook(segmentSlug).document, origin: "starter" };
}
