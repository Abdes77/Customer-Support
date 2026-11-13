import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import {
  type AgencyId,
  type BusinessId,
  NotFoundError,
  type SegmentId,
  TenantAccessError,
  ValidationError,
} from "@repo/core";

import { loadUserAccess, requireAgencyRole } from "../access";
import type { UserContext } from "../context";
import { businesses, segments } from "../schema/tables";
import { BUSINESS_STATUSES, type BusinessStatus } from "../schema/vocab";
import { recordUserAudit } from "./audit";

/*
 * Businesses for the admin panel (C15), always as the signed-in user: row-level security
 * decides what is visible and writable (staff of the agency write; a client user sees their
 * own business while client logins are on), and the role is checked here first so a refusal
 * is a clear error instead of an empty update. Every write is audited in the same
 * transaction.
 *
 * `client_portal_enabled` is not written here: it is the setting `client_portal.enabled`,
 * changed through the settings store (which keeps the column in step).
 */

/** "America/Chicago" and the like: a time zone this runtime knows. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(value) && value !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    .refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), {
      message: "This contains characters that cannot be saved.",
    })
    .transform((value) => (value === "" ? null : value));

/** The profile fields a person fills in. Empty text means "not set". */
export const BusinessProfileInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter the business's name.")
    .max(120, "Use at most 120 characters.")
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "The name must be a single line of text.",
    }),
  timezone: z.string().trim().refine(isTimeZone, { message: "Choose a time zone." }),
  websiteUrl: optionalText(300).refine(
    (value) => {
      if (value === null) return true;
      try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && !/\s/.test(value);
      } catch {
        return false;
      }
    },
    { message: "Enter a web address that starts with https:// or http://." },
  ),
  phone: optionalText(40).refine((value) => value === null || /^\+?[0-9 ().-]{7,20}$/.test(value), {
    message: "Enter a phone number with area code.",
  }),
  email: optionalText(254).refine(
    (value) => value === null || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(value),
    { message: "Enter an email address, for example office@example.com." },
  ),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(2).refine((value) => value === null || /^[A-Za-z]{2}$/.test(value), {
    message: "Enter a two-letter state code, for example TX.",
  }),
  postalCode: optionalText(10).refine((value) => value === null || /^\d{5}(-\d{4})?$/.test(value), {
    message: "Enter a five-digit ZIP code.",
  }),
});
export type BusinessProfileInput = z.input<typeof BusinessProfileInput>;
type BusinessProfile = z.output<typeof BusinessProfileInput>;

export interface BusinessSummary {
  readonly id: BusinessId;
  readonly agencyId: AgencyId;
  readonly name: string;
  readonly slug: string;
  readonly status: BusinessStatus;
  readonly segment: { readonly id: SegmentId; readonly name: string } | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly clientPortalEnabled: boolean;
  readonly createdAt: string;
}

export interface BusinessDetails extends BusinessSummary {
  readonly timezone: string;
  readonly websiteUrl: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly updatedAt: string;
}

const columns = {
  id: businesses.id,
  agencyId: businesses.agencyId,
  name: businesses.name,
  slug: businesses.slug,
  status: businesses.status,
  segmentId: segments.id,
  segmentName: segments.name,
  city: businesses.city,
  state: businesses.state,
  clientPortalEnabled: businesses.clientPortalEnabled,
  createdAt: businesses.createdAt,
  timezone: businesses.timezone,
  websiteUrl: businesses.websiteUrl,
  phone: businesses.phone,
  email: businesses.email,
  addressLine1: businesses.addressLine1,
  addressLine2: businesses.addressLine2,
  postalCode: businesses.postalCode,
  updatedAt: businesses.updatedAt,
};

function toDetails(row: Row): BusinessDetails {
  return {
    id: row.id,
    agencyId: row.agencyId,
    name: row.name,
    slug: row.slug,
    status: row.status,
    segment:
      row.segmentId === null || row.segmentName === null
        ? null
        : { id: row.segmentId, name: row.segmentName },
    city: row.city,
    state: row.state,
    clientPortalEnabled: row.clientPortalEnabled,
    createdAt: row.createdAt.toISOString(),
    timezone: row.timezone,
    websiteUrl: row.websiteUrl,
    phone: row.phone,
    email: row.email,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    postalCode: row.postalCode,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Row = Awaited<ReturnType<typeof selectBusinesses>>[number];

function selectBusinesses(ctx: UserContext) {
  return ctx.tx
    .select(columns)
    .from(businesses)
    .leftJoin(
      segments,
      and(eq(segments.id, businesses.segmentId), eq(segments.agencyId, businesses.agencyId)),
    );
}

/**
 * Every business the user may see, by name: all of their agencies' businesses for staff,
 * their own (with client logins on) for a client user. Archived businesses are left out
 * unless asked for.
 */
export async function listVisibleBusinesses(
  ctx: UserContext,
  options: { readonly includeArchived?: boolean } = {},
): Promise<BusinessDetails[]> {
  const rows = await selectBusinesses(ctx)
    .where(options.includeArchived === true ? undefined : ne(businesses.status, "archived"))
    .orderBy(asc(businesses.name), asc(businesses.id));
  return rows.map(toDetails);
}

/** One business, or null when it does not exist or the user may not see it. */
export async function getVisibleBusiness(
  ctx: UserContext,
  businessId: BusinessId,
): Promise<BusinessDetails | null> {
  const [row] = await selectBusinesses(ctx).where(eq(businesses.id, businessId)).limit(1);
  return row === undefined ? null : toDetails(row);
}

/** "Summit Roofing Co." → "summit-roofing-co". */
export function businessSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60)
    .replaceAll(/-+$/g, "");
  return slug.length > 0 ? slug : "business";
}

