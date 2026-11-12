import { placeholderPlaybook } from "@repo/ai";
import type { PlaybookDocument } from "@repo/core";

import { parsePlaybookDocument } from "./document";

/**
 * The playbook stored where no model is configured: a developer machine or CI without
 * `ANTHROPIC_API_KEY`. It is the engine's built-in document for the trade (or the general
 * one), stored with origin "starter" so the onboarding wizard, the playbook editor and the
 * version history have something real to work on. It holds no prices and no sources, and it
 * is never stored on a hosted deployment: there a missing key fails the generation run.
 */
export function starterPlaybook(segmentSlug: string): {
  readonly document: PlaybookDocument;
  /** The built-in document that was used: a trade's slug, or "general". */
  readonly basedOn: string;
} {
  const placeholder = placeholderPlaybook(segmentSlug);
  const parsed = parsePlaybookDocument(placeholder.document);
  if (!parsed.ok) {
    // The built-in documents are code; a failure here is a bug caught by the tests.
    throw new Error(`The built-in playbook "${placeholder.slug}" does not pass the checks.`);
  }
  return { document: parsed.document, basedOn: placeholder.slug };
}
