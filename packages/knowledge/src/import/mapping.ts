import { z } from "zod";

import { KNOWLEDGE_CATEGORIES, KnowledgeCategory } from "@repo/core";

/**
 * Field mapping for imported lead-generation data: what each column of a file means.
 *
 * Two shapes of file are understood, and may be mixed:
 * - wide: one row per business, one column per kind of fact ("Services", "Warranty",
 *   "Financing"), plus columns for the business's profile;
 * - long: one row per fact, with a column for the category, one for the title and one for
 *   the text.
 */

/** Profile fields of a business that an import may fill in. */
export const PROFILE_FIELDS = [
  "name",
  "website_url",
  "phone",
  "email",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "timezone",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const ColumnTarget = z.discriminatedUnion("to", [
  /** The column is not imported. */
  z.strictObject({ to: z.literal("ignore") }),
  /** The business's id in the agency's own data (`businesses.external_ref`). */
  z.strictObject({ to: z.literal("external_ref") }),
  z.strictObject({ to: z.literal("profile"), field: z.enum(PROFILE_FIELDS) }),
  /** Wide format: the cell is a fact of this category. */
  z.strictObject({
    to: z.literal("fact"),
    category: KnowledgeCategory,
    /** Title of the fact. Default: the column's name. */
    title: z.string().trim().min(1).max(200).optional(),
    /** Split the cell into one fact per item at this separator (";" or "|"). */
    split: z.enum([";", "|", "\n"]).optional(),
  }),
  /** Long format: the category, title and text of the row's fact. */
  z.strictObject({ to: z.literal("fact_category") }),
  z.strictObject({ to: z.literal("fact_title") }),
  z.strictObject({ to: z.literal("fact_content") }),
]);
export type ColumnTarget = z.infer<typeof ColumnTarget>;

/** Column name (as in the file's first row) → what it means. Unlisted columns are ignored. */
export const ColumnMapping = z.record(z.string().min(1).max(200), ColumnTarget);
export type ColumnMapping = z.infer<typeof ColumnMapping>;

const norm = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();

type Suggestion = readonly [RegExp, ColumnTarget];

const profile = (field: ProfileField): ColumnTarget => ({ to: "profile", field });
const fact = (category: KnowledgeCategory, split?: ";" | "|"): ColumnTarget => ({
  to: "fact",
  category,
  ...(split === undefined ? {} : { split }),
});

/** Checked in order: the first pattern that matches a column name wins. */
const SUGGESTIONS: readonly Suggestion[] = [
  [
    /^(external|crm|client|account|business|company|lead ?gen)? ?(id|ref|reference|key)$/,
    { to: "external_ref" },
  ],
  [/^(fact )?categor(y|ies)$|^(fact )?type$|^kind$/, { to: "fact_category" }],
  [/^(fact )?title$|^heading$|^topic$|^question$/, { to: "fact_title" }],
  [/^(fact )?(content|text|body|details?|answer|value)$/, { to: "fact_content" }],
  [/^(business|company|client|trading)? ?name$|^(business|company)$/, profile("name")],
  [/^(web ?site|url|web ?address|domain|homepage)( url)?$/, profile("website_url")],
  [/^(main |office |business )?(phone|telephone|tel|mobile|cell)( number| no)?$/, profile("phone")],
  [/^(contact |business |office )?e ?mail( address)?$/, profile("email")],
  [/^(street )?address( line)? ?1?$|^street$/, profile("address_line1")],
  [/^address( line)? ?2$|^(suite|unit|apt)$/, profile("address_line2")],
  [/^(city|town)$/, profile("city")],
  [/^(state|province|region)( code)?$/, profile("state")],
  [/^(zip|zip ?code|postal ?code|post ?code)$/, profile("postal_code")],
  [/^time ?zone$|^tz$/, profile("timezone")],
  [
    /service area|areas? served|coverage|cities served|zip codes? served|territory|counties/,
    fact("service_area"),
  ],
  [
    /^services?( offered| provided| list)?$|what we do|specialt(y|ies)|offerings?/,
    fact("services"),
  ],
  [/hours|opening times?|availability|schedule/, fact("hours")],
  [/licen[sc]e|insured|insurance|bonded|certification|accreditation/, fact("licenses")],
  [/warrant(y|ies)|guarantees?/, fact("warranties")],
  [/financ|payment plans?|payment options?/, fact("financing")],
  [
    /team|staff|owner|founder|about( us)?|employees|technicians|crew|years in business|established|history/,
    fact("team"),
  ],
  [/brands?|manufacturers?|products? carried|suppliers?/, fact("brands")],
  [/reviews?|ratings?|testimonials?|stars|reputation/, fact("reviews")],
  [
    /differentiators?|usps?|unique selling|why (choose )?us|selling points?|advantages|what sets/,
    fact("differentiators"),
  ],
  [/pric(e|es|ing)|rates?|fees?|cost|discounts?|promotions?|offers?|specials?/, fact("pricing")],
  [/polic(y|ies)|terms|cancellation|refunds?|payment methods?/, fact("policies")],
  [/faqs?|frequently asked/, fact("faq")],
  [/notes?|other|misc|comments?|description|summary/, fact("other")],
];

/**
 * A first guess at the mapping from the column names, for the import screen to show and the
 * person to correct. Columns nothing is known about are set to "ignore". A second column
 * that would map to the same single-valued target (two "Phone" columns) is ignored too.
 */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  for (const header of headers) {
    const name = norm(header);
    const match = SUGGESTIONS.find(([pattern]) => pattern.test(name))?.[1];
    if (match === undefined) {
      mapping[header] = { to: "ignore" };
      continue;
    }
    const single =
      match.to === "profile" ? `profile:${match.field}` : match.to === "fact" ? null : match.to;
    if (single !== null && taken.has(single)) {
      mapping[header] = { to: "ignore" };
      continue;
    }
    if (single !== null) taken.add(single);
    mapping[header] = match;
  }
  return mapping;
}