function parseProfile(input: unknown): BusinessProfile {
  const parsed = BusinessProfileInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("The business profile is not valid.", {
      details: {
        problems: parsed.error.issues.map((issue) => ({
          field: String(issue.path[0] ?? ""),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

/** Creates a business in the agency, in onboarding, as the signed-in agency staff member. */
export async function createBusiness(
  ctx: UserContext,
  input: { readonly agencyId: AgencyId; readonly profile: unknown },
): Promise<BusinessDetails> {
  requireAgencyRole(await loadUserAccess(ctx), input.agencyId);
  const profile = parseProfile(input.profile);
  const base = businessSlug(profile.name);
  const taken = new Set(
    (
      await ctx.tx
        .select({ slug: businesses.slug })
        .from(businesses)
        .where(eq(businesses.agencyId, input.agencyId))
    ).map((row) => row.slug),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 55)}-${n}`;

  const [created] = await ctx.tx
    .insert(businesses)
    .values({ agencyId: input.agencyId, slug, status: "onboarding", ...profile })
    .returning({ id: businesses.id });
  if (created === undefined) throw new Error("The business insert returned no row");
  await recordUserAudit(
    ctx,
    { agencyId: input.agencyId, businessId: created.id },
    {
      action: "business.create",
      targetType: "business",
      targetId: created.id,
      summary: "Business created",
    },
  );
  const details = await getVisibleBusiness(ctx, created.id);
  if (details === null) throw new Error("The new business is not visible to its creator");
  return details;
}

async function staffBusiness(ctx: UserContext, businessId: BusinessId): Promise<BusinessDetails> {
  const business = await getVisibleBusiness(ctx, businessId);
  if (business === null) {
    throw new NotFoundError("Business not found.", { details: { businessId } });
  }
  requireAgencyRole(await loadUserAccess(ctx), business.agencyId);
  return business;
}

/** Changes the profile. Agency staff only. */
export async function updateBusinessProfile(
  ctx: UserContext,
  input: { readonly businessId: BusinessId; readonly profile: unknown },
): Promise<BusinessDetails> {
  const before = await staffBusiness(ctx, input.businessId);
  const profile = parseProfile(input.profile);
  await ctx.tx
    .update(businesses)
    .set({ ...profile, updatedAt: new Date() })
    .where(eq(businesses.id, before.id));
  const changed = (Object.keys(profile) as (keyof BusinessProfile)[]).filter(
    (field) => (before as unknown as Record<string, unknown>)[field] !== profile[field],
  );
  if (changed.length > 0) {
    await recordUserAudit(
      ctx,
      { agencyId: before.agencyId, businessId: before.id },
      {
        action: "business.update",
        targetType: "business",
        targetId: before.id,
        summary: `Profile changed: ${changed.join(", ")}`,
        // Field names only: contact details stay out of the audit log.
        metadata: { fields: changed },
      },
    );
  }
  const details = await getVisibleBusiness(ctx, before.id);
  if (details === null) throw new Error("The business disappeared during the update");
  return details;
}

/**
 * Moves a business between onboarding, active and paused. Archiving (which hides the
 * business and switches client logins off) is for agency admins.
 */
export async function setBusinessStatus(
  ctx: UserContext,
  input: { readonly businessId: BusinessId; readonly status: BusinessStatus },
): Promise<BusinessDetails> {
  if (!(BUSINESS_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError("Unknown business status.");
  }
  const before = await staffBusiness(ctx, input.businessId);
  if (input.status === "archived" || before.status === "archived") {
    const access = await loadUserAccess(ctx);
    requireAgencyRole(access, before.agencyId, ["agency_admin"]);
  }
  if (input.status === "active" && before.segment === null) {
    throw new ValidationError("Choose the business's segment before activating it.");
  }
  if (before.status === input.status) return before;
  const updated = await ctx.tx
    .update(businesses)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(businesses.id, before.id))
    .returning({ id: businesses.id });
  if (updated.length === 0) {
    throw new TenantAccessError("You cannot change this business.", {
      details: { businessId: before.id },
    });
  }
  await recordUserAudit(
    ctx,
    { agencyId: before.agencyId, businessId: before.id },
    {
      action: "business.status",
      targetType: "business",
      targetId: before.id,
      summary: `Status changed from ${before.status} to ${input.status}`,
      before: { status: before.status },
      after: { status: input.status },
    },
  );
  const details = await getVisibleBusiness(ctx, before.id);
  if (details === null) throw new Error("The business disappeared during the update");
  return details;
}
