import type { z } from "zod";

import { EMAIL_EVENTS } from "./email-events";
import { KNOWLEDGE_EVENTS } from "./knowledge-events";
import { LEAD_EVENTS } from "./lead-events";
import { PIPELINE_EVENTS } from "./pipeline-events";

export * from "./email-events";
export * from "./knowledge-events";
export * from "./lead-events";
export * from "./pipeline-events";

/**
 * Every event that crosses a package boundary, by name. A chunk that introduces an event adds
 * its schema to a file in this folder and registers it here; `@repo/jobs` turns the catalogue
 * into typed Inngest event definitions.
 */
export const EVENT_CATALOG = {
  ...PIPELINE_EVENTS,
  ...LEAD_EVENTS,
  ...KNOWLEDGE_EVENTS,
  ...EMAIL_EVENTS,
} as const satisfies Record<string, z.ZodType>;

export type EventName = keyof typeof EVENT_CATALOG;
export type EventPayload<TName extends EventName> = z.infer<(typeof EVENT_CATALOG)[TName]>;

export const EVENT_NAMES = Object.keys(EVENT_CATALOG) as EventName[];