export interface MappingProblem {
  /** The column the problem is about, or null for a problem of the mapping as a whole. */
  readonly column: string | null;
  readonly message: string;
}

/**
 * Checks a mapping against the columns of a file. `agencyWide`: the file covers several
 * businesses, so every row has to say which one it is for.
 */
export function mappingProblems(
  headers: readonly string[],
  mapping: ColumnMapping,
  options: { readonly agencyWide: boolean },
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const known = new Set(headers);
  const single = new Map<string, string>();
  let facts = 0;
  let hasCategory = false;
  let hasContent = false;
  let hasTitle = false;
  for (const [column, target] of Object.entries(mapping)) {
    if (!known.has(column)) {
      problems.push({ column, message: `The file has no column named "${column.slice(0, 60)}".` });
      continue;
    }
    const key =
      target.to === "profile"
        ? `profile:${target.field}`
        : target.to === "fact" || target.to === "ignore"
          ? null
          : target.to;
    if (key !== null) {
      const other = single.get(key);
      if (other !== undefined) {
        problems.push({
          column,
          message: `"${column.slice(0, 60)}" and "${other.slice(0, 60)}" are mapped to the same field; only one column can fill it.`,
        });
      }
      single.set(key, column);
    }
    if (target.to === "fact") facts += 1;
    if (target.to === "fact_category") hasCategory = true;
    if (target.to === "fact_content") hasContent = true;
    if (target.to === "fact_title") hasTitle = true;
  }
  if ((hasCategory || hasTitle) && !hasContent) {
    problems.push({
      column: null,
      message:
        "A file with a category or title column also needs a column for the text of the fact.",
    });
  }
  if (hasContent && !hasCategory) {
    problems.push({
      column: null,
      message: "A file with one fact per row needs a column for the category of the fact.",
    });
  }
  const profiles = [...single.keys()].some((key) => key.startsWith("profile:"));
  if (facts === 0 && !hasContent && !profiles) {
    problems.push({
      column: null,
      message:
        "No column is mapped to a fact or to the business's profile, so there is nothing to import.",
    });
  }
  if (options.agencyWide && !single.has("external_ref")) {
    problems.push({
      column: null,
      message:
        "A file for several businesses needs a column with each business's reference (its id in your own data).",
    });
  }
  return problems;
}

/** "warranty", "Service Area", "service-area" → the category, or null. */
export function parseCategory(value: string): KnowledgeCategory | null {
  const key = norm(value).replaceAll(" ", "_");
  if ((KNOWLEDGE_CATEGORIES as readonly string[]).includes(key)) return key as KnowledgeCategory;
  const aliases: Readonly<Record<string, KnowledgeCategory>> = {
    service: "services",
    area: "service_area",
    areas_served: "service_area",
    coverage: "service_area",
    opening_hours: "hours",
    license: "licenses",
    licence: "licenses",
    licences: "licenses",
    licensing: "licenses",
    insurance: "licenses",
    warranty: "warranties",
    guarantee: "warranties",
    guarantees: "warranties",
    finance: "financing",
    payment_plans: "financing",
    staff: "team",
    about: "team",
    about_us: "team",
    brand: "brands",
    review: "reviews",
    rating: "reviews",
    ratings: "reviews",
    testimonials: "reviews",
    differentiator: "differentiators",
    usp: "differentiators",
    usps: "differentiators",
    why_us: "differentiators",
    price: "pricing",
    prices: "pricing",
    policy: "policies",
    faqs: "faq",
    misc: "other",
    notes: "other",
  };
  return aliases[key] ?? null;
}
