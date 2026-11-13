import { z } from "zod";

import { AgencyId, BusinessId, SegmentId } from "@repo/core";

/**
 * Where a set of overrides lives: the whole agency ("global"), one segment of the agency, or
 * one business. The agency id is always part of the target, so a target can be checked
 * against the tenant a request or a job is acting for.
 */
export const ScopeTarget = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("global"), agencyId: AgencyId }),
  z.strictObject({ scope: z.literal("segment"), agencyId: AgencyId, segmentId: SegmentId }),
  z.strictObject({ scope: z.literal("business"), agencyId: AgencyId, businessId: BusinessId }),
]);
export type ScopeTarget = z.infer<typeof ScopeTarget>;

/**
 * One change to a setting at a target: a new value, or a reset that removes the override so
 * the value is inherited again.
 *
 * `expectedVersion` is optional optimistic locking for forms: the version of the override
 * the form was drawn from (null when there was none). When someone else changed the setting
 * in the meantime the change is refused with a conflict instead of overwriting their work.
 */
export const SettingChange = z.union([
  z.strictObject({
    key: z.string().min(1).max(200),
    value: z.json(),
    expectedVersion: z.number().int().positive().nullable().optional(),
  }),
  z.strictObject({
    key: z.string().min(1).max(200),
    reset: z.literal(true),
    expectedVersion: z.number().int().positive().nullable().optional(),
  }),
]);
export type SettingChange =
  | {
      readonly key: string;
      readonly value: unknown;
      readonly expectedVersion?: number | null;
    }
  | {
      readonly key: string;
      readonly reset: true;
      readonly expectedVersion?: number | null;
    };

/** The body of a "save settings" request, for server actions and API routes to parse. */
export const SettingsUpdateRequest = z.strictObject({
  target: ScopeTarget,
  changes: z.array(SettingChange).min(1).max(200),
  note: z.string().trim().max(500).optional(),
});
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequest>;

/** A short name for a target, for messages and audit summaries. */
export function describeTarget(target: ScopeTarget): string {
  switch (target.scope) {
    case "global":
      return "the agency";
    case "segment":
      return "the segment";
    case "business":
      return "the business";
  }
}
