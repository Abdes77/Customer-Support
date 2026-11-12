import { z } from "zod";

import { type BusinessId, KnowledgeCategory } from "@repo/core";

import { MAX_FACT_CONTENT, MAX_FACT_TITLE } from "../knowledge/items";
import { cleanLine, cleanText, looksLikeInstruction } from "../knowledge/text";
import type { ParsedCsv } from "./csv";
import { type ColumnMapping, parseCategory, type ProfileField } from "./mapping";

/**
 * The canonical shape of imported data, whatever it came in as: one record per business,
 * with optional profile fields and a list of facts. A CSV file is turned into records by
 * `csvToRecords`; the JSON API accepts records directly. Everything is validated here, and
 * every problem names the row (or record) and the field it is in.
 */

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ " +
    "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU"
  ).split(" "),
);

const line = (max: number) =>
  z
    .string()
    .transform(cleanLine)
    .pipe(z.string().max(max, `At most ${max} characters.`));

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Profile fields an import may set. Empty strings mean "not given". */
export const ImportProfile = z
  .strictObject({
    name: line(200).pipe(z.string().min(1, "A name cannot be empty.")),
    websiteUrl: line(500)
      // "example.com" is how people write it; the scheme is added before checking.
      .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
      // A real domain name: not an IP address, not a single-label host.
      .pipe(
        z.url({ protocol: /^https?$/, hostname: z.regexes.domain, error: "Not a web address." }),
      ),
    phone: line(40).refine(
      (value) => {
        const digits = value.replaceAll(/\D/g, "");
        return (
          digits.length >= 10 &&
          digits.length <= 15 &&
          /^[\d\s().+-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value)
        );
      },
      { error: "Not a phone number." },
    ),
    email: line(320).pipe(z.email("Not an email address.")),
    addressLine1: line(200),
    addressLine2: line(200),
    city: line(120),
    state: line(40)
      .transform((value) => value.toUpperCase())
      .refine((value) => US_STATES.has(value), {
        error: "Use the two-letter code of a US state (for example CO).",
      }),
    postalCode: line(20).refine((value) => /^\d{5}(?:-\d{4})?$/.test(value), {
      error: "Not a US ZIP code.",
    }),
    timezone: line(60).refine(isTimeZone, {
      error: "Not a time zone name (for example America/Denver).",
    }),
  })
  .partial();
export type ImportProfile = z.infer<typeof ImportProfile>;

export const PROFILE_PROPERTY: Readonly<Record<ProfileField, keyof ImportProfile>> = {
  name: "name",
  website_url: "websiteUrl",
  phone: "phone",
  email: "email",
  address_line1: "addressLine1",
  address_line2: "addressLine2",
  city: "city",
  state: "state",
  postal_code: "postalCode",
  timezone: "timezone",
};

/**
 * Imported text ends up in the bot's prompt. The engine places it as data whatever it says;
 * a fact that addresses the assistant ("ignore previous instructions") is refused here too,
 * and the row is reported, as the crawler does for web pages.
 */
const NOT_AN_INSTRUCTION = {
  error: "This reads like an instruction to an AI assistant, not a fact about the business.",
} as const;

export const ImportFact = z.strictObject({
  category: KnowledgeCategory,
  title: z
    .string()
    .transform(cleanLine)
    .pipe(
      z
        .string()
        .max(MAX_FACT_TITLE, `A title has at most ${MAX_FACT_TITLE} characters.`)
        .refine((value) => !looksLikeInstruction(value), NOT_AN_INSTRUCTION),
    )
    .default(""),
  content: z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, "A fact needs some text.")
        .max(MAX_FACT_CONTENT, `A fact has at most ${MAX_FACT_CONTENT} characters.`)
        .refine((value) => !looksLikeInstruction(value), NOT_AN_INSTRUCTION),
    ),
});
export type ImportFact = z.infer<typeof ImportFact>;

/** Facts in one record, and in one import altogether. */
export const IMPORT_LIMITS = { factsPerRecord: 300, records: 5000 } as const;

export interface ImportRecord {
  /** Where the record came from: the row of a file, or the index of an API record (from 1). */
  readonly row: number;
  /** The business by its id (API records). Null or absent: see `externalRef`. */
  readonly businessId?: BusinessId | null;
  /** The business's reference in the agency's data. Null: the import is for one business. */
  readonly externalRef: string | null;
  readonly profile: ImportProfile;
  readonly facts: readonly ImportFact[];
}

export interface ImportProblem {
  /** The row of the file (the header is row 1), or the index of the API record (from 1). */
  readonly row: number | null;
  /** The column of the file or the field of the record the problem is in. */
  readonly column: string | null;
  /** One sentence. It names rules, never the content of a cell. */
  readonly message: string;
}

function firstMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Not valid.";
}

/**
 * Turns the rows of a file into records, using the mapping. A row with a problem is left
 * out and reported; the other rows still import.
 */
export function csvToRecords(
  csv: ParsedCsv,
  mapping: ColumnMapping,
): { readonly records: ImportRecord[]; readonly problems: ImportProblem[] } {
  const records: ImportRecord[] = [];
  const problems: ImportProblem[] = [];
  const columns = csv.headers.map((header, index) => ({
    header,
    index,
    target: mapping[header] ?? ({ to: "ignore" } as const),
  }));
  const titleColumn = columns.find((column) => column.target.to === "fact_title");
  const categoryColumn = columns.find((column) => column.target.to === "fact_category");
  const contentColumn = columns.find((column) => column.target.to === "fact_content");

  for (const row of csv.rows) {
    const rowProblems: ImportProblem[] = [];
    const problem = (column: string | null, message: string) =>
      rowProblems.push({ row: row.number, column, message });
    if (row.cells.length > csv.headers.length) {
      const extra = row.cells.slice(csv.headers.length).some((value) => value.trim().length > 0);
      if (extra) {
        problem(
          null,
          `The row has ${row.cells.length} cells but the file has ${csv.headers.length} columns. A comma inside a value needs the value in quotation marks.`,
        );
      }
    }
    const cell = (index: number) => row.cells[index] ?? "";

    let externalRef: string | null = null;
    const profile: Record<string, string> = {};
    const facts: ImportFact[] = [];
    const addFact = (column: string, value: unknown) => {
      const parsed = ImportFact.safeParse(value);
      if (parsed.success) facts.push(parsed.data);
      else problem(column, firstMessage(parsed.error));
    };

    for (const column of columns) {
      const value = cell(column.index);
      const target = column.target;
      if (value.trim().length === 0) continue;
      switch (target.to) {
        case "ignore":
        case "fact_category":
        case "fact_title":
        case "fact_content":
          break;
        case "external_ref": {
          const ref = cleanLine(value);
          if (ref.length > 200) problem(column.header, "A reference has at most 200 characters.");
          else externalRef = ref;
          break;
        }
        case "profile":
          profile[PROFILE_PROPERTY[target.field]] = value;
          break;
        case "fact": {
          const title = target.title ?? column.header;
          if (target.split === undefined) {
            addFact(column.header, { category: target.category, title, content: value });
            break;
          }
          const items = value
            .split(target.split)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          for (const item of items) {
            // The item is its own title: short, and what a person would look for.
            addFact(column.header, {
              category: target.category,
              title: cleanLine(item).slice(0, MAX_FACT_TITLE),
              content: item,
            });
          }
          break;
        }
      }
    }

    if (contentColumn !== undefined) {
      const content = cell(contentColumn.index);
      const rawCategory = categoryColumn === undefined ? "" : cell(categoryColumn.index);
      if (content.trim().length > 0 || rawCategory.trim().length > 0) {
        const category = parseCategory(rawCategory);
        if (category === null) {
          problem(
            categoryColumn?.header ?? null,
            rawCategory.trim().length === 0
              ? "The row has no category."
              : "Not a category. Use one of: services, service_area, hours, licenses, warranties, financing, team, brands, reviews, differentiators, pricing, policies, faq, other.",
          );
        } else {
          addFact(contentColumn.header, {
            category,
            title: titleColumn === undefined ? "" : cell(titleColumn.index),
            content,
          });
        }
      }
    }

    const parsedProfile = ImportProfile.safeParse(profile);
    if (!parsedProfile.success) {
      for (const issue of parsedProfile.error.issues) {
        const property = String(issue.path[0] ?? "");
        const column = columns.find(
          (candidate) =>
            candidate.target.to === "profile" &&
            PROFILE_PROPERTY[candidate.target.field] === property,
        );
        problem(column?.header ?? null, issue.message);
      }
    }
    if (facts.length > IMPORT_LIMITS.factsPerRecord) {
      problem(null, `A row can carry at most ${IMPORT_LIMITS.factsPerRecord} facts.`);
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems);
      continue;
    }
    const profileData = parsedProfile.success ? parsedProfile.data : {};
    if (facts.length === 0 && Object.keys(profileData).length === 0) {
      problems.push({
        row: row.number,
        column: null,
        message: "Nothing to import in this row: every mapped cell is empty.",
      });
      continue;
    }
    records.push({ row: row.number, externalRef, profile: profileData, facts });
  }
  return { records, problems };
}
